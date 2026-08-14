import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { protectedPathsTouched, runGate, verifyBlock } from "../src/gates.ts";
import { verificationWorktreePath } from "../src/git.ts";
import type { BlockSnapshot, ProjectGateConfig } from "../src/types.ts";
import { fixtureRepo, scratch, testHost } from "./helpers.ts";

const gates: ProjectGateConfig = {
  version: 1,
  defaultGates: ["test -f seed.txt"],
  classGates: { code: ["true"], data: [], security: ["false"] },
  protectedPaths: [],
  mergeStrategy: "merge-commit",
  defaultBranch: "main",
  gateTimeoutSeconds: 20,
  piBinary: "/bin/true",
  piVersion: "0.84.1",
};

const block = (
  id: string,
  verify: string,
  reviewerClass: BlockSnapshot["reviewerClass"] = "code",
): BlockSnapshot => ({
  id,
  task: "t",
  acceptance: [{ criterion: "the work landed", verify }],
  reviewerClass,
  path: `/blocks/${id}.json`,
  hash: "h",
  resolvedBranch: `clu/m1-${id}`,
});

test("a gate records its exit code, a digest, and a readable head", async () => {
  const { path, cleanup } = scratch("gate");
  try {
    const host = testHost(path);
    const ok = await runGate(host, "b1", "c", "echo hello", path, 20);
    assert.equal(ok.exitCode, 0);
    assert.match(ok.outputHead, /hello/);
    assert.equal(ok.outputDigest.length, 16, "the full output never enters state — only a digest");

    const bad = await runGate(host, "b1", "c", "echo boom >&2; exit 3", path, 20);
    assert.equal(bad.exitCode, 3);
    assert.match(bad.outputHead, /boom/);
  } finally {
    cleanup();
  }
});

test("a gate that does not finish is a failure, never a pass", async () => {
  const { path, cleanup } = scratch("gate-timeout");
  try {
    const evidence = await runGate(testHost(path), "b1", "c", "sleep 5", path, 1);
    assert.equal(evidence.exitCode, 124);
    assert.match(evidence.outputHead, /TIMEOUT after 1s/);
  } finally {
    cleanup();
  }
});

test("gates run against what was committed, not the worker's dirty worktree", async () => {
  const { path, cleanup } = scratch("gate-verify");
  try {
    const { repo } = await fixtureRepo(path);
    const host = testHost(repo);
    const worktree = join(repo, ".pi", "tron-clu-work", "b1");

    await host.run("git", ["worktree", "add", "-B", "clu/m1-b1", worktree, "main"]);
    writeFileSync(join(worktree, "committed.txt"), "in\n");
    await host.run("git", ["add", "-A"], { cwd: worktree });
    await host.run("git", ["commit", "-m", "b1"], { cwd: worktree });
    // Uncommitted: it exists on the worker's disk and must not reach a gate.
    writeFileSync(join(worktree, "uncommitted.txt"), "out\n");

    const committed = await verifyBlock(host, block("b1", "test -f committed.txt"), gates, repo);
    assert.equal(committed.passed, true);

    const dirty = await verifyBlock(host, block("b1", "test -f uncommitted.txt"), gates, repo);
    assert.equal(dirty.passed, false, "uncommitted work cannot satisfy a criterion");

    assert.equal(
      existsSync(verificationWorktreePath(repo, "b1")),
      false,
      "the verification worktree is always torn down",
    );
    const evidence = host.entries.filter((e) => e.kind === "evidence");
    assert.ok(evidence.length >= 4, "every gate leaves evidence in the journal");
  } finally {
    cleanup();
  }
});

test("class gates run on top of the default gates, and one failure fails the run", async () => {
  const { path, cleanup } = scratch("gate-class");
  try {
    const { repo } = await fixtureRepo(path);
    const host = testHost(repo);
    const worktree = join(repo, ".pi", "tron-clu-work", "b2");
    await host.run("git", ["worktree", "add", "-B", "clu/m1-b2", worktree, "main"]);
    writeFileSync(join(worktree, "x.txt"), "x\n");
    await host.run("git", ["add", "-A"], { cwd: worktree });
    await host.run("git", ["commit", "-m", "b2"], { cwd: worktree });

    const run = await verifyBlock(host, block("b2", "true", "security"), gates, repo);
    assert.equal(run.passed, false, "the security class gate `false` sinks it");
    assert.deepEqual(
      run.evidence.map((e) => e.command),
      ["true", "test -f seed.txt", "false"],
      "acceptance criteria first, then default gates, then class gates",
    );
  } finally {
    cleanup();
  }
});

test("protected paths are matched with * inside a segment and ** across them", () => {
  const files = [
    "src/index.ts",
    "test/graph.test.ts",
    "src/deep/nested/thing.test.ts",
    ".github/workflows/ci.yml",
    "package.json",
    "packages/a/package.json",
  ];
  const patterns = ["test/**", "**/*.test.*", ".github/**", "package.json"];
  assert.deepEqual(protectedPathsTouched(files, patterns), [
    "test/graph.test.ts",
    "src/deep/nested/thing.test.ts",
    ".github/workflows/ci.yml",
    "package.json",
  ]);
  assert.deepEqual(protectedPathsTouched(files, []), []);
  assert.deepEqual(protectedPathsTouched(["src/a.ts"], ["src/*.ts"]), ["src/a.ts"]);
  assert.deepEqual(
    protectedPathsTouched(["src/a/b.ts"], ["src/*.ts"]),
    [],
    "* does not cross a segment",
  );
});
