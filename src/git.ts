import { join } from "node:path";
import type { Host } from "./host.ts";
import type { MergeStrategy } from "./types.ts";

export class GitError extends Error {}

const run = async (host: Host, args: string[], cwd?: string) => {
  const r = await host.run("git", args, cwd ? { cwd } : undefined);
  if (r.code !== 0)
    throw new GitError(`git ${args.join(" ")} → ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.trim();
};

export const gitCommonDir = async (host: Host, cwd = host.cwd): Promise<string> => {
  const out = await run(host, ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  return out;
};

export const repoRoot = async (host: Host, cwd = host.cwd): Promise<string> =>
  run(host, ["rev-parse", "--show-toplevel"], cwd);

export const currentBranch = async (host: Host, cwd = host.cwd): Promise<string> =>
  run(host, ["rev-parse", "--abbrev-ref", "HEAD"], cwd);

export const revParse = async (host: Host, ref: string, cwd = host.cwd): Promise<string> =>
  run(host, ["rev-parse", ref], cwd);

export async function worktreeAdd(
  host: Host,
  path: string,
  branch: string,
  base: string,
  cwd = host.cwd,
): Promise<void> {
  await run(host, ["worktree", "add", "-B", branch, path, base], cwd);
}

/** Detached checkout of an existing commit — how the verification worktree is made. */
export async function worktreeAddDetached(
  host: Host,
  path: string,
  ref: string,
  cwd = host.cwd,
): Promise<void> {
  await run(host, ["worktree", "add", "--detach", path, ref], cwd);
}

export async function worktreeRemove(host: Host, path: string, cwd = host.cwd): Promise<void> {
  await run(host, ["worktree", "remove", "--force", path], cwd);
}

/** Branches are always kept; only the checkout is thrown away. */
export const verificationWorktreePath = (repo: string, blockId: string): string =>
  join(repo, ".pi", "tron-clu-verify", blockId);

export const blockWorktreePath = (repo: string, blockId: string): string =>
  join(repo, ".pi", "tron-clu-work", blockId);

export const hasCommits = async (
  host: Host,
  branch: string,
  base: string,
  cwd = host.cwd,
): Promise<boolean> =>
  (await run(host, ["rev-list", "--count", `${base}..${branch}`], cwd)) !== "0";

/** Files the block touched, for the reviewer's protected-paths summary. */
export const changedFiles = async (
  host: Host,
  base: string,
  branch: string,
  cwd = host.cwd,
): Promise<string[]> => {
  const out = await run(host, ["diff", "--name-only", `${base}...${branch}`], cwd);
  return out === "" ? [] : out.split("\n");
};

export async function push(host: Host, branch: string, cwd = host.cwd): Promise<void> {
  await run(host, ["push", "-u", "origin", branch], cwd);
}

/**
 * After a landing, bring the local default branch up to the remote — the next block branches
 * from it, and a stale base is how a sequential mandate collides with its own first block.
 */
export async function syncDefaultBranch(
  host: Host,
  defaultBranch: string,
  cwd: string,
): Promise<boolean> {
  if ((await host.run("git", ["fetch", "origin", defaultBranch], { cwd })).code !== 0) return false;
  const current = (
    await host.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd })
  ).stdout.trim();
  const args =
    current === defaultBranch
      ? ["merge", "--ff-only", `origin/${defaultBranch}`]
      : ["fetch", "origin", `${defaultBranch}:${defaultBranch}`];
  return (await host.run("git", args, { cwd })).code === 0;
}

export interface LandingCheck {
  landed: boolean;
  how: string;
}

/**
 * Landing is command-verified, per strategy, with no weaker fallback: a run never assumes
 * a merge happened because someone said so.
 */
export async function verifyLanded(
  host: Host,
  strategy: MergeStrategy,
  branch: string,
  defaultBranch: string,
  cwd = host.cwd,
): Promise<LandingCheck> {
  if (strategy === "pr" || strategy === "squash") {
    const r = await host.run("gh", ["pr", "view", branch, "--json", "state,mergedAt"], { cwd });
    if (r.code !== 0) return { landed: false, how: `gh pr view → ${r.code}: ${r.stderr.trim()}` };
    try {
      const view = JSON.parse(r.stdout) as { state?: string; mergedAt?: string | null };
      return {
        landed: view.state === "MERGED" && !!view.mergedAt,
        how: `gh pr state=${view.state}`,
      };
    } catch {
      return { landed: false, how: "gh pr view returned unparseable JSON" };
    }
  }
  await run(host, ["fetch", "origin", defaultBranch], cwd);
  const head = await revParse(host, branch, cwd);
  const r = await host.run(
    "git",
    ["merge-base", "--is-ancestor", head, `origin/${defaultBranch}`],
    { cwd },
  );
  return {
    landed: r.code === 0,
    how: `${head.slice(0, 12)} ancestor of origin/${defaultBranch}: ${r.code === 0}`,
  };
}

export async function openPullRequest(
  host: Host,
  branch: string,
  base: string,
  title: string,
  body: string,
  cwd = host.cwd,
): Promise<string> {
  const r = await host.run(
    "gh",
    ["pr", "create", "--head", branch, "--base", base, "--title", title, "--body", body],
    { cwd },
  );
  if (r.code !== 0) throw new GitError(`gh pr create → ${r.code}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

export const ghAvailable = async (host: Host): Promise<boolean> =>
  (await host.run("gh", ["--version"])).code === 0;
