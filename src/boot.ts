import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { BootConfig, MergeAuthority, ReviewerClass } from "./types.ts";

/** Dialog defaults. A dismissed prompt is a refusal, never an implied default. */
const DIALOG = { timeout: 120_000 };

export const DEFAULTS = {
  budgetMinutes: 30,
  turnCap: 40,
  retryCap: 2,
} as const;

export class BootCancelled extends Error {
  constructor(what: string) {
    super(`boot prompt "${what}" was dismissed — the mandate never started and no lock was taken`);
  }
}

const positiveInt = (raw: string | undefined, what: string, fallback: number): number => {
  if (raw === undefined) throw new BootCancelled(what);
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n <= 0) throw new BootCancelled(`${what} (got "${trimmed}")`);
  return n;
};

/**
 * Boot is interactive on purpose: the operator sets the terms of the run before anything
 * is locked or spawned. Every prompt fails closed.
 */
export async function promptBootConfig(
  ctx: ExtensionCommandContext,
  models: string[],
): Promise<BootConfig> {
  const workerModel = await ctx.ui.select("CLU — model for worker seats", models, DIALOG);
  if (!workerModel) throw new BootCancelled("worker model");

  const reviewerModel = await ctx.ui.select("CLU — model for reviewer seats", models, DIALOG);
  if (!reviewerModel) throw new BootCancelled("reviewer model");

  const reviewerClass = (await ctx.ui.select(
    "CLU — default reviewer class for blocks that don't name one",
    ["code", "data", "security"],
    DIALOG,
  )) as ReviewerClass | undefined;
  if (!reviewerClass) throw new BootCancelled("default reviewer class");

  const authority = await ctx.ui.select(
    "CLU — who executes the merge after you approve it",
    ["operator-executes", "driver-executes-on-approval"],
    DIALOG,
  );
  if (!authority) throw new BootCancelled("merge authority");

  const budget = await ctx.ui.input(
    "CLU — wall-clock budget per block, in minutes",
    String(DEFAULTS.budgetMinutes),
    DIALOG,
  );
  const turns = await ctx.ui.input("CLU — turn cap per block", String(DEFAULTS.turnCap), DIALOG);
  const retries = await ctx.ui.input(
    "CLU — retries per phase before escalation",
    String(DEFAULTS.retryCap),
    DIALOG,
  );

  return {
    workerModel,
    reviewerModel,
    defaultReviewerClass: reviewerClass,
    mergeAuthority: authority as MergeAuthority,
    budgetMinutes: positiveInt(budget, "budget", DEFAULTS.budgetMinutes),
    turnCap: positiveInt(turns, "turn cap", DEFAULTS.turnCap),
    retryCap: positiveInt(retries, "retry cap", DEFAULTS.retryCap),
  };
}
