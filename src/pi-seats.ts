import { spawn } from "node:child_process";
import { REVIEWER_TOOLS, reviewerPrompt, WORKER_TOOLS, workerPrompt } from "./personas.ts";
import {
  parseSeatPayload,
  type ReviewerResult,
  type SeatContext,
  SeatOutputError,
  type SeatRole,
  type SeatRunner,
  validateReviewerResult,
  validateWorkerResult,
  type WorkerResult,
} from "./seats.ts";
import {
  consumeLine,
  drain,
  emptyStream,
  finalMessage,
  type SeatUsage,
  type StreamState,
} from "./stream.ts";
import type { BlockSnapshot, BootConfig, GateEvidence, ProjectGateConfig } from "./types.ts";

export class SeatError extends Error {}

export interface SeatRun {
  stream: StreamState;
  exitCode: number | null;
  /** Set when the driver stopped the seat itself, with why. */
  terminated?: "turn-cap" | "aborted";
  stderr: string;
}

export interface SpawnOptions {
  piBinary: string;
  /** Absolute path to the seat-deny extension, loaded into every seat. */
  denyExtension: string;
  model: string;
  tools: string[];
  cwd: string;
  prompt: string;
  /** New session for a first attempt; resumed for a retry, so the seat keeps its own history. */
  sessionId: string;
  resume: boolean;
  turnCap: number;
  signal?: AbortSignal;
  onSpawn?: (pid: number) => void;
}

/** The flag set P0 verified, plus the isolation levers: no discovered extensions, no skills. */
export function seatArgs(o: SpawnOptions): string[] {
  return [
    "-p",
    "--mode",
    "json",
    "-ne",
    "-ns",
    "-e",
    o.denyExtension,
    "--model",
    o.model,
    "-t",
    o.tools.join(","),
    o.resume ? "--session" : "--session-id",
    o.sessionId,
    o.prompt,
  ];
}

/**
 * One seat, start to exit. The turn cap is enforced here because it is the only place that
 * sees turns as they happen; a wall-clock breach is not — that belongs to the phase loop,
 * which parks it for the operator instead of killing anything.
 */
export function runSeat(o: SpawnOptions): Promise<SeatRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(o.piBinary, seatArgs(o), {
      cwd: o.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PI_OFFLINE: process.env.PI_OFFLINE ?? "" },
    });

    const stream = emptyStream();
    let stderr = "";
    let stdoutRest = "";
    let terminated: SeatRun["terminated"];
    let settled = false;

    const stop = (why: SeatRun["terminated"]) => {
      if (terminated || settled) return;
      terminated = why;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 5_000).unref();
    };

    const onAbort = () => stop("aborted");
    o.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (e) => {
      settled = true;
      o.signal?.removeEventListener("abort", onAbort);
      reject(new SeatError(`could not spawn ${o.piBinary}: ${e.message}`));
    });

    if (child.pid !== undefined) o.onSpawn?.(child.pid);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutRest = drain(stdoutRest + chunk, (line) => {
        consumeLine(stream, line);
        if (stream.usage.turns > o.turnCap) stop("turn-cap");
      });
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });

    child.on("close", (code) => {
      settled = true;
      o.signal?.removeEventListener("abort", onAbort);
      if (stdoutRest.trim() !== "") consumeLine(stream, stdoutRest);
      resolve({ stream, exitCode: code, ...(terminated ? { terminated } : {}), stderr });
    });
  });
}

export interface PiSeatDeps {
  piBinary: string;
  denyExtension: string;
  config: BootConfig;
  gates: ProjectGateConfig;
  /** Gate evidence for the block under review, summarised into the reviewer's brief. */
  evidenceFor: (blockId: string) => GateEvidence[];
  /** Called when a seat exits, with what it cost. */
  onExit?: (blockId: string, role: SeatRole, pid: number | undefined, usage: SeatUsage) => void;
}

const evidenceSummary = (evidence: GateEvidence[]): string =>
  evidence.length === 0
    ? "- (none recorded)"
    : evidence
        .map(
          (e) =>
            `- \`${e.command}\` → exit ${e.exitCode} (${e.criterion === "gate" ? "project gate" : e.criterion})`,
        )
        .join("\n");

/** A seat session id that is stable per block and role, so a retry resumes the same seat. */
export const seatSessionId = (mandateId: string, blockId: string, role: SeatRole): string =>
  `clu-${mandateId}-${blockId}-${role}`;

function readResult<T>(
  run: SeatRun,
  role: SeatRole,
  turnCap: number,
  validate: (raw: unknown) => T,
): T {
  if (run.terminated === "turn-cap") {
    throw new SeatError(
      `${role} seat passed its turn cap of ${turnCap} (${run.stream.usage.turns} turns) and was stopped before it answered`,
    );
  }
  if (run.terminated === "aborted") throw new SeatError(`${role} seat was aborted`);
  const last = finalMessage(run.stream);
  if (last === undefined) {
    throw new SeatError(
      `${role} seat exited ${run.exitCode} with no assistant message${run.stderr.trim() ? `: ${run.stderr.trim().split("\n").at(-1)}` : ""}`,
    );
  }
  try {
    return validate(parseSeatPayload(last));
  } catch (e) {
    if (e instanceof SeatOutputError) throw new SeatError(`${role} seat: ${e.message}`);
    throw e;
  }
}

/** The real seats: child `pi` processes, one per block and role. */
export function piSeatRunner(deps: PiSeatDeps, mandateId: string): SeatRunner {
  const attempts: Record<string, number> = {};

  const run = async <T>(
    block: BlockSnapshot,
    role: SeatRole,
    ctx: SeatContext,
    prompt: string,
    tools: string[],
    model: string,
    validate: (raw: unknown) => T,
  ): Promise<T> => {
    const key = `${role}:${block.id}`;
    const attempt = (attempts[key] ?? 0) + 1;
    attempts[key] = attempt;

    let pid: number | undefined;
    const result = await runSeat({
      piBinary: deps.piBinary,
      denyExtension: deps.denyExtension,
      model,
      tools,
      cwd: ctx.cwd,
      prompt,
      sessionId: ctx.sessionId ?? seatSessionId(mandateId, block.id, role),
      resume: attempt > 1,
      turnCap: deps.config.turnCap,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      onSpawn: (spawned) => {
        pid = spawned;
        ctx.onSpawn?.(spawned);
      },
    });
    deps.onExit?.(block.id, role, pid, result.stream.usage);
    return readResult(result, role, deps.config.turnCap, validate);
  };

  return {
    work: (block, ctx): Promise<WorkerResult> =>
      run(
        block,
        "worker",
        ctx,
        workerPrompt(block, deps.gates, ctx.feedback),
        WORKER_TOOLS,
        deps.config.workerModel,
        validateWorkerResult,
      ),

    review: (block, ctx): Promise<ReviewerResult> =>
      run(
        block,
        "reviewer",
        ctx,
        reviewerPrompt(
          block,
          deps.gates,
          evidenceSummary(deps.evidenceFor(block.id)),
          ctx.protectedPathsTouched,
        ),
        REVIEWER_TOOLS,
        deps.config.reviewerModel,
        validateReviewerResult,
      ),
  };
}
