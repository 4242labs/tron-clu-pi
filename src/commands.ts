export type ParsedCommand =
  | { kind: "status" }
  | { kind: "init"; args: string[] }
  | { kind: "abort" }
  | { kind: "unlock" }
  | { kind: "approve"; blockId: string }
  | { kind: "reject"; blockId: string; reason: string }
  | { kind: "answer"; itemId: string; choice: string }
  | { kind: "mandate"; path: string }
  | { kind: "error"; message: string };

/** Subcommands that are answered without touching the lock — they parse first, always. */
export const LOCK_EXEMPT = new Set([
  "status",
  "abort",
  "approve",
  "reject",
  "answer",
  "unlock",
  "init",
]);

/** Commands that only ever run in the TUI: no programmatic start, no programmatic approval. */
export const TUI_ONLY = new Set(["mandate", "approve", "reject", "answer"]);

export function parseCommand(raw: string): ParsedCommand {
  const args = raw
    .trim()
    .split(/\s+/)
    .filter((a) => a !== "");
  const [head, ...rest] = args;

  if (head === undefined || head === "status") return { kind: "status" };
  if (head === "init") return { kind: "init", args: rest };
  if (head === "abort") return { kind: "abort" };
  if (head === "unlock") return { kind: "unlock" };

  if (head === "approve") {
    const blockId = rest[0];
    if (!blockId) return { kind: "error", message: "usage: /tron-clu approve <block-id>" };
    return { kind: "approve", blockId };
  }

  if (head === "reject") {
    const blockId = rest[0];
    const reason = rest.slice(1).join(" ").trim();
    if (!blockId || reason === "") {
      return {
        kind: "error",
        message:
          "usage: /tron-clu reject <block-id> <reason> — a rejection without a reason is not reviewable",
      };
    }
    return { kind: "reject", blockId, reason };
  }

  if (head === "answer") {
    const itemId = rest[0];
    const choice = rest[1];
    if (!itemId || !choice)
      return { kind: "error", message: "usage: /tron-clu answer <item-id> <choice>" };
    return { kind: "answer", itemId, choice };
  }

  return { kind: "mandate", path: args.join(" ") };
}
