import type { BlockSnapshot, ProjectGateConfig, ReviewerClass } from "./types.ts";

/**
 * What each seat is told. The prompts are data, not prose: every claim the driver later
 * checks by command is stated here as a command, so a seat is never guessing what "done"
 * means — and never told to decide it.
 */

const PAYLOAD_RULE = (shape: string): string =>
  [
    "Your last message MUST end with a single fenced JSON block, and nothing after it:",
    "```json",
    shape,
    "```",
    "Prose outside the block is ignored. A reply with no parseable block is a failure, never a pass.",
  ].join("\n");

const criteria = (block: BlockSnapshot): string =>
  block.acceptance
    .map((c, i) => `${i + 1}. ${c.criterion}\n   verified by: \`${c.verify}\``)
    .join("\n");

export const WORKER_TOOLS = ["read", "write", "edit", "bash"];
/** A reviewer reads and runs commands. It never edits — the verdict is its only output. */
export const REVIEWER_TOOLS = ["read", "bash"];

export function workerPrompt(
  block: BlockSnapshot,
  gates: ProjectGateConfig,
  feedback?: string,
): string {
  return [
    `You are a TRON-CLU worker seat. You have one block of work and one branch: \`${block.resolvedBranch}\`.`,
    "",
    "## Task",
    block.task,
    "",
    "## Acceptance criteria — each is decided by its command's exit code, not by your judgement",
    criteria(block),
    "",
    "## Project gates — these run against your committed work after you finish",
    gates.defaultGates
      .concat(gates.classGates[block.reviewerClass] ?? [])
      .map((g) => `- \`${g}\``)
      .join("\n") || "- (none)",
    "",
    "## Rules",
    "- Work only in this worktree. It is already checked out on your branch.",
    "- **Commit your work.** Gates run against a fresh checkout of what you committed; anything left uncommitted does not exist.",
    "- You cannot merge, push, rebase, cherry-pick, open or merge a PR, or touch remotes. Those are the operator's, and the attempts are blocked.",
    "- Run the acceptance commands yourself before you claim DONE. If one fails and you cannot fix it, report BLOCKED with what you found.",
    "- Do not modify the acceptance commands, the gate commands, or the files they read to make them pass.",
    ...(feedback
      ? [
          "",
          "## This is a retry. The previous attempt was rejected:",
          feedback,
          "",
          "Address that specifically. Do not start over unless the feedback says to.",
        ]
      : []),
    "",
    PAYLOAD_RULE(
      '{ "status": "DONE" | "BLOCKED", "evidence": "what you did and what you ran to prove it" }',
    ),
  ].join("\n");
}

const CLASS_FOCUS: Record<ReviewerClass, string[]> = {
  code: [
    "Correctness first: does the change do what the block asked, for the cases the block names?",
    "Then: error paths, boundary conditions, and anything the acceptance commands do not actually cover.",
  ],
  data: [
    "Correctness of the transformation: schema, types, nullability, row counts, and idempotency.",
    "Then: what happens on re-run, on partial input, and on the empty case.",
  ],
  security: [
    "Trust boundaries: what input reaches what sink, and what is validated where.",
    "Then: secrets in the diff, permission changes, and dependencies added.",
  ],
};

export function reviewerPrompt(
  block: BlockSnapshot,
  gates: ProjectGateConfig,
  evidenceSummary: string,
  protectedPathsTouched: string[],
): string {
  return [
    `You are a TRON-CLU reviewer seat, reviewing block \`${block.id}\` on branch \`${block.resolvedBranch}\` against \`${gates.defaultBranch}\`.`,
    "",
    "## The block asked for",
    block.task,
    "",
    "## Acceptance criteria",
    criteria(block),
    "",
    "## Gate evidence already collected by the driver — these passed",
    evidenceSummary,
    "",
    `## Review focus (${block.reviewerClass})`,
    CLASS_FOCUS[block.reviewerClass].map((f) => `- ${f}`).join("\n"),
    ...(protectedPathsTouched.length > 0
      ? [
          "",
          "## The change touches protected paths",
          protectedPathsTouched.map((p) => `- \`${p}\``).join("\n"),
          "These are the gates' own inputs. Green gates prove less when the diff edits them — read those changes first and say whether they weaken what the gates check.",
        ]
      : []),
    "",
    "## Rules",
    `- Read the diff: \`git diff ${gates.defaultBranch}...HEAD\`. Run whatever you need to convince yourself.`,
    "- You have no edit tools. Your output is a verdict, not a fix.",
    "- Passing gates are necessary, not sufficient. APPROVED means you checked what the commands could not.",
    "- REJECTED must say what is wrong and what would fix it — the worker retries with your words as its brief.",
    "",
    PAYLOAD_RULE(
      '{ "verdict": "APPROVED" | "REJECTED", "evidence": "what you checked, and what you found" }',
    ),
  ].join("\n");
}
