import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Host, RunOptions, RunResult } from "../src/host.ts";
import type { JournalEntry } from "../src/types.ts";

/** Test scratch lives inside the repo — nothing is written outside it. */
export function scratch(prefix: string): { path: string; cleanup: () => void } {
  const base = join(process.cwd(), ".tmp-test");
  mkdirSync(base, { recursive: true });
  const path = mkdtempSync(join(base, `${prefix}-`));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

const runReal = (command: string, args: string[], options?: RunOptions): Promise<RunResult> =>
  new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      { cwd: options?.cwd, timeout: options?.timeout, encoding: "utf8" },
      (error, stdout, stderr) => {
        const err = error as (Error & { code?: number; killed?: boolean }) | null;
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          killed: !!err?.killed,
        });
      },
    );
    options?.signal?.addEventListener("abort", () => child.kill(), { once: true });
  });

export interface TestHost extends Host {
  entries: JournalEntry[];
  notifications: { text: string; level: string }[];
  status: Record<string, string | undefined>;
}

/** A Host backed by real processes and an in-memory journal — the session, without Pi. */
export function testHost(cwd: string, sessionId = "test-session"): TestHost {
  const entries: JournalEntry[] = [];
  const notifications: { text: string; level: string }[] = [];
  const status: Record<string, string | undefined> = {};
  return {
    cwd,
    mode: "tui",
    entries,
    notifications,
    status,
    sessionId: () => sessionId,
    run: (command, args, options) => runReal(command, args, { cwd, ...options }),
    append: (entry) => void entries.push(entry),
    journal: () => [...entries],
    notify: (text, level = "info") => void notifications.push({ text, level }),
    setStatus: (key, text) => {
      status[key] = text;
    },
    setWidget: (key, lines) => {
      status[`widget:${key}`] = lines?.join("\n");
    },
  };
}

/** A git repo with one commit on `main`, an origin it can push to, and nothing else. */
export async function fixtureRepo(path: string): Promise<{ repo: string; origin: string }> {
  const origin = join(path, "origin.git");
  const repo = join(path, "repo");
  await runReal("git", ["init", "--bare", "-b", "main", origin]);
  await runReal("git", ["init", "-b", "main", repo]);
  const git = (args: string[]) => runReal("git", args, { cwd: repo });
  await git(["config", "user.email", "clu@test"]);
  await git(["config", "user.name", "CLU test"]);
  await runReal("sh", ["-c", `echo seed > ${join(repo, "seed.txt")}`]);
  await git(["add", "-A"]);
  await git(["commit", "-m", "seed"]);
  await git(["remote", "add", "origin", origin]);
  await git(["push", "-u", "origin", "main"]);
  return { repo, origin };
}
