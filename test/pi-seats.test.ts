import assert from "node:assert/strict";
import { chmodSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { piSeatRunner, runSeat, SeatError, seatArgs, seatSessionId } from "../src/pi-seats.ts";
import type { SeatContext } from "../src/seats.ts";
import type { BlockSnapshot, BootConfig, ProjectGateConfig } from "../src/types.ts";
import { scratch } from "./helpers.ts";

/**
 * A stand-in for `pi` that speaks the JSON-mode stream. It records the argv it was called
 * with, so the seat's flag set is asserted against a real process, not a string.
 */
function fakePi(dir: string): string {
  const path = join(dir, "fake-pi.mjs");
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const assistant = (text, usage) =>
  say({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage } });
const sessionIndex = argv.findIndex((a) => a === "--session" || a === "--session-id");
say({ type: "session", version: 3, id: argv[sessionIndex + 1], cwd: process.cwd() });
const mode = process.env.FAKE_PI_MODE ?? "done";
if (mode === "done") {
  assistant("Ran the criterion.\\n\\n\\u0060\\u0060\\u0060json\\n{\\"status\\":\\"DONE\\",\\"evidence\\":\\"committed it\\"}\\n\\u0060\\u0060\\u0060", { totalTokens: 1200, cost: 0.04 });
} else if (mode === "approve") {
  assistant("Read the diff.\\n\\n\\u0060\\u0060\\u0060json\\n{\\"verdict\\":\\"APPROVED\\",\\"evidence\\":\\"criteria met\\"}\\n\\u0060\\u0060\\u0060", { totalTokens: 800, cost: 0.02 });
} else if (mode === "prose") {
  assistant("I finished the work. It all looks good to me.");
} else if (mode === "crash") {
  process.stderr.write("model provider refused the request\\n");
  process.exit(1);
} else if (mode === "silent") {
  process.exit(0);
} else if (mode === "runaway") {
  for (let i = 0; i < 200; i += 1) assistant("turn " + i, { totalTokens: 10, cost: 0.001 });
  setInterval(() => {}, 1000);
}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

const block: BlockSnapshot = {
  id: "b1",
  task: "do the thing",
  acceptance: [{ criterion: "it exists", verify: "test -f thing.txt" }],
  reviewerClass: "code",
  path: "/blocks/b1.json",
  hash: "h",
  resolvedBranch: "clu/m1-b1",
};

const gates: ProjectGateConfig = {
  version: 1,
  defaultGates: ["npm test"],
  classGates: { code: [], data: [], security: [] },
  protectedPaths: [],
  mergeStrategy: "merge-commit",
  defaultBranch: "main",
  gateTimeoutSeconds: 60,
  piBinary: "/bin/true",
  piVersion: "0.84.1",
};

const config: BootConfig = {
  workerModel: "local/worker",
  reviewerModel: "local/reviewer",
  defaultReviewerClass: "code",
  mergeAuthority: "operator-executes",
  budgetMinutes: 10,
  turnCap: 20,
  retryCap: 1,
};

const setup = (name: string) => {
  const { path, cleanup } = scratch(name);
  const binary = fakePi(path);
  const log = join(path, "argv.log");
  process.env.FAKE_PI_LOG = log;
  const calls = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { argv: string[]; cwd: string });
  return { path, binary, calls, cleanup };
};

const deps = (binary: string) => ({
  piBinary: binary,
  denyExtension: "/pkg/src/seat-deny.ts",
  config,
  gates,
  evidenceFor: () => [],
});

test("the seat's flag set is the one P0 verified, with discovery off", () => {
  const args = seatArgs({
    piBinary: "pi",
    denyExtension: "/pkg/src/seat-deny.ts",
    model: "local/m",
    tools: ["read", "bash"],
    cwd: "/w",
    prompt: "go",
    sessionId: "s1",
    resume: false,
    turnCap: 5,
  });
  assert.deepEqual(args, [
    "-p",
    "--mode",
    "json",
    "-ne",
    "-ns",
    "-e",
    "/pkg/src/seat-deny.ts",
    "--model",
    "local/m",
    "-t",
    "read,bash",
    "--session-id",
    "s1",
    "go",
  ]);
  assert.equal(
    seatArgs({
      piBinary: "pi",
      denyExtension: "/d.ts",
      model: "m",
      tools: ["read"],
      cwd: "/w",
      prompt: "go",
      sessionId: "s1",
      resume: true,
      turnCap: 5,
    }).includes("--session"),
    true,
    "a retry resumes the seat's own session rather than starting a new one",
  );
});

test("a worker seat runs in the block worktree and its payload is read from the stream", async () => {
  const s = setup("seat-work");
  process.env.FAKE_PI_MODE = "done";
  try {
    const ctx: SeatContext = { cwd: s.path };
    const result = await piSeatRunner(deps(s.binary), "m1").work(block, ctx);
    assert.deepEqual(result, { status: "DONE", evidence: "committed it" });

    const [call] = s.calls();
    assert.equal(
      call?.cwd,
      realpathSync(s.path),
      "the seat runs in the block's worktree, not the host's cwd",
    );
    assert.ok(call?.argv.includes("--model"));
    assert.ok(call?.argv.includes("local/worker"), "the worker model, not the reviewer's");
    assert.ok(call?.argv.includes("read,write,edit,bash"), "worker tools");
    assert.ok(call?.argv.includes(seatSessionId("m1", "b1", "worker")));
    assert.ok(call?.argv.at(-1)?.includes("do the thing"), "the prompt is the last argument");
  } finally {
    s.cleanup();
  }
});

test("a reviewer seat gets the reviewer model and no way to write", async () => {
  const s = setup("seat-review");
  process.env.FAKE_PI_MODE = "approve";
  try {
    const result = await piSeatRunner(deps(s.binary), "m1").review(block, {
      cwd: s.path,
      protectedPathsTouched: ["package.json"],
    });
    assert.deepEqual(result, { verdict: "APPROVED", evidence: "criteria met" });
    const [call] = s.calls();
    assert.ok(call?.argv.includes("local/reviewer"));
    assert.ok(call?.argv.includes("read,bash"));
    assert.equal(call?.argv.includes("read,write,edit,bash"), false);
    assert.ok(call?.argv.at(-1)?.includes("package.json"), "the protected path is in the brief");
  } finally {
    s.cleanup();
  }
});

test("the pid is handed to the driver the moment the seat exists, and usage on exit", async () => {
  const s = setup("seat-pid");
  process.env.FAKE_PI_MODE = "done";
  const exits: { pid: number | undefined; tokens: number; cost: number; turns: number }[] = [];
  try {
    const pids: number[] = [];
    await piSeatRunner(
      {
        ...deps(s.binary),
        onExit: (_b, _r, pid, usage) => exits.push({ pid, ...usage }),
      },
      "m1",
    ).work(block, { cwd: s.path, onSpawn: (pid) => pids.push(pid) });
    assert.equal(pids.length, 1);
    assert.ok((pids[0] ?? 0) > 0);
    assert.equal(exits[0]?.pid, pids[0], "custody starts and ends with the same pid");
    assert.equal(exits[0]?.tokens, 1200);
    assert.equal(exits[0]?.turns, 1);
  } finally {
    s.cleanup();
  }
});

test("a retry resumes the seat's session and carries the rejection", async () => {
  const s = setup("seat-retry");
  process.env.FAKE_PI_MODE = "done";
  try {
    const seats = piSeatRunner(deps(s.binary), "m1");
    await seats.work(block, { cwd: s.path });
    await seats.work(block, { cwd: s.path, feedback: "the retry counts wrong" });
    const calls = s.calls();
    assert.equal(
      calls[0]?.argv.includes("--session-id"),
      true,
      "first attempt creates the session",
    );
    assert.equal(calls[1]?.argv.includes("--session"), true, "the retry continues it");
    assert.equal(calls[1]?.argv.includes("--session-id"), false);
    assert.ok(calls[1]?.argv.at(-1)?.includes("the retry counts wrong"));
  } finally {
    s.cleanup();
  }
});

test("prose instead of a payload is a failure, never a pass", async () => {
  const s = setup("seat-prose");
  process.env.FAKE_PI_MODE = "prose";
  try {
    await assert.rejects(
      () => piSeatRunner(deps(s.binary), "m1").work(block, { cwd: s.path }),
      (e: unknown) =>
        e instanceof SeatError && /no parseable JSON payload/.test((e as Error).message),
    );
  } finally {
    s.cleanup();
  }
});

test("a seat that crashes or says nothing is reported with what it left behind", async () => {
  const s = setup("seat-crash");
  try {
    process.env.FAKE_PI_MODE = "crash";
    await assert.rejects(
      () => piSeatRunner(deps(s.binary), "m1").work(block, { cwd: s.path }),
      /model provider refused the request/,
    );
    process.env.FAKE_PI_MODE = "silent";
    await assert.rejects(
      () => piSeatRunner(deps(s.binary), "m1").work(block, { cwd: s.path }),
      /no assistant message/,
    );
  } finally {
    s.cleanup();
  }
});

test("a seat past its turn cap is stopped, and the stop is reported as a failure", async () => {
  const s = setup("seat-cap");
  process.env.FAKE_PI_MODE = "runaway";
  try {
    const run = await runSeat({
      piBinary: s.binary,
      denyExtension: "/d.ts",
      model: "m",
      tools: ["read"],
      cwd: s.path,
      prompt: "go",
      sessionId: "s1",
      resume: false,
      turnCap: 5,
    });
    assert.equal(run.terminated, "turn-cap");
    assert.ok(run.stream.usage.turns > 5);
    await assert.rejects(
      () =>
        piSeatRunner({ ...deps(s.binary), config: { ...config, turnCap: 5 } }, "m1").work(block, {
          cwd: s.path,
        }),
      /turn cap/,
    );
  } finally {
    s.cleanup();
  }
});

test("an abort stops the seat where it stands", async () => {
  const s = setup("seat-abort");
  process.env.FAKE_PI_MODE = "runaway";
  const abort = new AbortController();
  try {
    setTimeout(() => abort.abort(), 150);
    const run = await runSeat({
      piBinary: s.binary,
      denyExtension: "/d.ts",
      model: "m",
      tools: ["read"],
      cwd: s.path,
      prompt: "go",
      sessionId: "s1",
      resume: false,
      turnCap: 1_000,
      signal: abort.signal,
    });
    assert.equal(run.terminated, "aborted");
  } finally {
    s.cleanup();
  }
});

test("a binary that is not there fails loudly rather than silently doing nothing", async () => {
  const s = setup("seat-nobinary");
  try {
    await assert.rejects(
      () => piSeatRunner({ ...deps("/nope/not-pi") }, "m1").work(block, { cwd: s.path }),
      (e: unknown) => e instanceof SeatError && /could not spawn/.test((e as Error).message),
    );
  } finally {
    s.cleanup();
  }
});
