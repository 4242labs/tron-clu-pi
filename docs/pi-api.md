# Pi API — verified contract

Baseline: **pi 0.84.1** (`@earendil-works/pi-coding-agent`, installed globally at
`/opt/homebrew/lib/node_modules/`). Everything below was read from the shipped type
declarations or observed in a live run on 2026-08-14. Anything not listed here is
unverified and must not be designed against.

Live probes: `pi -p --mode json -e ./probe.ts --model local/qwen36 -t <tools> --session-id <id>`,
run from a git worktree, log written by the probe extension itself.

## Extension packaging

Published extensions ship **TypeScript source, not a build**. Pi loads `.ts` directly.

| Field | Value |
|:--|:--|
| `pi.extensions` | `["./src/index.ts"]` — entry points, relative to package root |
| `files` | `["src", "README.md", "LICENSE"]` — no `dist` |
| `keywords` | must include `pi-package` (discovery), plus `pi-extension` |
| `peerDependencies` | `@earendil-works/pi-coding-agent: "*"` |
| `piExtension.lifecycle` | optional; `experimental` / `stable` |

Install surface: `pi install npm:<name>`, `pi install git:github.com/<user>/<repo>`,
`pi install ./local/path`; `-l` writes to project-local `.pi/settings.json` instead of
`~/.pi/agent/settings.json`. `pi list` enumerates installed packages.

## Running a seat (child process)

Verified flags for a headless seat:

```
pi -p --mode json -e <abs path to extension> --model <provider/id> \
   -t <allowed tools> --session-id <id> "<prompt>"
```

- **`-p` + `--mode json`** streams JSONL to stdout. First line is the session header
  (`{"type":"session","version":3,"id":...,"cwd":...}`), last events are `agent_end`
  (carries the full `messages[]`) then `agent_settled`. `message_end` holds the final
  authoritative message; `message_update` records are delta-only.
- **`-t <tools>` is a hard allowlist.** With `-t read`, a prompt that explicitly asked for
  bash produced no bash call — the model only had `read`. Tool restriction is enforced by
  the parent, not by prompt discipline.
- **Headless auto-approves.** With `-t bash`, `echo` ran to completion with no approval
  prompt and no `-na`. A seat will never hang on an approval dialog — and equally, nothing
  gates a destructive command except the tool allowlist and the seat's cwd.
- **`--session-id <id>`** creates a session under that id (warns on stderr when new, exit 0).
  **`--session <id>`** resumes it. Resume was verified: entries written by a previous
  process were read back in the next one.
- **`-ne` / `--no-extensions`** disables discovery while keeping explicit `-e` paths — the
  isolation lever for seats, so a seat never inherits the operator's global extensions.
- Explicit `-e <path>` loads **without project trust**. Only auto-discovered
  `.pi/extensions` entries require the project to be trusted.
- Exit code was 0 for every successful run; the stream, not the code, carries the outcome.

## Extension context (`ctx`)

Keys observed live: `ui`, `mode`, `hasUI`, `cwd`, `sessionManager`, `modelRegistry`,
`model`, `scopedModels`, `thinkingLevel`, `isIdle`, `isProjectTrusted`, `signal`, `abort`,
`hasPendingMessages`, `shutdown`, `getContextUsage`, `compact`, `getSystemPrompt`.

| Mode | `ctx.mode` | `ctx.hasUI` |
|:--|:--|:--|
| interactive | `tui` | `true` |
| `--mode rpc` | `rpc` | `true` |
| `--mode json` | `json` | **`false`** |
| `-p` | `print` | **`false`** |

**UI methods are no-ops in `json` and `print` mode.** A seat cannot ask a question. Every
decision that needs a human belongs to the driver, which runs in the TUI.

`ctx.getContextUsage()` returns `{ tokens, contextWindow, percent }` — live, per session.

## Budget

`AssistantMessage.usage` is a **required** field (`packages/ai` types) and was populated in
the live run: `{ input, output, cacheRead, cacheWrite, reasoning, totalTokens, cost }`,
with `cost` broken down the same way. Token *and* currency budgets are therefore both
measurable per turn from the JSON stream — wall-clock and turn caps are still the simplest
floor, but a token budget is no longer blocked on unknown telemetry.

## State journal

- `pi.appendEntry(...)` succeeded in headless mode.
- `ctx.sessionManager.getEntries()` read back the appended entry, including one written by
  an earlier process in the same session id. Entry types seen: `model_change`,
  `thinking_level_change`, `custom`, `message`.
- This is the resume mechanism: the driver's phase state is journalled as `custom` entries
  and rebuilt on `session_start`.

## Events

`session_start` fires with `{ type, reason }`. `session_shutdown` fired on normal exit of a
`-p` run. `tool_call` fires before execution and can return `{ block: true, reason }`.
Tool execution is also visible on the JSON stream as `tool_execution_start` /
`tool_execution_update` / `tool_execution_end` (`isError` on the end event).

Factory rule from the docs, and it binds us: **never start a long-lived resource in the
extension factory** — defer to `session_start` or the command that needs it, and register
an idempotent `session_shutdown`.

## Commands

`pi.getCommands()` returns every command with `sourceInfo`:
`{ path, source, scope, origin, baseDir? }` — `source` is `cli` for `-e` paths, `npm:<pkg>`
for installed packages, `auto` for discovered skills, `inline` for built-ins; `scope` is
`temporary` or `user`. Name collisions are suffixed `:N`. This is how the driver detects
whether it is running from a published install or a local checkout.

## exec

`pi.exec(cmd, args, { cwd, timeout, signal })` → `{ stdout, stderr, code, killed }`.
`cwd` is in the shipped types and worked live: `git rev-parse --abbrev-ref HEAD` returned
the worktree's branch, not the checkout's. The driver's verification worktree is therefore
addressable without changing the process cwd.
