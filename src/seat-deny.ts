import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Loaded into every seat with `-e`. The merge is the operator's, and a seat has no path to
 * one: not by git, not by gh, not by an alias, not by a script it wrote a minute ago.
 *
 * Pattern matching is bypassable by a determined process and is not claimed otherwise —
 * it is the second lock. The first is the tool allowlist the parent sets; the third is the
 * parked merge state, which no seat can reach at all.
 */
/**
 * Global git options and their arguments, so `git -C /repo merge` and `git --git-dir=x rebase`
 * are the same command as `git merge` and `git rebase` — which they are.
 */
const GIT = String.raw`\bgit\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+(?:[^-\s]\S*\s+)?)*`;

const DENY = [
  new RegExp(`${GIT}merge\\b`),
  new RegExp(`${GIT}rebase\\b`),
  new RegExp(`${GIT}push\\b`),
  new RegExp(`${GIT}cherry-pick\\b`),
  /\bgh\s+pr\s+(?:merge|create|ready)\b/,
  /\bgh\s+(?:api|repo)\b.*\bmerge/,
  /\bgit\s+config\b.*\balias\b/,
  /\bgit\s+remote\s+(?:set-url|add)\b/,
];

export const deniedReason = (command: string): string | undefined => {
  const hit = DENY.find((rx) => rx.test(command));
  return hit
    ? `blocked by tron-clu seat policy: seats never merge, push, or rewrite remotes (matched ${hit})`
    : undefined;
};

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    const input = event.input as Record<string, unknown> | undefined;
    const command =
      typeof input?.command === "string"
        ? input.command
        : typeof input?.cmd === "string"
          ? input.cmd
          : undefined;
    if (!command) return;
    const reason = deniedReason(command);
    if (reason) return { block: true, reason };
  });
}
