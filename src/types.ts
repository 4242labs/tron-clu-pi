/** Everything the driver persists or validates. Nothing here talks to Pi. */

export type ReviewerClass = "code" | "data" | "security";

export interface AcceptanceCriterion {
  /** What must be true, in the author's words — carried into the reviewer's brief. */
  criterion: string;
  /** Shell command whose exit code decides it. Exit 0 = met. */
  verify: string;
}

/** A block file, as authored in the host project. */
export interface Block {
  id: string;
  task: string;
  acceptance: AcceptanceCriterion[];
  reviewerClass: ReviewerClass;
  branch?: string;
}

/** A block as the driver executes it: content frozen at mandate start. */
export interface BlockSnapshot extends Block {
  /** Path the block was read from, for the mid-mandate edit check. */
  path: string;
  /** sha256 of the file bytes at snapshot time. */
  hash: string;
  /** Resolved branch name — the author's, or derived from the id. */
  resolvedBranch: string;
}

export type MergeAuthority = "operator-executes" | "driver-executes-on-approval";
export type MergeStrategy = "merge-commit" | "rebase" | "squash" | "pr";

/** Chosen by the operator at boot, per mandate. */
export interface BootConfig {
  workerModel: string;
  reviewerModel: string;
  defaultReviewerClass: ReviewerClass;
  mergeAuthority: MergeAuthority;
  /** Per-block wall-clock cap. */
  budgetMinutes: number;
  /** Per-block turn cap across all seats. */
  turnCap: number;
  /** Retries per phase before escalation. */
  retryCap: number;
}

/** Written by init into the host project; read at mandate start. */
export interface ProjectGateConfig {
  version: 1;
  /** Gates every block runs, whatever its reviewer class. */
  defaultGates: string[];
  /** Extra gates by reviewer class. */
  classGates: Record<ReviewerClass, string[]>;
  /** Globs whose modification the reviewer is told about explicitly. */
  protectedPaths: string[];
  mergeStrategy: MergeStrategy;
  /** Branch a block lands on. */
  defaultBranch: string;
  /** Per-gate timeout. */
  gateTimeoutSeconds: number;
  /** Absolute path to the `pi` binary seats are spawned with — never bare PATH. */
  piBinary: string;
  /** The Pi version that path reported at init. */
  piVersion: string;
}

export type Phase = "build" | "review" | "merge" | "wrap";
export type PhaseStatus = "started" | "passed" | "failed" | "parked";

export interface GateEvidence {
  blockId: string;
  /** Which acceptance criterion this proves, or "gate" for a project gate. */
  criterion: string;
  command: string;
  exitCode: number;
  /** sha256 of stdout+stderr — the full output never enters driver state. */
  outputDigest: string;
  /** First and last lines, for the audit trail to be readable. */
  outputHead: string;
  durationMs: number;
  at: string;
}

export type Verdict = "APPROVED" | "REJECTED";

export interface ReviewVerdict {
  blockId: string;
  verdict: Verdict;
  evidence: string;
  at: string;
}

export type EscalationKind =
  | "retry-cap"
  | "budget-breach"
  | "gate-non-convergence"
  | "block-file-edited"
  | "merge-not-landed";

/**
 * The effect of an answer. Every field is a limit the operator raised by hand: the driver
 * has no path to any of them on its own, and each is granted once per answer, never standing.
 */
export interface Grant {
  extraBuildAttempts: number;
  budgetExtensions: number;
  /** The block file changed on disk and the operator chose to run the snapshot anyway. */
  ignoreBlockFileEdit: boolean;
  /** The operator asked for the seat to be killed after a wall-clock breach. */
  terminateSeats: boolean;
}

export const emptyGrant = (): Grant => ({
  extraBuildAttempts: 0,
  budgetExtensions: 0,
  ignoreBlockFileEdit: false,
  terminateSeats: false,
});

export interface Escalation {
  itemId: string;
  blockId: string;
  kind: EscalationKind;
  detail: string;
  /** Exactly the choices `/tron-clu answer <item-id> <choice>` accepts. */
  answers: string[];
}

/** The journal. One of these per `pi.appendEntry(CLU_ENTRY, …)`. */
export type JournalEntry =
  | {
      kind: "mandate_started";
      mandateId: string;
      sessionId: string;
      config: BootConfig;
      gates: ProjectGateConfig;
      blocks: BlockSnapshot[];
      at: string;
    }
  | {
      kind: "phase";
      blockId: string;
      phase: Phase;
      status: PhaseStatus;
      attempt: number;
      detail?: string;
      at: string;
    }
  | { kind: "evidence"; evidence: GateEvidence; at: string }
  | { kind: "verdict"; verdict: ReviewVerdict; at: string }
  | { kind: "pending_merge"; blockId: string; branch: string; at: string }
  | { kind: "ruling"; blockId: string; ruling: "approve" | "reject"; reason?: string; at: string }
  | { kind: "escalation"; escalation: Escalation; at: string }
  | { kind: "answer"; itemId: string; choice: string; at: string }
  | {
      kind: "seat";
      blockId: string;
      role: "worker" | "reviewer";
      pid: number;
      startedAt: number;
      at: string;
    }
  | {
      kind: "seat_exit";
      blockId: string;
      pid: number;
      usage?: { turns: number; tokens: number; cost: number };
      at: string;
    }
  | { kind: "mandate_ended"; reason: "complete" | "aborted" | "stopped"; at: string };

export type BlockState =
  | "pending"
  | "building"
  | "reviewing"
  | "awaiting-merge"
  | "merging"
  | "done"
  | "abandoned";

/** Folded from the journal at session start. Never written to directly. */
export interface DriverState {
  mandateId?: string;
  sessionId?: string;
  config?: BootConfig;
  gates?: ProjectGateConfig;
  blocks: BlockSnapshot[];
  blockState: Record<string, BlockState>;
  attempts: Record<string, Record<Phase, number>>;
  verdicts: Record<string, ReviewVerdict>;
  evidence: GateEvidence[];
  pendingMerge?: { blockId: string; branch: string };
  /** What the seats have cost this mandate so far. */
  spend: { turns: number; tokens: number; cost: number };
  /** What the operator's answers granted, per block. Nothing else relaxes a limit. */
  grants: Record<string, Grant>;
  openEscalations: Escalation[];
  liveSeats: { blockId: string; role: string; pid: number; startedAt: number }[];
  ended?: "complete" | "aborted" | "stopped";
}
