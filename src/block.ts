import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Block, BlockSnapshot, ReviewerClass } from "./types.ts";

const REVIEWER_CLASSES: ReviewerClass[] = ["code", "data", "security"];
const BLOCK_KEYS = new Set(["id", "task", "acceptance", "reviewerClass", "branch"]);
const CRITERION_KEYS = new Set(["criterion", "verify"]);

export class BlockError extends Error {}

const fail = (where: string, why: string): never => {
  throw new BlockError(`${where}: ${why}`);
};

/**
 * Fail-closed by construction: anything not explicitly accepted here stops the mandate
 * before it starts. An unknown field is a typo or a newer schema, and both are reasons
 * not to run.
 */
export function validateBlock(raw: unknown, where: string): Block {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fail(where, "block must be a JSON object");
  }
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!BLOCK_KEYS.has(key)) return fail(where, `unknown field "${key}"`);
  }
  if (typeof o.id !== "string" || o.id.trim() === "")
    return fail(where, "id must be a non-empty string");
  if (!/^[A-Za-z0-9._-]+$/.test(o.id)) return fail(where, `id "${o.id}" must be [A-Za-z0-9._-]`);
  if (typeof o.task !== "string" || o.task.trim() === "")
    return fail(where, "task must be a non-empty string");
  if (
    typeof o.reviewerClass !== "string" ||
    !REVIEWER_CLASSES.includes(o.reviewerClass as ReviewerClass)
  ) {
    return fail(where, `reviewerClass must be one of ${REVIEWER_CLASSES.join(", ")}`);
  }
  if (o.branch !== undefined && (typeof o.branch !== "string" || o.branch.trim() === "")) {
    return fail(where, "branch, when present, must be a non-empty string");
  }
  if (!Array.isArray(o.acceptance) || o.acceptance.length === 0) {
    return fail(where, "acceptance must be a non-empty array");
  }
  const acceptance = o.acceptance.map((entry, i) => {
    const at = `${where} acceptance[${i}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return fail(at, "must be an object");
    }
    const c = entry as Record<string, unknown>;
    for (const key of Object.keys(c)) {
      if (!CRITERION_KEYS.has(key)) return fail(at, `unknown field "${key}"`);
    }
    if (typeof c.criterion !== "string" || c.criterion.trim() === "") {
      return fail(at, "criterion must be a non-empty string");
    }
    if (typeof c.verify !== "string" || c.verify.trim() === "") {
      return fail(
        at,
        "verify must be a non-empty verification command — a criterion no command can check is not a criterion",
      );
    }
    return { criterion: c.criterion, verify: c.verify };
  });
  return {
    id: o.id,
    task: o.task,
    acceptance,
    reviewerClass: o.reviewerClass as ReviewerClass,
    ...(o.branch === undefined ? {} : { branch: o.branch as string }),
  };
}

export const hashContent = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

export function snapshotBlock(path: string, mandateId: string): BlockSnapshot {
  const content = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new BlockError(`${path}: not valid JSON — ${(e as Error).message}`);
  }
  const block = validateBlock(parsed, path);
  return {
    ...block,
    path,
    hash: hashContent(content),
    resolvedBranch: block.branch ?? `clu/${mandateId}-${block.id}`,
  };
}

/** A mandate is a JSON file holding an ordered list of block-file paths. */
export function readMandate(mandatePath: string, mandateId: string): BlockSnapshot[] {
  const content = readFileSync(mandatePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new BlockError(`${mandatePath}: not valid JSON — ${(e as Error).message}`);
  }
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" &&
        parsed !== null &&
        Array.isArray((parsed as { blocks?: unknown }).blocks)
      ? (parsed as { blocks: unknown[] }).blocks
      : fail(mandatePath, 'must be an array of block paths, or an object with a "blocks" array');
  if (list.length === 0) return fail(mandatePath, "names no blocks");
  const base = dirname(resolve(mandatePath));
  const seen = new Set<string>();
  return list.map((entry, i) => {
    if (typeof entry !== "string")
      return fail(`${mandatePath} blocks[${i}]`, "must be a path string");
    const path = isAbsolute(entry) ? entry : resolve(base, entry);
    const snapshot = snapshotBlock(path, mandateId);
    if (seen.has(snapshot.id)) return fail(mandatePath, `duplicate block id "${snapshot.id}"`);
    seen.add(snapshot.id);
    return snapshot;
  });
}

/**
 * The snapshot rule's other half: the driver executes frozen content, and a disk edit
 * mid-mandate is surfaced rather than adopted.
 */
export function blockFileChanged(snapshot: BlockSnapshot): boolean {
  try {
    return hashContent(readFileSync(snapshot.path, "utf8")) !== snapshot.hash;
  } catch {
    return true;
  }
}
