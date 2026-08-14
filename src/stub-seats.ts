import type { ReviewerResult, SeatContext, SeatRunner, WorkerResult } from "./seats.ts";

/**
 * P1 drives the whole graph with these; P2 replaces them with child `pi` processes.
 * They exist so the phase loop, the gates and the merge park are testable — and runnable
 * end to end on a toy mandate — before a single model is spawned.
 */
export interface StubScript {
  work?: (
    blockId: string,
    attempt: number,
    ctx: SeatContext,
  ) => WorkerResult | Promise<WorkerResult>;
  review?: (
    blockId: string,
    attempt: number,
    ctx: SeatContext,
  ) => ReviewerResult | Promise<ReviewerResult>;
}

export function stubSeatRunner(script: StubScript = {}): SeatRunner {
  const attempts: Record<string, number> = {};
  return {
    async work(block, ctx) {
      const n = (attempts[`w:${block.id}`] ?? 0) + 1;
      attempts[`w:${block.id}`] = n;
      return (
        script.work?.(block.id, n, ctx) ?? {
          status: "BLOCKED",
          evidence: "stub seat: no worker is wired in this build — P2 supplies the child process",
        }
      );
    },
    async review(block, ctx) {
      const n = (attempts[`r:${block.id}`] ?? 0) + 1;
      attempts[`r:${block.id}`] = n;
      return (
        script.review?.(block.id, n, ctx) ?? {
          verdict: "REJECTED",
          evidence: "stub seat: no reviewer is wired in this build",
        }
      );
    },
  };
}
