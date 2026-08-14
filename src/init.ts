import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { saveGateConfig } from "./config.ts";
import { ghAvailable } from "./git.ts";
import type { Host } from "./host.ts";
import type { MergeStrategy, ProjectGateConfig } from "./types.ts";

/** Paths whose modification the reviewer must be told about — a gate's own inputs. */
const DEFAULT_PROTECTED = [
  "test/**",
  "tests/**",
  "**/*.test.*",
  "**/*.spec.*",
  ".github/**",
  "package.json",
  ".pi/**",
];

const GITIGNORE_LINES = [
  ".pi/tron-clu.lock",
  ".pi/tron-clu-work/",
  ".pi/tron-clu-verify/",
  // A bot token in a repository is a bot token on the internet.
  ".pi/tron-clu.env",
];

export interface InitOptions {
  repo: string;
  defaultBranch: string;
  mergeStrategy: MergeStrategy;
  defaultGates: string[];
  gateTimeoutSeconds?: number;
}

export interface InitReport {
  configPath: string;
  config: ProjectGateConfig;
  gitignoreUpdated: boolean;
  notes: string[];
}

export class InitError extends Error {}

/**
 * The `pi` seats run must be the same `pi` the host is running — resolved once, recorded,
 * and asserted at spawn. A bare PATH lookup at spawn time is how a fleet silently ends up
 * on two different agents.
 */
export async function resolvePiBinary(host: Host): Promise<{ path: string; version: string }> {
  const which = await host.run("sh", ["-c", "command -v pi"]);
  if (which.code !== 0 || which.stdout.trim() === "") {
    throw new InitError("`pi` is not on PATH — seats cannot be spawned without it");
  }
  const path = which.stdout.trim();
  const version = await host.run(path, ["--version"]);
  if (version.code !== 0) throw new InitError(`${path} --version failed: ${version.stderr.trim()}`);
  return { path, version: version.stdout.trim() };
}

export async function initProject(host: Host, options: InitOptions): Promise<InitReport> {
  const notes: string[] = [];

  if (
    (options.mergeStrategy === "pr" || options.mergeStrategy === "squash") &&
    !(await ghAvailable(host))
  ) {
    throw new InitError(
      `merge strategy "${options.mergeStrategy}" needs the gh CLI, which is not installed`,
    );
  }
  if (options.defaultGates.length === 0) {
    throw new InitError(
      "a project with no default gates cannot be supervised — fail-open does not exist",
    );
  }

  const pi = await resolvePiBinary(host);

  const config: ProjectGateConfig = {
    version: 1,
    defaultGates: options.defaultGates,
    classGates: { code: [], data: [], security: [] },
    protectedPaths: DEFAULT_PROTECTED,
    mergeStrategy: options.mergeStrategy,
    defaultBranch: options.defaultBranch,
    gateTimeoutSeconds: options.gateTimeoutSeconds ?? 600,
    piBinary: pi.path,
    piVersion: pi.version,
  };
  const configPath = saveGateConfig(options.repo, config);

  const gitignore = join(options.repo, ".gitignore");
  const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  const missing = GITIGNORE_LINES.filter((line) => !existing.split("\n").includes(line));
  if (missing.length > 0) {
    appendFileSync(
      gitignore,
      `${existing.endsWith("\n") || existing === "" ? "" : "\n"}# tron-clu\n${missing.join("\n")}\n`,
    );
  }

  const trusted = await host.run("sh", ["-c", "true"]);
  if (trusted.code !== 0)
    notes.push(
      "could not run a shell command in this project — check the host session's tool config",
    );

  notes.push(`seats will be spawned with ${pi.path} (${pi.version})`);
  notes.push(
    "start Pi from the repository root; a mandate started elsewhere resolves the wrong worktrees",
  );

  return { configPath, config, gitignoreUpdated: missing.length > 0, notes };
}
