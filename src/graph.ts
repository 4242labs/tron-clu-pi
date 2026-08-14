import { existsSync } from "node:fs";
import { blockFileChanged } from "./block.ts";
import { protectedPathsTouched, verifyBlock } from "./gates.ts";
import {
  blockWorktreePath,
  changedFiles,
  hasCommits,
  openPullRequest,
  push,
  syncDefaultBranch,
  verifyLanded,
  worktreeAdd,
  worktreeRemove,
} from "./git.ts";
import type { Host } from "./host.ts";
import { fold, nextBlock, now } from "./journal.ts";
import { terminateOrphans } from "./orphans.ts";
import type { SeatContext, SeatRunner } from "./seats.ts";
import {
  type BlockSnapshot,
  type DriverState,
  type Escalation,
  emptyGrant,
  type GateEvidence,
  type Phase,
} from "./types.ts";

export interface LoopDeps {
  host: Host;
  repo: string;
  seats: SeatRunner;
  /** Aborted by `/tron-clu abort` and by session shutdown. */
  signal: AbortSignal;
  /** Telegram in P4; a no-op until then. */
  notifyOperator?: (text: string) => void;
}

/** Why the loop returned. Every value except "complete" leaves state resumable. */
export type LoopOutcome = "complete" | "parked" | "aborted" | "not-live";

const uid = (): string => Math.random().toString(36).slice(2, 8);

export class PhaseLoop {
  private readonly d: LoopDeps;
  private running = false;

  constructor(deps: LoopDeps) {
    this.d = deps;
  }

  private state(): DriverState {
    return fold(this.d.host.journal());
  }

  private phase(
    blockId: string,
    phase: Phase,
    status: "started" | "passed" | "failed" | "parked",
    detail?: string,
  ) {
    const so_far = this.state().attempts[blockId]?.[phase] ?? 0;
    this.d.host.append({
      kind: "phase",
      blockId,
      phase,
      status,
      attempt: status === "started" ? so_far + 1 : so_far,
      ...(detail ? { detail } : {}),
      at: now(),
    });
  }

  private park(escalation: Escalation): void {
    this.d.host.append({ kind: "escalation", escalation, at: now() });
    this.d.host.setStatus(
      "tron-clu",
      `CLU parked: ${escalation.kind} on ${escalation.blockId} — /tron-clu answer ${escalation.itemId} <${escalation.answers.join("|")}>`,
    );
    this.d.notifyOperator?.(
      `CLU parked on block ${escalation.blockId}: ${escalation.kind}\n${escalation.detail}\nAnswer with: /tron-clu answer ${escalation.itemId} <${escalation.answers.join(" | ")}>`,
    );
  }

  private escalation(
    blockId: string,
    kind: Escalation["kind"],
    detail: string,
    answers: string[],
  ): Escalation {
    return { itemId: `${blockId}-${uid()}`, blockId, kind, detail, answers };
  }

  /**
   * Advance until the mandate finishes, parks on a state only the operator can clear, or
   * is aborted. Re-entrant by design: every resolution command just calls it again, and
   * it re-derives where it is from the journal.
   */
  async run(): Promise<LoopOutcome> {
    if (this.running) return "parked";
    this.running = true;
    try {
      for (;;) {
        if (this.d.signal.aborted) return this.finish("aborted");
        const state = this.state();
        if (!state.mandateId) return "not-live";
        if (state.ended) {
          // `stop-mandate` ends it from the journal, without another entry to write.
          this.d.host.setStatus("tron-clu", undefined);
          return "not-live";
        }
        if (state.openEscalations.length > 0 || state.pendingMerge) return "parked";
        const block = nextBlock(state);
        if (!block) {
          this.d.host.append({ kind: "mandate_ended", reason: "complete", at: now() });
          this.d.host.setStatus("tron-clu", undefined);
          this.d.notifyOperator?.("CLU: mandate complete.");
          return "complete";
        }
        const outcome = await this.advance(block, state);
        if (outcome !== "continue") return outcome === "abort" ? this.finish("aborted") : "parked";
      }
    } finally {
      this.running = false;
    }
  }

  private finish(reason: "aborted" | "stopped"): LoopOutcome {
    this.d.host.append({ kind: "mandate_ended", reason, at: now() });
    this.d.host.setStatus("tron-clu", undefined);
    return "aborted";
  }

  /** One step for one block. Returns "continue" to loop, otherwise the loop stops here. */
  private async advance(
    block: BlockSnapshot,
    state: DriverState,
  ): Promise<"continue" | "park" | "abort"> {
    const gates = state.gates;
    const config = state.config;
    if (!gates || !config) return "park";

    const grant = state.grants[block.id] ?? emptyGrant();

    if (grant.terminateSeats && state.liveSeats.some((s) => s.blockId === block.id)) {
      await terminateOrphans(this.d.host, state, gates.piBinary);
    }

    if (blockFileChanged(block) && !grant.ignoreBlockFileEdit) {
      this.park(
        this.escalation(
          block.id,
          "block-file-edited",
          `${block.path} changed on disk after the mandate started. The driver executes the snapshot, never the edit.`,
          ["continue-with-snapshot", "stop-mandate"],
        ),
      );
      return "park";
    }

    const status = state.blockState[block.id];
    const attempts = state.attempts[block.id] ?? { build: 0, review: 0, merge: 0, wrap: 0 };

    if (status === "awaiting-merge") return "park";

    if (status === "merging") return (await this.merge(block, state)) ? "continue" : "park";

    if (status === "pending" || status === "building" || status === "reviewing") {
      const cap = config.retryCap + 1 + grant.extraBuildAttempts;
      if (attempts.build >= cap) {
        this.park(
          this.escalation(
            block.id,
            "retry-cap",
            `build/review retried ${attempts.build} times against a cap of ${cap - 1}${grant.extraBuildAttempts > 0 ? " (already raised once by you)" : ""}.`,
            ["retry-raised-cap-once", "abandon", "stop-mandate"],
          ),
        );
        return "park";
      }
      return await this.buildAndReview(block, state);
    }

    return "continue";
  }

  private async buildAndReview(
    block: BlockSnapshot,
    state: DriverState,
  ): Promise<"continue" | "park" | "abort"> {
    const config = state.config;
    const gates = state.gates;
    if (!config || !gates) return "park";
    const grant = state.grants[block.id] ?? emptyGrant();
    const deadline = Date.now() + config.budgetMinutes * (1 + grant.budgetExtensions) * 60_000;
    const worktree = blockWorktreePath(this.d.repo, block.id);

    this.phase(block.id, "build", "started");
    if (!existsSync(worktree)) {
      await worktreeAdd(
        this.d.host,
        worktree,
        block.resolvedBranch,
        gates.defaultBranch,
        this.d.repo,
      );
    }

    const previous = state.verdicts[block.id];
    const seatCtx: SeatContext = {
      cwd: worktree,
      signal: this.d.signal,
      ...(previous?.verdict === "REJECTED" ? { feedback: previous.evidence } : {}),
      onSpawn: (pid) =>
        this.d.host.append({
          kind: "seat",
          blockId: block.id,
          role: "worker",
          pid,
          startedAt: Date.now(),
          at: now(),
        }),
    };

    const work = await this.withBudget(block, deadline, () => this.d.seats.work(block, seatCtx));
    if (work.kind === "breach") return "park";
    if (work.kind === "aborted") return "abort";
    if (work.kind === "failed") {
      this.phase(block.id, "build", "failed", work.message);
      return "continue";
    }

    if (work.value.status !== "DONE") {
      this.phase(block.id, "build", "failed", work.value.evidence);
      return "continue";
    }

    if (!(await hasCommits(this.d.host, block.resolvedBranch, gates.defaultBranch, this.d.repo))) {
      this.phase(
        block.id,
        "build",
        "failed",
        "worker reported DONE with nothing committed to the block branch",
      );
      return "continue";
    }
    this.phase(block.id, "build", "passed", work.value.evidence);

    const gateRun = await verifyBlock(this.d.host, block, gates, this.d.repo, this.d.signal);
    if (!gateRun.passed) {
      this.phase(block.id, "build", "failed", failureSummary(gateRun.evidence));
      this.d.host.append({
        kind: "verdict",
        verdict: {
          blockId: block.id,
          verdict: "REJECTED",
          evidence: failureSummary(gateRun.evidence),
          at: now(),
        },
        at: now(),
      });
      return "continue";
    }

    this.phase(block.id, "review", "started");
    const files = await changedFiles(
      this.d.host,
      gates.defaultBranch,
      block.resolvedBranch,
      this.d.repo,
    );
    const review = await this.withBudget(block, deadline, () =>
      this.d.seats.review(block, {
        ...seatCtx,
        protectedPathsTouched: protectedPathsTouched(files, gates.protectedPaths),
        onSpawn: (pid) =>
          this.d.host.append({
            kind: "seat",
            blockId: block.id,
            role: "reviewer",
            pid,
            startedAt: Date.now(),
            at: now(),
          }),
      }),
    );
    if (review.kind === "breach") return "park";
    if (review.kind === "aborted") return "abort";
    if (review.kind === "failed") {
      this.phase(block.id, "review", "failed", review.message);
      return "continue";
    }

    this.d.host.append({
      kind: "verdict",
      verdict: {
        blockId: block.id,
        verdict: review.value.verdict,
        evidence: review.value.evidence,
        at: now(),
      },
      at: now(),
    });

    if (review.value.verdict === "REJECTED") {
      this.phase(block.id, "review", "failed", review.value.evidence);
      return "continue";
    }
    this.phase(block.id, "review", "passed", review.value.evidence);

    // Merge is a parked state, always. Nothing here merges anything.
    this.phase(block.id, "merge", "started");
    await push(this.d.host, block.resolvedBranch, worktree);
    if (gates.mergeStrategy === "pr") {
      const existing = await this.d.host.run(
        "gh",
        ["pr", "view", block.resolvedBranch, "--json", "url"],
        {
          cwd: this.d.repo,
        },
      );
      if (existing.code !== 0) {
        await openPullRequest(
          this.d.host,
          block.resolvedBranch,
          gates.defaultBranch,
          `${block.id}: ${block.task.split("\n")[0]}`,
          `Block \`${block.id}\`, reviewed by CLU.\n\n${review.value.evidence}`,
          this.d.repo,
        );
      }
    }
    this.d.host.append({
      kind: "pending_merge",
      blockId: block.id,
      branch: block.resolvedBranch,
      at: now(),
    });
    this.phase(block.id, "merge", "parked");
    this.d.host.setStatus(
      "tron-clu",
      `CLU: block ${block.id} awaiting your merge — /tron-clu approve ${block.id} | /tron-clu reject ${block.id} <reason>`,
    );
    this.d.notifyOperator?.(
      `CLU: block ${block.id} is reviewed and pushed as ${block.resolvedBranch}. It merges when you say so:\n/tron-clu approve ${block.id}\n/tron-clu reject ${block.id} <reason>`,
    );
    return "park";
  }

  /** Called after an `approve` ruling has been journalled. */
  private async merge(block: BlockSnapshot, state: DriverState): Promise<boolean> {
    const gates = state.gates;
    const config = state.config;
    if (!gates || !config) return false;

    if (config.mergeAuthority === "driver-executes-on-approval") {
      const merged =
        gates.mergeStrategy === "pr" || gates.mergeStrategy === "squash"
          ? await this.d.host.run(
              "gh",
              ["pr", "merge", block.resolvedBranch, mergeFlag(gates.mergeStrategy)],
              {
                cwd: this.d.repo,
              },
            )
          : await this.d.host.run(
              "git",
              ["push", "origin", `${block.resolvedBranch}:${gates.defaultBranch}`],
              {
                cwd: this.d.repo,
              },
            );
      if (merged.code !== 0) {
        this.park(
          this.escalation(
            block.id,
            "merge-not-landed",
            `merge command failed: ${merged.stderr.trim()}`,
            ["retry-merge", "abandon", "stop-mandate"],
          ),
        );
        return false;
      }
    }

    const landing = await this.pollLanding(block, gates.mergeStrategy, gates.defaultBranch);
    if (!landing) {
      this.park(
        this.escalation(
          block.id,
          "merge-not-landed",
          `${block.resolvedBranch} is not reachable from ${gates.defaultBranch} yet. Nothing is assumed landed.`,
          ["recheck", "abandon", "stop-mandate"],
        ),
      );
      return false;
    }

    this.phase(block.id, "merge", "passed", landing);
    this.phase(block.id, "wrap", "started");
    await syncDefaultBranch(this.d.host, gates.defaultBranch, this.d.repo);
    await worktreeRemove(this.d.host, blockWorktreePath(this.d.repo, block.id), this.d.repo).catch(
      () => undefined,
    );
    this.phase(block.id, "wrap", "passed", `branch ${block.resolvedBranch} retained`);
    this.d.host.setStatus("tron-clu", undefined);
    return true;
  }

  private async pollLanding(
    block: BlockSnapshot,
    strategy: string,
    defaultBranch: string,
  ): Promise<string | undefined> {
    let waitMs = 1_000;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (this.d.signal.aborted) return undefined;
      const check = await verifyLanded(
        this.d.host,
        strategy as never,
        block.resolvedBranch,
        defaultBranch,
        this.d.repo,
      );
      if (check.landed) return check.how;
      await sleep(waitMs, this.d.signal);
      waitMs *= 2;
    }
    return undefined;
  }

  /**
   * A hang never gets killed by the driver: the wall-clock breach parks an escalation and
   * the operator decides. The seat keeps running until they say otherwise.
   */
  private async withBudget<T>(
    block: BlockSnapshot,
    deadline: number,
    work: () => Promise<T>,
  ): Promise<Budgeted<T>> {
    const breachEscalation = (detail: string) => {
      this.park(
        this.escalation(block.id, "budget-breach", detail, [
          "terminate-seat",
          "extend-once",
          "abandon",
          "stop-mandate",
        ]),
      );
      return { kind: "breach" } as const;
    };

    const remaining = deadline - Date.now();
    if (remaining <= 0) return breachEscalation("the block's wall-clock budget was already spent");

    let timer: NodeJS.Timeout | undefined;
    const breach = new Promise<{ kind: "breach" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "breach" }), remaining);
    });
    try {
      const result = await Promise.race([
        work().then(
          (value) => ({ kind: "ok", value }) as const,
          (e: unknown) =>
            ({ kind: "failed", message: e instanceof Error ? e.message : String(e) }) as const,
        ),
        breach,
      ]);
      if (result.kind === "breach") {
        return breachEscalation(
          "the seat passed its wall-clock budget without reaching a phase boundary. It has not been killed.",
        );
      }
      if (result.kind === "failed" && this.d.signal.aborted) return { kind: "aborted" };
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

type Budgeted<T> =
  | { kind: "ok"; value: T }
  | { kind: "failed"; message: string }
  | { kind: "breach" }
  | { kind: "aborted" };

const mergeFlag = (strategy: string): string => (strategy === "squash" ? "--squash" : "--merge");

const failureSummary = (evidence: GateEvidence[]): string =>
  evidence
    .filter((e) => e.exitCode !== 0)
    .map((e) => `FAILED (${e.exitCode}) ${e.command}\n${e.outputHead}`)
    .join("\n\n") || "gates failed";

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
