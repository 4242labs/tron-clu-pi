import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectGateConfig, ReviewerClass } from "./types.ts";

export const CONFIG_RELATIVE = join(".pi", "tron-clu.json");

export const configPathFor = (repo: string): string => join(repo, CONFIG_RELATIVE);

export class ConfigError extends Error {}

const REQUIRED_CLASSES: ReviewerClass[] = ["code", "data", "security"];

const strings = (v: unknown, where: string): string[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new ConfigError(`${where} must be an array of strings`);
  }
  return v as string[];
};

export function validateGateConfig(raw: unknown): ProjectGateConfig {
  if (typeof raw !== "object" || raw === null)
    throw new ConfigError("gate config must be an object");
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) throw new ConfigError("gate config version must be 1");
  const defaultGates = strings(o.defaultGates, "defaultGates");
  if (defaultGates.length === 0) {
    throw new ConfigError(
      "defaultGates is empty — a project with no gates cannot be supervised, and fail-open does not exist",
    );
  }
  const classGatesRaw = o.classGates;
  if (typeof classGatesRaw !== "object" || classGatesRaw === null) {
    throw new ConfigError("classGates must be an object");
  }
  const classGates = {} as Record<ReviewerClass, string[]>;
  for (const c of REQUIRED_CLASSES) {
    classGates[c] = strings((classGatesRaw as Record<string, unknown>)[c] ?? [], `classGates.${c}`);
  }
  const strategy = o.mergeStrategy;
  if (
    strategy !== "merge-commit" &&
    strategy !== "rebase" &&
    strategy !== "squash" &&
    strategy !== "pr"
  ) {
    throw new ConfigError("mergeStrategy must be one of merge-commit, rebase, squash, pr");
  }
  const str = (key: string): string => {
    const v = o[key];
    if (typeof v !== "string" || v.trim() === "")
      throw new ConfigError(`${key} must be a non-empty string`);
    return v;
  };
  const timeout = o.gateTimeoutSeconds;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    throw new ConfigError("gateTimeoutSeconds must be a positive number");
  }
  return {
    version: 1,
    defaultGates,
    classGates,
    protectedPaths: strings(o.protectedPaths ?? [], "protectedPaths"),
    mergeStrategy: strategy,
    defaultBranch: str("defaultBranch"),
    gateTimeoutSeconds: timeout,
    piBinary: str("piBinary"),
    piVersion: str("piVersion"),
  };
}

export function loadGateConfig(repo: string): ProjectGateConfig {
  const path = configPathFor(repo);
  if (!existsSync(path)) {
    throw new ConfigError(`no gate config at ${path} — run /tron-clu init first`);
  }
  try {
    return validateGateConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`${path}: ${(e as Error).message}`);
  }
}

export function saveGateConfig(repo: string, config: ProjectGateConfig): string {
  const path = configPathFor(repo);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}
