import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readMandate } from "../src/block.ts";
import { blockWorktreePath } from "../src/git.ts";
import { PhaseLoop } from "../src/graph.ts";
import { fold, now } from "../src/journal.ts";
import type { SeatContext } from "../src/seats.ts";
import { type StubScript, stubSeatRunner } from "../src/stub-seats.ts";
import type { BootConfig, JournalEntry, ProjectGateConfig } from "../src/types.ts";
import { fixtureRepo, scratch, type TestHost, testHost } from "./helpers.ts";

const gates = (overrides: Partial<ProjectGateConfig> = {}): ProjectGateConfig => ({
  version: 1,
  defaultGates: ["true"],
  classGates: { code: [], data: [], security: [] },
  protectedPaths: ["package.json"],
  mergeStrategy: "merge-commit",
  defaultBranch: "main",
  gateTimeoutSeconds: 30,
  piBinary: "/bin/true",
  piVersion: "0.84.1",
  ...overrides,
});

const config = (overrides: Partial<BootConfig> = {}): BootConfig => ({
  workerModel: "w",
  reviewerModel: "r",
  defaultReviewerClass: "code",
  mergeAuthority: "driver-executes-on-approval",
  budgetMinutes: 5,
  turnCap: 20,
  retryCap: 1,
  ...overrides,
});

interface Stage {
  host: TestHost;
  repo: string;
  loop: PhaseLoop;
  blocksDir: string;
  cleanup: () => void;
  abort: AbortController;
}

/** A real repo, real block files, real git — everything but the model. */
async function stage(
  name: string,
  script: StubScript,
  opts: {
    blocks?: string[];
    gates?: Partial<ProjectGateConfig>;
    config?: Partial<BootConfig>;
    aborted?: boolean;
  } = {},
): Promise<Stage> {
  const { path, cleanup } = scratch(name);
  const { repo } = await fixtureRepo(path);
  const host = testHost(repo);
  const blocksDir = join(path, "blocks");
  mkdirSync(blocksDir, { recursive: true });

  const ids = opts.blocks ?? ["b1"];
  for (const id of ids) {
    writeFileSync(
      join(blocksDir, `${id}.json`),
      JSON.stringify({
        id,
        task: `create ${id}.txt`,
        reviewerClass: "code",
        acceptance: [{ criterion: `${id}.txt exists`, verify: `test -f ${id}.txt` }],
      }),
    );
  }
  const mandatePath = join(blocksDir, "mandate.json");
  writeFileSync(mandatePath, JSON.stringify(ids.map((id) => `${id}.json`)));

  const entry: JournalEntry = {
    kind: "mandate_started",
    mandateId: "m1",
    sessionId: "test-session",
    config: config(opts.config),
    gates: gates(opts.gates),
    blocks: readMandate(mandatePath, "m1"),
    at: now(),
  };
  host.append(entry);

  const abort = new AbortController();
  if (opts.aborted) abort.abort();
  const loop = new PhaseLoop({ host, repo, seats: stubSeatRunner(script), signal: abort.signal });
  return { host, repo, loop, blocksDir, cleanup, abort };
}

/** What a worker seat does, minus the model: write the file, commit it, report DONE. */
const commitWork =
  (host: TestHost) => async (blockId: string, _attempt: number, ctx: SeatContext) => {
    writeFileSync(join(ctx.cwd, `${blockId}.txt`), `${blockId}\n`);
    await host.run("git", ["add", "-A"], { cwd: ctx.cwd });
    await host.run("git", ["commit", "-m", `${blockId}: work`], { cwd: ctx.cwd });
    return { status: "DONE" as const, evidence: `committed ${blockId}.txt` };
  };

const approve = () => ({ verdict: "APPROVED" as const, evidence: "criteria met, gates green" });

test("end to end: two blocks build, review, park for the operator, then land", async () => {
  const s = await stage("e2e", {}, { blocks: ["b1", "b2"] });
  const runner = { work: commitWork(s.host), review: approve };
  const loop = new PhaseLoop({
    host: s.host,
    repo: s.repo,
    seats: stubSeatRunner(runner),
    signal: s.abort.signal,
  });
  try {
    assert.equal(await loop.run(), "parked", "the merge is a parked state, always");
    let state = fold(s.host.journal());
    assert.deepEqual(state.pendingMerge, { blockId: "b1", branch: "clu/m1-b1" });
    assert.equal(state.blockState.b1, "awaiting-merge");
    assert.equal(state.blockState.b2, "pending", "nothing runs ahead of a parked block");
    assert.equal(state.verdicts.b1?.verdict, "APPROVED");
    assert.ok(
      state.evidence.length >= 2,
      "acceptance criterion and default gate both left evidence",
    );

    s.host.append({ kind: "ruling", blockId: "b1", ruling: "approve", at: now() });
    assert.equal(await loop.run(), "parked", "b1 lands, then b2 parks at its own merge");
    state = fold(s.host.journal());
    assert.equal(state.blockState.b1, "done");
    assert.equal(
      existsSync(blockWorktreePath(s.repo, "b1")),
      false,
      "the block worktree is torn down on wrap",
    );
    assert.deepEqual(state.pendingMerge, { blockId: "b2", branch: "clu/m1-b2" });

    s.host.append({ kind: "ruling", blockId: "b2", ruling: "approve", at: now() });
    assert.equal(await loop.run(), "complete");
    state = fold(s.host.journal());
    assert.equal(state.blockState.b2, "done");
    assert.equal(state.ended, "complete");

    const landed = await s.host.run("git", ["ls-tree", "--name-only", "origin/main"], {
      cwd: s.repo,
    });
    assert.match(landed.stdout, /b1\.txt/);
    assert.match(
      landed.stdout,
      /b2\.txt/,
      "the second block branched from the first block's landing",
    );
  } finally {
    s.cleanup();
  }
});

test("a kill mid-mandate resumes from the journal alone, with the merge still pending", async () => {
  const s = await stage("resume", {}, {});
  try {
    const first = new PhaseLoop({
      host: s.host,
      repo: s.repo,
      seats: stubSeatRunner({ work: commitWork(s.host), review: approve }),
      signal: s.abort.signal,
    });
    assert.equal(await first.run(), "parked");
    const entriesAtKill = s.host.journal();

    // The kill: a brand-new session object, holding nothing but the journal.
    const resumed = testHost(s.repo);
    for (const e of entriesAtKill) resumed.append(e);
    const secondLoop = new PhaseLoop({
      host: resumed,
      repo: s.repo,
      seats: stubSeatRunner({
        work: () => assert.fail("a resume must not re-run a block that is awaiting a merge"),
        review: () => assert.fail("a resume must not re-review a block that is awaiting a merge"),
      }),
      signal: new AbortController().signal,
    });

    assert.equal(await secondLoop.run(), "parked");
    assert.deepEqual(fold(resumed.journal()).pendingMerge, { blockId: "b1", branch: "clu/m1-b1" });
    assert.equal(
      resumed.journal().length,
      entriesAtKill.length,
      "a resume of a parked mandate writes nothing",
    );

    // The operator's ruling is the only thing that moves it.
    resumed.append({ kind: "ruling", blockId: "b1", ruling: "approve", at: now() });
    assert.equal(await secondLoop.run(), "complete");
    assert.equal(fold(resumed.journal()).blockState.b1, "done");
  } finally {
    s.cleanup();
  }
});

test("a rejected merge abandons the block and moves on", async () => {
  const s = await stage("reject", {}, { blocks: ["b1", "b2"] });
  const loop = new PhaseLoop({
    host: s.host,
    repo: s.repo,
    seats: stubSeatRunner({ work: commitWork(s.host), review: approve }),
    signal: s.abort.signal,
  });
  try {
    await loop.run();
    s.host.append({
      kind: "ruling",
      blockId: "b1",
      ruling: "reject",
      reason: "not what I meant",
      at: now(),
    });
    assert.equal(await loop.run(), "parked");
    const state = fold(s.host.journal());
    assert.equal(state.blockState.b1, "abandoned");
    assert.deepEqual(state.pendingMerge, { blockId: "b2", branch: "clu/m1-b2" });
  } finally {
    s.cleanup();
  }
});

test("an abort stops at the safe point and records why", async () => {
  const s = await stage(
    "abort",
    { work: () => assert.fail("no seat runs after an abort") },
    { aborted: true },
  );
  try {
    assert.equal(await s.loop.run(), "aborted");
    const state = fold(s.host.journal());
    assert.equal(state.ended, "aborted");
    assert.equal(
      state.blockState.b1,
      "pending",
      "an aborted block is left where it was, not marked failed",
    );
  } finally {
    s.cleanup();
  }
});

test("a blocked worker retries to the cap, then parks for the operator", async () => {
  const s = await stage(
    "retry",
    { work: () => ({ status: "BLOCKED" as const, evidence: "the API key is missing" }) },
    { config: { retryCap: 1 } },
  );
  try {
    assert.equal(await s.loop.run(), "parked");
    const state = fold(s.host.journal());
    assert.equal(state.attempts.b1?.build, 2, "one attempt plus one retry");
    const parked = state.openEscalations[0];
    assert.equal(parked?.kind, "retry-cap");
    assert.deepEqual(parked?.answers, ["retry-raised-cap-once", "abandon", "stop-mandate"]);
    assert.equal(state.pendingMerge, undefined, "nothing ever reached a merge");
    assert.ok(s.host.status["tron-clu"]?.includes("parked"));
  } finally {
    s.cleanup();
  }
});

test("a worker that reports DONE with nothing committed is not believed", async () => {
  const s = await stage(
    "empty-done",
    { work: () => ({ status: "DONE" as const, evidence: "trust me" }), review: approve },
    { config: { retryCap: 0 } },
  );
  try {
    assert.equal(await s.loop.run(), "parked");
    const failures = s.host
      .journal()
      .filter((e) => e.kind === "phase" && e.status === "failed")
      .map((e) => (e.kind === "phase" ? e.detail : ""));
    assert.ok(
      failures.some((d) => d?.includes("nothing committed")),
      failures.join(" | "),
    );
    assert.equal(fold(s.host.journal()).verdicts.b1, undefined, "no reviewer was ever asked");
  } finally {
    s.cleanup();
  }
});

test("failing gates reject the block before a reviewer is asked", async () => {
  const s = await stage(
    "gates",
    {
      work: commitWorkWrongFile,
      review: () => assert.fail("the reviewer is never reached on failing gates"),
    },
    { config: { retryCap: 0 } },
  );
  try {
    assert.equal(await s.loop.run(), "parked");
    const state = fold(s.host.journal());
    assert.equal(state.verdicts.b1?.verdict, "REJECTED");
    assert.match(state.verdicts.b1?.evidence ?? "", /FAILED \(1\) test -f b1\.txt/);
    assert.equal(state.openEscalations[0]?.kind, "retry-cap");
  } finally {
    s.cleanup();
  }
});

async function commitWorkWrongFile(blockId: string, _attempt: number, ctx: SeatContext) {
  writeFileSync(join(ctx.cwd, "something-else.txt"), "not the file the criterion names\n");
  const { execFile } = await import("node:child_process");
  const run = (args: string[]) =>
    new Promise<void>((resolve) => execFile("git", args, { cwd: ctx.cwd }, () => resolve()));
  await run(["add", "-A"]);
  await run(["commit", "-m", `${blockId}: partial`]);
  return { status: "DONE" as const, evidence: "committed something" };
}

test("a block file edited mid-mandate parks instead of being adopted", async () => {
  const s = await stage("edited", {
    work: () => assert.fail("no seat runs on a block that changed underneath it"),
  });
  try {
    writeFileSync(
      join(s.blocksDir, "b1.json"),
      JSON.stringify({
        id: "b1",
        task: "do something entirely different now",
        reviewerClass: "code",
        acceptance: [{ criterion: "x", verify: "true" }],
      }),
    );
    assert.equal(await s.loop.run(), "parked");
    const parked = fold(s.host.journal()).openEscalations[0];
    assert.equal(parked?.kind, "block-file-edited");
    assert.deepEqual(parked?.answers, ["continue-with-snapshot", "stop-mandate"]);
  } finally {
    s.cleanup();
  }
});

test("a breached budget parks an escalation and leaves the seat running", async () => {
  let seatFinished = false;
  const s = await stage(
    "budget",
    {
      work: async () => {
        await new Promise((r) => setTimeout(r, 1_500));
        seatFinished = true;
        return { status: "DONE" as const, evidence: "slow, but it did finish" };
      },
    },
    { config: { budgetMinutes: 0.01 } }, // 600ms, spent long before the seat returns
  );
  try {
    assert.equal(await s.loop.run(), "parked");
    const parked = fold(s.host.journal()).openEscalations[0];
    assert.equal(parked?.kind, "budget-breach");
    assert.deepEqual(parked?.answers, ["terminate-seat", "extend-once", "abandon", "stop-mandate"]);
    assert.equal(seatFinished, false, "the loop parked without waiting for the seat");
    for (let i = 0; i < 40 && !seatFinished; i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      seatFinished,
      true,
      "the seat was never killed — the operator decides that, not the timer",
    );
  } finally {
    s.cleanup();
  }
});

test("a budget already spent parks before a seat is ever spawned", async () => {
  const s = await stage(
    "budget-spent",
    { work: () => assert.fail("no seat is spawned once the budget is gone") },
    { config: { budgetMinutes: 0 } },
  );
  try {
    assert.equal(await s.loop.run(), "parked");
    assert.equal(fold(s.host.journal()).openEscalations[0]?.kind, "budget-breach");
  } finally {
    s.cleanup();
  }
});

test("an open escalation blocks every further step until it is answered", async () => {
  const s = await stage(
    "parked-blocks",
    { work: () => ({ status: "BLOCKED" as const, evidence: "x" }) },
    {
      blocks: ["b1", "b2"],
      config: { retryCap: 0 },
    },
  );
  try {
    assert.equal(await s.loop.run(), "parked");
    const before = s.host.journal().length;
    assert.equal(await s.loop.run(), "parked", "re-running a parked mandate is a no-op");
    assert.equal(s.host.journal().length, before);
    assert.equal(fold(s.host.journal()).blockState.b2, "pending");
  } finally {
    s.cleanup();
  }
});

test("a loop with no mandate does nothing at all", async () => {
  const { path, cleanup } = scratch("no-mandate");
  try {
    const { repo } = await fixtureRepo(path);
    const host = testHost(repo);
    const loop = new PhaseLoop({
      host,
      repo,
      seats: stubSeatRunner({}),
      signal: new AbortController().signal,
    });
    assert.equal(await loop.run(), "not-live");
    assert.equal(host.journal().length, 0);
  } finally {
    cleanup();
  }
});

test("a raised cap gives the block exactly one more attempt, then parks again", async () => {
  const s = await stage(
    "grant-retry",
    { work: () => ({ status: "BLOCKED" as const, evidence: "still stuck" }) },
    {
      config: { retryCap: 0 },
    },
  );
  try {
    assert.equal(await s.loop.run(), "parked");
    const first = fold(s.host.journal()).openEscalations[0];
    assert.equal(first?.kind, "retry-cap");
    assert.equal(fold(s.host.journal()).attempts.b1?.build, 1);

    s.host.append({
      kind: "answer",
      itemId: first?.itemId ?? "",
      choice: "retry-raised-cap-once",
      at: now(),
    });
    assert.equal(await s.loop.run(), "parked");
    const state = fold(s.host.journal());
    assert.equal(state.attempts.b1?.build, 2, "one more attempt, not unlimited ones");
    assert.equal(state.openEscalations.length, 1, "and it parks again rather than looping");
    assert.notEqual(
      state.openEscalations[0]?.itemId,
      first?.itemId,
      "a fresh item — the old one stays answered",
    );
  } finally {
    s.cleanup();
  }
});

test("abandon moves the mandate on; stop-mandate ends it", async () => {
  const s = await stage(
    "grant-abandon",
    { work: () => ({ status: "BLOCKED" as const, evidence: "x" }) },
    {
      blocks: ["b1", "b2"],
      config: { retryCap: 0 },
    },
  );
  try {
    await s.loop.run();
    const first = fold(s.host.journal()).openEscalations[0];
    s.host.append({ kind: "answer", itemId: first?.itemId ?? "", choice: "abandon", at: now() });

    assert.equal(await s.loop.run(), "parked", "b2 now runs, fails its own cap, and parks");
    let state = fold(s.host.journal());
    assert.equal(state.blockState.b1, "abandoned");
    assert.equal(state.attempts.b2?.build, 1);

    const second = state.openEscalations[0];
    s.host.append({
      kind: "answer",
      itemId: second?.itemId ?? "",
      choice: "stop-mandate",
      at: now(),
    });
    assert.equal(await s.loop.run(), "not-live");
    state = fold(s.host.journal());
    assert.equal(state.ended, "stopped");
    assert.equal(
      state.blockState.b2,
      "building",
      "a stopped block is left where it was, not marked failed",
    );
  } finally {
    s.cleanup();
  }
});

test("continue-with-snapshot runs the frozen block, not the edited file", async () => {
  const s = await stage("grant-snapshot", {}, {});
  const built: string[] = [];
  const loop = new PhaseLoop({
    host: s.host,
    repo: s.repo,
    seats: stubSeatRunner({
      work: async (id, attempt, ctx) => {
        built.push(id);
        return commitWork(s.host)(id, attempt, ctx);
      },
      review: approve,
    }),
    signal: s.abort.signal,
  });
  try {
    writeFileSync(
      join(s.blocksDir, "b1.json"),
      JSON.stringify({
        id: "b1",
        task: "something else entirely",
        reviewerClass: "code",
        acceptance: [{ criterion: "x", verify: "true" }],
      }),
    );
    assert.equal(await loop.run(), "parked");
    const parked = fold(s.host.journal()).openEscalations[0];
    assert.equal(parked?.kind, "block-file-edited");
    assert.deepEqual(built, [], "nothing was built while it was parked");

    s.host.append({
      kind: "answer",
      itemId: parked?.itemId ?? "",
      choice: "continue-with-snapshot",
      at: now(),
    });
    assert.equal(await loop.run(), "parked", "it builds and reaches the merge park");
    const state = fold(s.host.journal());
    assert.deepEqual(built, ["b1"]);
    assert.equal(state.pendingMerge?.blockId, "b1");
    assert.equal(
      state.blocks[0]?.task,
      "create b1.txt",
      "the snapshot ran — the edit never entered state",
    );
  } finally {
    s.cleanup();
  }
});

test("extend-once buys the block a second budget", async () => {
  const s = await stage(
    "grant-extend",
    {
      work: async (id, attempt, ctx) => {
        if (attempt === 1) await new Promise((r) => setTimeout(r, 1_500));
        return commitWork(s.host)(id, attempt, ctx);
      },
      review: approve,
    },
    { config: { budgetMinutes: 0.01, retryCap: 3 } },
  );
  try {
    assert.equal(await s.loop.run(), "parked");
    const parked = fold(s.host.journal()).openEscalations[0];
    assert.equal(parked?.kind, "budget-breach");

    s.host.append({
      kind: "answer",
      itemId: parked?.itemId ?? "",
      choice: "extend-once",
      at: now(),
    });
    assert.equal(await s.loop.run(), "parked");
    const state = fold(s.host.journal());
    assert.equal(state.grants.b1?.budgetExtensions, 1);
    assert.equal(
      state.pendingMerge?.blockId,
      "b1",
      "with the extension the block finished and reached the merge",
    );
  } finally {
    s.cleanup();
  }
});
