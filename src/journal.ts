import {
  type BlockState,
  type DriverState,
  type Escalation,
  emptyGrant,
  type JournalEntry,
  type Phase,
} from "./types.ts";

/** The customType every driver entry carries. Custom entries never enter LLM context. */
export const CLU_ENTRY = "tron-clu";

export const now = (): string => new Date().toISOString();

export const emptyState = (): DriverState => ({
  blocks: [],
  blockState: {},
  attempts: {},
  verdicts: {},
  evidence: [],
  openEscalations: [],
  liveSeats: [],
  spend: { turns: 0, tokens: 0, cost: 0 },
  grants: {},
});

/**
 * What an answer does. The choices are the ones the escalation offered — an answer the
 * escalation did not offer never reaches here, and one that reaches here is applied exactly
 * once, to one block.
 */
const applyAnswer = (state: DriverState, escalation: Escalation, choice: string): void => {
  const grant = state.grants[escalation.blockId] ?? emptyGrant();
  state.grants[escalation.blockId] = grant;
  switch (choice) {
    case "abandon":
      state.blockState[escalation.blockId] = "abandoned";
      break;
    case "stop-mandate":
      state.ended = "stopped";
      break;
    case "retry-raised-cap-once":
      grant.extraBuildAttempts += 1;
      break;
    case "extend-once":
      grant.budgetExtensions += 1;
      break;
    case "continue-with-snapshot":
      grant.ignoreBlockFileEdit = true;
      break;
    case "terminate-seat":
      grant.terminateSeats = true;
      break;
    // "recheck" and "retry-merge" need no grant: the block is already in `merging`, and
    // clearing the escalation is enough for the loop to try the landing check again.
  }
};

const bumpAttempt = (state: DriverState, blockId: string, phase: Phase) => {
  state.attempts[blockId] ??= { build: 0, review: 0, merge: 0, wrap: 0 };
  const perBlock = state.attempts[blockId];
  perBlock[phase] += 1;
};

const setBlock = (state: DriverState, blockId: string, value: BlockState) => {
  state.blockState[blockId] = value;
};

/**
 * Fold the journal into current state. This is the only way state is ever derived —
 * a resume after a kill runs the exact same fold over the exact same entries.
 */
export function fold(entries: JournalEntry[]): DriverState {
  const state = emptyState();
  const raised = new Map<string, Escalation>();
  for (const e of entries) {
    switch (e.kind) {
      case "mandate_started":
        state.mandateId = e.mandateId;
        state.sessionId = e.sessionId;
        state.config = e.config;
        state.gates = e.gates;
        state.blocks = e.blocks;
        state.ended = undefined;
        for (const b of e.blocks) setBlock(state, b.id, "pending");
        break;
      case "phase":
        if (e.status === "started") {
          bumpAttempt(state, e.blockId, e.phase);
          if (e.phase === "build") setBlock(state, e.blockId, "building");
          if (e.phase === "review") setBlock(state, e.blockId, "reviewing");
          if (e.phase === "merge") setBlock(state, e.blockId, "merging");
        }
        if (e.phase === "wrap" && e.status === "passed") setBlock(state, e.blockId, "done");
        if (e.phase === "wrap" && e.status === "failed") setBlock(state, e.blockId, "abandoned");
        break;
      case "evidence":
        state.evidence.push(e.evidence);
        break;
      case "verdict":
        state.verdicts[e.verdict.blockId] = e.verdict;
        break;
      case "pending_merge":
        state.pendingMerge = { blockId: e.blockId, branch: e.branch };
        setBlock(state, e.blockId, "awaiting-merge");
        break;
      case "ruling":
        if (state.pendingMerge?.blockId === e.blockId) state.pendingMerge = undefined;
        setBlock(state, e.blockId, e.ruling === "approve" ? "merging" : "abandoned");
        break;
      case "escalation":
        state.openEscalations.push(e.escalation);
        raised.set(e.escalation.itemId, e.escalation);
        break;
      case "answer": {
        state.openEscalations = state.openEscalations.filter((x) => x.itemId !== e.itemId);
        const escalation = raised.get(e.itemId);
        if (escalation?.answers.includes(e.choice)) applyAnswer(state, escalation, e.choice);
        break;
      }
      case "seat":
        state.liveSeats.push({
          blockId: e.blockId,
          role: e.role,
          pid: e.pid,
          startedAt: e.startedAt,
        });
        break;
      case "seat_exit":
        state.liveSeats = state.liveSeats.filter((s) => s.pid !== e.pid);
        if (e.usage) {
          state.spend.turns += e.usage.turns;
          state.spend.tokens += e.usage.tokens;
          state.spend.cost += e.usage.cost;
        }
        break;
      case "mandate_ended":
        state.ended = e.reason;
        break;
    }
  }
  return state;
}

/** Pull the driver's own entries out of a raw session entry list, in order. */
export function journalFrom(entries: readonly unknown[]): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (const raw of entries) {
    const e = raw as { type?: string; customType?: string; data?: unknown };
    if (e.type !== "custom" || e.customType !== CLU_ENTRY) continue;
    const data = e.data as JournalEntry | undefined;
    if (data && typeof data === "object" && typeof data.kind === "string") out.push(data);
  }
  return out;
}

/** A mandate belongs to the session that started it; a fork sees state and refuses to run it. */
export const boundToSession = (state: DriverState, sessionId: string | undefined): boolean =>
  state.sessionId !== undefined && state.sessionId === sessionId;

export const isLive = (state: DriverState): boolean =>
  state.mandateId !== undefined && state.ended === undefined;

export const nextBlock = (state: DriverState) =>
  state.blocks.find((b) => {
    const s = state.blockState[b.id];
    return s !== "done" && s !== "abandoned";
  });
