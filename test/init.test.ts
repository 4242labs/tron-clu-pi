import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadGateConfig } from "../src/config.ts";
import type { Host, RunResult } from "../src/host.ts";
import { InitError, initProject, resolvePiBinary } from "../src/init.ts";
import type { JournalEntry } from "../src/types.ts";
import { scratch } from "./helpers.ts";

const ok = (stdout = ""): RunResult => ({ stdout, stderr: "", code: 0, killed: false });
const fail = (stderr = "", code = 1): RunResult => ({ stdout: "", stderr, code, killed: false });

/** Init only ever asks the environment questions; a scripted host answers them. */
function fakeHost(answers: (command: string, args: string[]) => RunResult, cwd: string): Host {
  const entries: JournalEntry[] = [];
  return {
    cwd,
    mode: "tui",
    sessionId: () => "s1",
    run: async (command, args) => answers(command, args),
    append: (e) => void entries.push(e),
    journal: () => entries,
    notify: () => undefined,
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
}

const environment = (cwd: string, overrides: Partial<Record<string, RunResult>> = {}) =>
  fakeHost((command, args) => {
    const line = [command, ...args].join(" ");
    if (line === "sh -c command -v pi") return overrides.which ?? ok("/opt/homebrew/bin/pi\n");
    if (line === "/opt/homebrew/bin/pi --version") return overrides.version ?? ok("0.84.1\n");
    if (command === "gh") return overrides.gh ?? ok("gh version 2.0.0");
    if (line === "sh -c true") return ok();
    return fail(`unexpected command: ${line}`);
  }, cwd);

test("init records the resolved pi binary rather than trusting PATH at spawn time", async () => {
  const { path, cleanup } = scratch("init-pi");
  try {
    const pi = await resolvePiBinary(environment(path));
    assert.equal(pi.path, "/opt/homebrew/bin/pi");
    assert.equal(pi.version, "0.84.1");
  } finally {
    cleanup();
  }
});

test("no pi on PATH, or a pi that will not report its version, stops init", async () => {
  const { path, cleanup } = scratch("init-nopi");
  try {
    await assert.rejects(
      () => resolvePiBinary(environment(path, { which: fail("", 127) })),
      /not on PATH/,
    );
    await assert.rejects(
      () => resolvePiBinary(environment(path, { version: fail("boom") })),
      /--version failed: boom/,
    );
  } finally {
    cleanup();
  }
});

test("init writes a config, protects the gates' own inputs, and ignores the driver's scratch", async () => {
  const { path, cleanup } = scratch("init");
  try {
    const report = await initProject(environment(path), {
      repo: path,
      defaultBranch: "main",
      mergeStrategy: "pr",
      defaultGates: ["npm test", "npm run lint"],
    });

    const config = loadGateConfig(path);
    assert.deepEqual(config.defaultGates, ["npm test", "npm run lint"]);
    assert.equal(config.piBinary, "/opt/homebrew/bin/pi");
    assert.equal(config.gateTimeoutSeconds, 600);
    for (const p of ["test/**", "**/*.test.*", ".github/**", "package.json", ".pi/**"]) {
      assert.ok(config.protectedPaths.includes(p), `${p} must be protected — gates read it`);
    }

    assert.equal(report.gitignoreUpdated, true);
    const gitignore = readFileSync(join(path, ".gitignore"), "utf8");
    for (const line of [".pi/tron-clu.lock", ".pi/tron-clu-work/", ".pi/tron-clu-verify/"]) {
      assert.ok(gitignore.includes(line), `${line} must be ignored`);
    }
    assert.ok(report.notes.some((n) => n.includes("/opt/homebrew/bin/pi")));

    // Re-running is idempotent: the same lines are not appended twice.
    const second = await initProject(environment(path), {
      repo: path,
      defaultBranch: "main",
      mergeStrategy: "pr",
      defaultGates: ["npm test"],
    });
    assert.equal(second.gitignoreUpdated, false);
    assert.equal(readFileSync(join(path, ".gitignore"), "utf8"), gitignore);
  } finally {
    cleanup();
  }
});

test("init refuses a project with no gates, and a pr strategy with no gh", async () => {
  const { path, cleanup } = scratch("init-refuse");
  try {
    await assert.rejects(
      () =>
        initProject(environment(path), {
          repo: path,
          defaultBranch: "main",
          mergeStrategy: "merge-commit",
          defaultGates: [],
        }),
      /fail-open does not exist/,
    );
    await assert.rejects(
      () =>
        initProject(environment(path, { gh: fail("not found", 127) }), {
          repo: path,
          defaultBranch: "main",
          mergeStrategy: "squash",
          defaultGates: ["npm test"],
        }),
      (e: unknown) => e instanceof InitError && /needs the gh CLI/.test((e as Error).message),
    );
  } finally {
    cleanup();
  }
});

test("an existing .gitignore keeps its content and gains a newline before the block", async () => {
  const { path, cleanup } = scratch("init-gitignore");
  try {
    writeFileSync(join(path, ".gitignore"), "node_modules/");
    await initProject(environment(path), {
      repo: path,
      defaultBranch: "main",
      mergeStrategy: "merge-commit",
      defaultGates: ["npm test"],
    });
    const lines = readFileSync(join(path, ".gitignore"), "utf8").split("\n");
    assert.equal(lines[0], "node_modules/");
    assert.ok(lines.includes(".pi/tron-clu.lock"));
  } finally {
    cleanup();
  }
});
