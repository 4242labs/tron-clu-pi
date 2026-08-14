import assert from "node:assert/strict";
import { test } from "node:test";
import { fold, now } from "../src/journal.ts";
import type {
  BlockSnapshot,
  BootConfig,
  Escalation,
  JournalEntry,
  ProjectGateConfig,
} from "../src/types.ts";

const block = (id: string): BlockSnapshot => ({
  id,
  task: `do ${id}`,
  acceptance: [{ criterion: "c", verify: "true" }],
  reviewerClass: "code",
  path: `/blocks/${id}.json`,
  hash: "h",
  resolvedBranch: `clu/m1-${id}`,
});

const started = (ids: string[]): JournalEntry => ({
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
  blocks: ids.map(block),
  at: now(),
});

const park = (escalation: Escalation): JournalEntry => ({
  kind: "escalation",
  escalation,
  at: now(),
});
const answer = (itemId: string, choice: string): JournalEntry => ({
  kind: "answer",
  itemId,
  choice,
  at: now(),
});

const retryCap = (blockId: string, itemId: string): Escalation => ({
  itemId,
  blockId,
  kind: "retry-cap",
  detail: "d",
  answers: ["retry-raised-cap-once", "abandon", "stop-mandate"],
});

const budget = (blockId: string, itemId: string): Escalation => ({
  itemId,
  blockId,
  kind: "budget-breach",
  detail: "d",
  answers: ["terminate-seat", "extend-once", "abandon", "stop-mandate"],
});

test("an unanswered escalation grants nothing", () => {
  const state = fold([started(["b1"]), park(retryCap("b1", "i1"))]);
  assert.equal(state.openEscalations.length, 1);
  assert.equal(state.grants.b1, undefined);
});

test("retry-raised-cap-once raises the cap by exactly one, per answer", () => {
  let state = fold([
    started(["b1"]),
    park(retryCap("b1", "i1")),
    answer("i1", "retry-raised-cap-once"),
  ]);
  assert.equal(state.grants.b1?.extraBuildAttempts, 1);
  assert.equal(state.openEscalations.length, 0);

  state = fold([
    started(["b1"]),
    park(retryCap("b1", "i1")),
    answer("i1", "retry-raised-cap-once"),
    park(retryCap("b1", "i2")),
    answer("i2", "retry-raised-cap-once"),
  ]);
  assert.equal(
    state.grants.b1?.extraBuildAttempts,
    2,
    "the operator can raise it again — the driver never can",
  );
});

test("abandon ends that block and only that block", () => {
  const state = fold([started(["b1", "b2"]), park(retryCap("b1", "i1")), answer("i1", "abandon")]);
  assert.equal(state.blockState.b1, "abandoned");
  assert.equal(state.blockState.b2, "pending");
  assert.equal(state.ended, undefined);
});

test("stop-mandate ends the mandate without another entry", () => {
  const state = fold([
    started(["b1", "b2"]),
    park(retryCap("b1", "i1")),
    answer("i1", "stop-mandate"),
  ]);
  assert.equal(state.ended, "stopped");
});

test("extend-once extends the budget once, and terminate-seat asks for the kill the timer refused", () => {
  const extended = fold([started(["b1"]), park(budget("b1", "i1")), answer("i1", "extend-once")]);
  assert.equal(extended.grants.b1?.budgetExtensions, 1);
  assert.equal(extended.grants.b1?.terminateSeats, false);

  const killed = fold([started(["b1"]), park(budget("b1", "i1")), answer("i1", "terminate-seat")]);
  assert.equal(killed.grants.b1?.terminateSeats, true);
  assert.equal(killed.grants.b1?.budgetExtensions, 0);
});

test("continue-with-snapshot accepts the frozen block, never the edit", () => {
  const state = fold([
    started(["b1"]),
    park({
      itemId: "i1",
      blockId: "b1",
      kind: "block-file-edited",
      detail: "d",
      answers: ["continue-with-snapshot", "stop-mandate"],
    }),
    answer("i1", "continue-with-snapshot"),
  ]);
  assert.equal(state.grants.b1?.ignoreBlockFileEdit, true);
  assert.equal(
    state.blocks[0]?.task,
    "do b1",
    "the snapshot is what runs, whatever the file now says",
  );
});

test("recheck and retry-merge clear the park and grant nothing else", () => {
  const notLanded: Escalation = {
    itemId: "i1",
    blockId: "b1",
    kind: "merge-not-landed",
    detail: "d",
    answers: ["recheck", "retry-merge", "abandon", "stop-mandate"],
  };
  for (const choice of ["recheck", "retry-merge"]) {
    const state = fold([started(["b1"]), park(notLanded), answer("i1", choice)]);
    assert.equal(state.openEscalations.length, 0, choice);
    assert.deepEqual(
      state.grants.b1,
      {
        extraBuildAttempts: 0,
        budgetExtensions: 0,
        ignoreBlockFileEdit: false,
        terminateSeats: false,
      },
      `${choice} raises no limit`,
    );
  }
});

test("an answer the escalation did not offer clears nothing and grants nothing", () => {
  const state = fold([started(["b1"]), park(retryCap("b1", "i1")), answer("i1", "terminate-seat")]);
  assert.equal(
    state.grants.b1?.terminateSeats ?? false,
    false,
    "a choice from another escalation's list is not a choice",
  );
  assert.equal(
    state.openEscalations.length,
    0,
    "the item is closed either way — the command validated it first",
  );
});

test("an answer to an item that was never raised does nothing at all", () => {
  const state = fold([started(["b1"]), answer("ghost", "abandon")]);
  assert.equal(state.blockState.b1, "pending");
  assert.deepEqual(state.grants, {});
});

test("grants are per block", () => {
  const state = fold([
    started(["b1", "b2"]),
    park(retryCap("b1", "i1")),
    answer("i1", "retry-raised-cap-once"),
    park(budget("b2", "i2")),
    answer("i2", "extend-once"),
  ]);
  assert.equal(state.grants.b1?.extraBuildAttempts, 1);
  assert.equal(state.grants.b1?.budgetExtensions, 0);
  assert.equal(state.grants.b2?.budgetExtensions, 1);
  assert.equal(state.grants.b2?.extraBuildAttempts, 0);
});

test("a resume replays the same answers to the same grants", () => {
  const entries = [
    started(["b1"]),
    park(retryCap("b1", "i1")),
    answer("i1", "retry-raised-cap-once"),
  ];
  assert.deepEqual(fold(entries).grants, fold([...entries]).grants);
});
