import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  acquireLock,
  forceUnlock,
  isStale,
  lockPathFor,
  readLock,
  releaseLock,
  STALE_AFTER_MS,
  touchLock,
} from "../src/lock.ts";
import { scratch } from "./helpers.ts";

const age = (lockPath: string, ms: number) => {
  const lock = readLock(lockPath);
  assert.ok(lock);
  writeFileSync(
    lockPath,
    JSON.stringify({ ...lock, heartbeat: new Date(Date.now() - ms).toISOString() }, null, 2),
  );
};

test("the lock lives beside the common dir, so every worktree shares it", () => {
  assert.equal(lockPathFor("/repo/.git"), join("/repo", ".pi", "tron-clu.lock"));
  assert.equal(
    lockPathFor("/repo/.git/worktrees/x/../.."),
    join("/repo/.git/worktrees/x/..", ".pi", "tron-clu.lock"),
  );
});

test("a second session is refused while the lock is fresh, and takes over once it is stale", () => {
  const { path, cleanup } = scratch("lock");
  try {
    const lockPath = join(path, ".pi", "tron-clu.lock");

    const first = acquireLock(lockPath, "s1", "m1");
    assert.equal(first.ok, true);

    const contested = acquireLock(lockPath, "s2", "m2");
    assert.equal(contested.ok, false);
    assert.equal(contested.ok === false && contested.stale, false);
    assert.equal(contested.ok === false && contested.held.sessionId, "s1");

    const reentrant = acquireLock(lockPath, "s1", "m1");
    assert.equal(reentrant.ok, true, "the holder re-acquires its own lock");

    age(lockPath, STALE_AFTER_MS + 1_000);
    const takeover = acquireLock(lockPath, "s2", "m2");
    assert.equal(takeover.ok, false);
    assert.equal(
      takeover.ok === false && takeover.stale,
      true,
      "stale is reported, never silently taken",
    );
  } finally {
    cleanup();
  }
});

test("a heartbeat only refreshes its own lock", () => {
  const { path, cleanup } = scratch("lock-beat");
  try {
    const lockPath = join(path, ".pi", "tron-clu.lock");
    acquireLock(lockPath, "s1", "m1");
    age(lockPath, 120_000);
    const before = readLock(lockPath)?.heartbeat;

    assert.equal(touchLock(lockPath, "s2"), false, "a foreign session cannot keep the lock alive");
    assert.equal(readLock(lockPath)?.heartbeat, before);

    assert.equal(touchLock(lockPath, "s1"), true);
    assert.notEqual(readLock(lockPath)?.heartbeat, before);
  } finally {
    cleanup();
  }
});

test("unlock refuses a live lock and releases a stale one", () => {
  const { path, cleanup } = scratch("lock-unlock");
  try {
    const lockPath = join(path, ".pi", "tron-clu.lock");
    assert.equal(forceUnlock(lockPath).released, false, "nothing to unlock is not an unlock");

    acquireLock(lockPath, "s1", "m1");
    const live = forceUnlock(lockPath);
    assert.equal(live.released, false);
    assert.match(live.reason ?? "", /lock is live/);
    assert.ok(readLock(lockPath), "a refused unlock leaves the lock in place");

    age(lockPath, STALE_AFTER_MS + 1_000);
    assert.equal(forceUnlock(lockPath).released, true);
    assert.equal(readLock(lockPath), undefined);
  } finally {
    cleanup();
  }
});

test("release is holder-only", () => {
  const { path, cleanup } = scratch("lock-release");
  try {
    const lockPath = join(path, ".pi", "tron-clu.lock");
    acquireLock(lockPath, "s1", "m1");
    releaseLock(lockPath, "s2");
    assert.ok(readLock(lockPath), "another session's release is a no-op");
    releaseLock(lockPath, "s1");
    assert.equal(readLock(lockPath), undefined);
  } finally {
    cleanup();
  }
});

test("a corrupt lock file reads as no lock rather than crashing the command", () => {
  const { path, cleanup } = scratch("lock-corrupt");
  try {
    const lockPath = join(path, ".pi", "tron-clu.lock");
    acquireLock(lockPath, "s1", "m1");
    writeFileSync(lockPath, "{ truncated");
    assert.equal(readLock(lockPath), undefined);
    assert.equal(acquireLock(lockPath, "s2", "m2").ok, true);
    assert.match(readFileSync(lockPath, "utf8"), /"sessionId": "s2"/);
  } finally {
    cleanup();
  }
});

test("staleness is measured against the heartbeat, not the acquisition", () => {
  const fresh = {
    sessionId: "s",
    host: "h",
    pid: 1,
    mandateId: "m",
    heartbeat: new Date().toISOString(),
  };
  assert.equal(isStale(fresh), false);
  assert.equal(isStale(fresh, Date.now() + STALE_AFTER_MS + 1), true);
});
