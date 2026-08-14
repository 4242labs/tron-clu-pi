import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fold } from "../src/journal.ts";
import { describeOrphans, isOurSeat, terminateOrphans } from "../src/orphans.ts";
import type { BlockSnapshot, BootConfig, JournalEntry, ProjectGateConfig } from "../src/types.ts";
import { scratch, testHost } from "./helpers.ts";

/** A long-lived process whose command line contains the fake pi path — an orphan seat. */
function orphan(dir: string, name: string): { pid: number; path: string; stop: () => void } {
  const path = join(dir, name);
  writeFileSync(path, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n");
  chmodSync(path, 0o755);
  const child = spawn(path, [], { stdio: "ignore" });
  return { pid: child.pid ?? -1, path, stop: () => child.kill("SIGKILL") };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const settle = async (pid: number) => {
  for (let i = 0; i < 50 && alive(pid); i += 1) await new Promise((r) => setTimeout(r, 20));
};

const block: BlockSnapshot = {
  id: "b1",
  task: "t",
  acceptance: [{ criterion: "c", verify: "true" }],
  reviewerClass: "code",
  path: "/blocks/b1.json",
  hash: "h",
  resolvedBranch: "clu/m1-b1",
};

const started = (): JournalEntry => ({
  kind: "mandate_started",
  mandateId: "m1",
  sessionId: "s1",
  config: {
    workerModel: "w",
    reviewerModel: "r",
    defaultReviewerClass: "code",
    mergeAuthority: "operator-executes",
    budgetMinutes: 5,
    turnCap: 10,
    retryCap: 1,
  } satisfies BootConfig,
  gates: {
    version: 1,
    defaultGates: ["true"],
    classGates: { code: [], data: [], security: [] },
    protectedPaths: [],
    mergeStrategy: "merge-commit",
    defaultBranch: "main",
    gateTimeoutSeconds: 30,
    piBinary: "/bin/true",
    piVersion: "0.84.1",
  } satisfies ProjectGateConfig,
  blocks: [block],
  at: new Date().toISOString(),
});

test("a seat left running by a killed session is terminated on resume", async () => {
  const { path, cleanup } = scratch("orphan");
  const seat = orphan(path, "fake-pi-orphan.mjs");
  try {
    const host = testHost(path);
    host.append(started());
    host.append({
      kind: "seat",
      blockId: "b1",
      role: "worker",
      pid: seat.pid,
      startedAt: Date.now(),
      at: "t",
    });

    assert.equal(await isOurSeat(host, seat.pid, seat.path), true);
    const report = await terminateOrphans(host, fold(host.journal()), seat.path);
    assert.deepEqual(report.terminated, [seat.pid]);
    await settle(seat.pid);
    assert.equal(alive(seat.pid), false, "the orphan is gone — no second writer on the worktree");
    assert.equal(
      fold(host.journal()).liveSeats.length,
      0,
      "state stops claiming a seat that is gone",
    );
    assert.match(describeOrphans(report) ?? "", /terminated 1 seat/);
  } finally {
    seat.stop();
    cleanup();
  }
});

test("a recycled pid is left alone — the driver kills its own seats, not whatever inherited the number", async () => {
  const { path, cleanup } = scratch("orphan-recycled");
  const stranger = orphan(path, "some-other-program.mjs");
  try {
    const host = testHost(path);
    host.append(started());
    host.append({
      kind: "seat",
      blockId: "b1",
      role: "worker",
      pid: stranger.pid,
      startedAt: Date.now(),
      at: "t",
    });

    const report = await terminateOrphans(
      host,
      fold(host.journal()),
      join(path, "fake-pi-orphan.mjs"),
    );
    assert.deepEqual(report.terminated, []);
    assert.equal(report.skipped[0]?.pid, stranger.pid);
    assert.equal(alive(stranger.pid), true, "an unrelated process survives");
    assert.equal(
      fold(host.journal()).liveSeats.length,
      0,
      "but the driver stops claiming it as a seat",
    );
    assert.match(describeOrphans(report) ?? "", /left pid \d+ alone/);
  } finally {
    stranger.stop();
    cleanup();
  }
});

test("a seat that already exited is recorded as gone, not killed", async () => {
  const { path, cleanup } = scratch("orphan-gone");
  const dead = orphan(path, "fake-pi-dead.mjs");
  dead.stop();
  await settle(dead.pid);
  try {
    const host = testHost(path);
    host.append(started());
    host.append({
      kind: "seat",
      blockId: "b1",
      role: "worker",
      pid: dead.pid,
      startedAt: Date.now(),
      at: "t",
    });

    const report = await terminateOrphans(host, fold(host.journal()), dead.path);
    assert.deepEqual(report.alreadyGone, [dead.pid]);
    assert.deepEqual(report.terminated, []);
    assert.equal(fold(host.journal()).liveSeats.length, 0);
  } finally {
    cleanup();
  }
});

test("nothing recorded, nothing said", async () => {
  const { path, cleanup } = scratch("orphan-none");
  try {
    const host = testHost(path);
    host.append(started());
    const report = await terminateOrphans(host, fold(host.journal()), "/bin/pi");
    assert.deepEqual(report, { terminated: [], alreadyGone: [], skipped: [] });
    assert.equal(describeOrphans(report), undefined);
  } finally {
    cleanup();
  }
});

test("seat spend accumulates from the journal", () => {
  const host = testHost(process.cwd());
  host.append(started());
  host.append({ kind: "seat", blockId: "b1", role: "worker", pid: 1, startedAt: 1, at: "t" });
  host.append({
    kind: "seat_exit",
    blockId: "b1",
    pid: 1,
    usage: { turns: 3, tokens: 1200, cost: 0.04 },
    at: "t",
  });
  host.append({
    kind: "seat_exit",
    blockId: "b1",
    pid: 2,
    usage: { turns: 2, tokens: 800, cost: 0.02 },
    at: "t",
  });
  const state = fold(host.journal());
  assert.equal(state.spend.turns, 5);
  assert.equal(state.spend.tokens, 2000);
  assert.ok(Math.abs(state.spend.cost - 0.06) < 1e-9);
});
