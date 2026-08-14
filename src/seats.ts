import type { BlockSnapshot, Verdict } from "./types.ts";

export type SeatRole = "worker" | "reviewer";

export interface WorkerResult {
  status: "DONE" | "BLOCKED";
  evidence: string;
}

export interface ReviewerResult {
  verdict: Verdict;
  evidence: string;
}

export interface SeatContext {
  /** Worktree the seat runs in. */
  cwd: string;
  /** Continuation of a previous turn — a retry keeps the seat's own session. */
  sessionId?: string;
  /** Feedback appended to a retry: the verdict and the failing evidence. */
  feedback?: string;
  signal?: AbortSignal;
  /** Called with the child's pid as soon as it exists, for PID custody. */
  onSpawn?: (pid: number) => void;
}

/** P2 supplies the child-process implementation; P1 drives it with a stub. */
export interface SeatRunner {
  work(block: BlockSnapshot, ctx: SeatContext): Promise<WorkerResult>;
  review(
    block: BlockSnapshot,
    ctx: SeatContext & { protectedPathsTouched: string[] },
  ): Promise<ReviewerResult>;
}

export class SeatOutputError extends Error {}

/**
 * A seat's last word is JSON, and the driver reads only that. Prose around it is ignored;
 * prose *instead* of it is an error, never a pass.
 */
export function parseSeatPayload(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  const candidates = [...fenced.reverse(), text];
  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      // try the next candidate
    }
  }
  throw new SeatOutputError("seat produced no parseable JSON payload");
}

export function validateWorkerResult(raw: unknown): WorkerResult {
  const o = raw as Record<string, unknown>;
  if (o?.status !== "DONE" && o?.status !== "BLOCKED") {
    throw new SeatOutputError('worker payload needs status "DONE" or "BLOCKED"');
  }
  if (typeof o.evidence !== "string" || o.evidence.trim() === "") {
    throw new SeatOutputError("worker payload needs non-empty evidence");
  }
  return { status: o.status, evidence: o.evidence };
}

export function validateReviewerResult(raw: unknown): ReviewerResult {
  const o = raw as Record<string, unknown>;
  if (o?.verdict !== "APPROVED" && o?.verdict !== "REJECTED") {
    throw new SeatOutputError('reviewer payload needs verdict "APPROVED" or "REJECTED"');
  }
  if (typeof o.evidence !== "string" || o.evidence.trim() === "") {
    throw new SeatOutputError("reviewer payload needs non-empty evidence");
  }
  return { verdict: o.verdict, evidence: o.evidence };
}
