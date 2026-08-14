import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const STALE_AFTER_MS = 5 * 60_000;

export interface LockRecord {
  sessionId: string;
  host: string;
  pid: number;
  mandateId: string;
  heartbeat: string;
}

/**
 * One lock per repository, not per worktree: the common dir is shared by every worktree,
 * so a mandate running in one of them blocks a mandate started in another.
 */
export const lockPathFor = (gitCommonDir: string): string =>
  join(dirname(gitCommonDir), ".pi", "tron-clu.lock");

export function readLock(lockPath: string): LockRecord | undefined {
  if (!existsSync(lockPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as LockRecord;
    return typeof parsed?.sessionId === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export const isStale = (lock: LockRecord, at = Date.now()): boolean =>
  at - Date.parse(lock.heartbeat) > STALE_AFTER_MS;

export function writeLock(
  lockPath: string,
  record: Omit<LockRecord, "heartbeat" | "host" | "pid">,
): LockRecord {
  const full: LockRecord = {
    ...record,
    host: hostname(),
    pid: process.pid,
    heartbeat: new Date().toISOString(),
  };
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, `${JSON.stringify(full, null, 2)}\n`);
  return full;
}

/** Refresh in place. A lock taken by someone else is never overwritten by a heartbeat. */
export function touchLock(lockPath: string, sessionId: string): boolean {
  const current = readLock(lockPath);
  if (!current || current.sessionId !== sessionId) return false;
  writeFileSync(
    lockPath,
    `${JSON.stringify({ ...current, heartbeat: new Date().toISOString() }, null, 2)}\n`,
  );
  return true;
}

export const releaseLock = (lockPath: string, sessionId: string): void => {
  const current = readLock(lockPath);
  if (current && current.sessionId !== sessionId) return;
  rmSync(lockPath, { force: true });
};

export type AcquireResult =
  | { ok: true; lock: LockRecord }
  | { ok: false; held: LockRecord; stale: boolean };

export function acquireLock(lockPath: string, sessionId: string, mandateId: string): AcquireResult {
  const held = readLock(lockPath);
  if (held && held.sessionId !== sessionId && !isStale(held))
    return { ok: false, held, stale: false };
  if (held && held.sessionId !== sessionId) return { ok: false, held, stale: true };
  return { ok: true, lock: writeLock(lockPath, { sessionId, mandateId }) };
}

/** `unlock` refuses while the heartbeat is fresh — a live run is never unlocked out from under. */
export function forceUnlock(lockPath: string): { released: boolean; reason?: string } {
  const held = readLock(lockPath);
  if (!held) return { released: false, reason: "no lock held" };
  if (!isStale(held)) {
    return {
      released: false,
      reason: `lock is live (session ${held.sessionId} on ${held.host}, heartbeat ${held.heartbeat})`,
    };
  }
  rmSync(lockPath, { force: true });
  return { released: true };
}
