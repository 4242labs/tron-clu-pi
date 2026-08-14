import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boundToSession,
  CLU_ENTRY,
  fold,
  isLive,
  journalFrom,
  nextBlock,
  now,
} from "../src/journal.ts";
import type { BlockSnapshot, BootConfig, JournalEntry, ProjectGateConfig } from "../src/types.ts";

const block = (id: string): BlockSnapshot => ({
  id,
  task: `do ${id}`,
  acceptance: [{ criterion: "c", verify: "true" }],
  reviewerClass: "code",
  path: `/blocks/${id}.json`,
  hash: `hash-${id}`,
  resolvedBranch: `clu/m1-${id}`,
});

const config: BootConfig = {
  workerModel: "w",
  reviewerModel: "r",
  defaultReviewerClass: "code",
  mergeAuthority: "operator-executes",
  budgetMinutes: 10,
  turnCap: 20,
  retryCap: 1,
};

const gates: ProjectGateConfig = {
  version: 1,
  defaultGates: ["true"],
  classGates: { code: [], data: [], security: [] },
  protectedPaths: [],
  mergeStrategy: "merge-commit",
  defaultBranch: "main",
  gateTimeoutSeconds: 30,
  piBinary: "/usr/local/bin/pi",
  piVersion: "0.84.1",
};

const started = (blocks: BlockSnapshot[]): JournalEntry => ({
  kind: "mandate_started",
  mandateId: "m1",
  sessionId: "s1",
  config,
  gates,
  blocks,
  at: now(),
});

test("an empty journal folds to nothing live", () => {
  const state = fold([]);
  assert.equal(state.mandateId, undefined);
  assert.equal(isLive(state), false);
  assert.equal(nextBlock(state), undefined);
});

test("fold tracks attempts, verdicts and block state", () => {
  const state = fold([
    started([block("a"), block("b")]),
    { kind: "phase", blockId: "a", phase: "build", status: "started", attempt: 1, at: now() },
    { kind: "phase", blockId: "a", phase: "build", status: "failed", attempt: 1, at: now() },
    { kind: "phase", blockId: "a", phase: "build", status: "started", attempt: 2, at: now() },
    { kind: "phase", blockId: "a", phase: "build", status: "passed", attempt: 2, at: now() },
    { kind: "phase", blockId: "a", phase: "review", status: "started", attempt: 1, at: now() },
    {
      kind: "verdict",
      verdict: { blockId: "a", verdict: "APPROVED", evidence: "ok", at: now() },
      at: now(),
    },
  ]);
  assert.equal(state.attempts.a?.build, 2);
  assert.equal(state.attempts.a?.review, 1);
  assert.equal(state.blockState.a, "reviewing");
  assert.equal(state.blockState.b, "pending");
  assert.equal(state.verdicts.a?.verdict, "APPROVED");
  assert.equal(nextBlock(state)?.id, "a");
});

test("kill/resume with a merge pending resurrects the pending state", () => {
  const entries: JournalEntry[] = [
    started([block("a"), block("b")]),
    { kind: "phase", blockId: "a", phase: "build", status: "started", attempt: 1, at: now() },
    { kind: "phase", blockId: "a", phase: "build", status: "passed", attempt: 1, at: now() },
    { kind: "phase", blockId: "a", phase: "review", status: "started", attempt: 1, at: now() },
    { kind: "phase", blockId: "a", phase: "review", status: "passed", attempt: 1, at: now() },
    { kind: "phase", blockId: "a", phase: "merge", status: "started", attempt: 1, at: now() },
    { kind: "pending_merge", blockId: "a", branch: "clu/m1-a", at: now() },
    { kind: "phase", blockId: "a", phase: "merge", status: "parked", attempt: 1, at: now() },
  ];

  // The kill: nothing is carried over but the entries themselves.
  const resumed = fold(entries);
  assert.deepEqual(resumed.pendingMerge, { blockId: "a", branch: "clu/m1-a" });
  assert.equal(resumed.blockState.a, "awaiting-merge");
  assert.equal(isLive(resumed), true, "a killed session leaves the mandate live and resumable");
  assert.equal(
    nextBlock(resumed)?.id,
    "a",
    "the pending block is still the next one — b never jumps the queue",
  );

  // The operator's ruling is what clears it, and only after the fact.
  const approved = fold([
    ...entries,
    { kind: "ruling", blockId: "a", ruling: "approve", at: now() },
  ]);
  assert.equal(approved.pendingMerge, undefined);
  assert.equal(approved.blockState.a, "merging");

  const rejected = fold([
    ...entries,
    { kind: "ruling", blockId: "a", ruling: "reject", reason: "no", at: now() },
  ]);
  assert.equal(rejected.pendingMerge, undefined);
  assert.equal(rejected.blockState.a, "abandoned");
  assert.equal(nextBlock(rejected)?.id, "b");
});

test("escalations park until answered, by item id", () => {
  const base: JournalEntry[] = [
    started([block("a")]),
    {
      kind: "escalation",
      escalation: {
        itemId: "a-1",
        blockId: "a",
        kind: "retry-cap",
        detail: "d",
        answers: ["abandon"],
      },
      at: now(),
    },
    {
      kind: "escalation",
      escalation: {
        itemId: "a-2",
        blockId: "a",
        kind: "budget-breach",
        detail: "d",
        answers: ["extend-once"],
      },
      at: now(),
    },
  ];
  assert.equal(fold(base).openEscalations.length, 2);
  const answered = fold([...base, { kind: "answer", itemId: "a-1", choice: "abandon", at: now() }]);
  assert.deepEqual(
    answered.openEscalations.map((e) => e.itemId),
    ["a-2"],
  );
});

test("seat custody: live seats appear and clear on exit", () => {
  const state = fold([
    started([block("a")]),
    { kind: "seat", blockId: "a", role: "worker", pid: 111, startedAt: 1, at: now() },
    { kind: "seat", blockId: "a", role: "reviewer", pid: 222, startedAt: 2, at: now() },
    { kind: "seat_exit", blockId: "a", pid: 111, at: now() },
  ]);
  assert.deepEqual(
    state.liveSeats.map((s) => s.pid),
    [222],
  );
});

test("a wrap decides done or abandoned, and ending stops the mandate", () => {
  const done = fold([
    started([block("a")]),
    { kind: "phase", blockId: "a", phase: "wrap", status: "passed", attempt: 1, at: now() },
  ]);
  assert.equal(done.blockState.a, "done");
  assert.equal(nextBlock(done), undefined);

  const ended = fold([
    ...[started([block("a")])],
    { kind: "mandate_ended", reason: "aborted", at: now() },
  ]);
  assert.equal(ended.ended, "aborted");
  assert.equal(isLive(ended), false);
});

test("a mandate is bound to the session that started it", () => {
  const state = fold([started([block("a")])]);
  assert.equal(boundToSession(state, "s1"), true);
  assert.equal(boundToSession(state, "s2"), false);
  assert.equal(boundToSession(state, undefined), false);
  assert.equal(boundToSession(fold([]), undefined), false, "no mandate is not a match");
});

test("journalFrom takes only this driver's entries, in order", () => {
  const raw = [
    { type: "message", content: "hi" },
    { type: "custom", customType: "other-ext", data: { kind: "phase" } },
    {
      type: "custom",
      customType: CLU_ENTRY,
      data: { kind: "mandate_ended", reason: "complete", at: now() },
    },
    { type: "custom", customType: CLU_ENTRY, data: "not an object" },
    { type: "custom", customType: CLU_ENTRY },
  ];
  const out = journalFrom(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.kind, "mandate_ended");
});
