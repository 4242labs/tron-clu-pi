import { createHash } from "node:crypto";
import { verificationWorktreePath, worktreeAddDetached, worktreeRemove } from "./git.ts";
import type { Host } from "./host.ts";
import { now } from "./journal.ts";
import type { BlockSnapshot, GateEvidence, ProjectGateConfig } from "./types.ts";

const digest = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

const head = (s: string, lines = 8): string =>
  s
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(0, lines)
    .join("\n");

/**
 * One gate command. A timeout is a failure, recorded as one — the driver never treats a
 * command that didn't finish as a command that passed.
 */
export async function runGate(
  host: Host,
  blockId: string,
  criterion: string,
  command: string,
  cwd: string,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<GateEvidence> {
  const started = Date.now();
  const r = await host.run("sh", ["-c", command], {
    cwd,
    timeout: timeoutSeconds * 1000,
    ...(signal ? { signal } : {}),
  });
  const output = `${r.stdout}${r.stderr}`;
  return {
    blockId,
    criterion,
    command,
    exitCode: r.killed ? 124 : r.code,
    outputDigest: digest(output),
    outputHead: head(r.killed ? `TIMEOUT after ${timeoutSeconds}s\n${output}` : output),
    durationMs: Date.now() - started,
    at: now(),
  };
}

export interface GateRun {
  passed: boolean;
  evidence: GateEvidence[];
}

export const gateCommandsFor = (block: BlockSnapshot, gates: ProjectGateConfig): string[] => [
  ...gates.defaultGates,
  ...(gates.classGates[block.reviewerClass] ?? []),
];

/**
 * Gates run in a fresh detached checkout of what the worker actually committed, never in
 * the worker's live worktree — uncommitted work cannot reach a gate.
 */
export async function verifyBlock(
  host: Host,
  block: BlockSnapshot,
  gates: ProjectGateConfig,
  repo: string,
  signal?: AbortSignal,
): Promise<GateRun> {
  const path = verificationWorktreePath(repo, block.id);
  await worktreeRemove(host, path).catch(() => undefined);
  await worktreeAddDetached(host, path, block.resolvedBranch, repo);
  const evidence: GateEvidence[] = [];
  try {
    for (const criterion of block.acceptance) {
      evidence.push(
        await runGate(
          host,
          block.id,
          criterion.criterion,
          criterion.verify,
          path,
          gates.gateTimeoutSeconds,
          signal,
        ),
      );
    }
    for (const command of gateCommandsFor(block, gates)) {
      evidence.push(
        await runGate(host, block.id, "gate", command, path, gates.gateTimeoutSeconds, signal),
      );
    }
  } finally {
    await worktreeRemove(host, path, repo).catch(() => undefined);
  }
  for (const e of evidence) host.append({ kind: "evidence", evidence: e, at: now() });
  return { passed: evidence.every((e) => e.exitCode === 0), evidence };
}

/**
 * Surfaced, not prevented: a worker can commit changes to the very files a gate invokes.
 * The reviewer and the operator are told which protected paths moved.
 */
export const protectedPathsTouched = (files: string[], protectedPaths: string[]): string[] =>
  files.filter((f) => protectedPaths.some((p) => matches(f, p)));

/** Minimal glob: `*` within a segment, `**` across segments. Enough for path patterns. */
function matches(file: string, pattern: string): boolean {
  const rx = pattern
    .split("**")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join(".*");
  return new RegExp(`^${rx}$`).test(file);
}
