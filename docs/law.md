# The law — what a seat cannot do, and what that is worth

The rule this project exists to keep: **a seat never lands work.** The operator merges, in
the TUI, after reading a review. Everything below is how that rule is held, and — just as
importantly — where holding it stops being a guarantee.

## Three mechanisms, in order of strength

### 1. The tool allowlist (parent-enforced, not bypassable by the seat)

Every seat is spawned with `-t <list>`. P0 verified this is a hard allowlist: with `-t read`,
a prompt that explicitly demanded bash produced no bash call, because the model had no such
tool. It is enforced by the parent process, not by prompt discipline.

| Seat | Tools | Consequence |
|:--|:--|:--|
| worker | `read,write,edit,bash` | can change files and run commands; cannot avoid `bash` denial below |
| reviewer | `read,bash` | **cannot edit anything.** Its output is a verdict or nothing |

A reviewer's inability to write is not a policy. It is an absence.

### 2. The parked merge (structural — no code path exists)

The driver has no branch that merges without an operator ruling in the journal. `pending_merge`
is a state the phase loop cannot leave on its own: `run()` returns `parked` while it is set, and
only a `ruling` entry — written by `/tron-clu approve` or `/tron-clu reject`, both TUI-only —
clears it. There is no timeout, no default, no non-TUI path. A seat cannot reach this state at
all: it is in the driver's session, not the seat's.

Landing is then **verified by command** (`gh pr view --json state,mergedAt`, or
`git merge-base --is-ancestor`), never assumed because a merge command exited 0.

### 3. The seat-deny extension (pattern matching — the weakest of the three)

`src/seat-deny.ts` loads into every seat via `-e` and blocks `tool_call`s whose command
matches merge, rebase, push, cherry-pick, `gh pr merge|create|ready`, `gh api … merge`, a git
alias definition, or a remote rewrite — including through global git options, so
`git -C /repo merge` is the same command as `git merge`.

**This one is bypassable, and it is not claimed otherwise.** A determined process can:

- write a shell script that runs `git merge` and execute the script by name;
- build the command from pieces (`g=merge; git $g main`, `'pu'+'sh'`);
- base64 or otherwise encode it;
- call a git plumbing sequence that lands a commit without the word "merge"
  (`git update-ref`, and its relatives).

It does catch a denied command quoted inside another one — `bash -c 'git merge main'` and
`node -e "…execSync('git push')"` both match, because the words survive. What defeats it is
breaking the words apart, and nothing stops a seat from doing that.

Pattern matching catches the accidental and the casual, not the adversarial. It is the third
lock precisely because the first two do not depend on it.

## The residual risk, stated plainly

A worker seat has `bash` inside its own worktree, and `bash` is a general-purpose capability.
The controls that actually hold are: **(a)** it cannot push — the deny catches the direct
forms, and a seat that defeats the deny still has to get past **(b)** the fact that landing is
verified by command against the remote, and **(c)** a human who reads the review before
approving. Control (c) is load-bearing. A pilot on a sandbox repo, not a production one, is
the mitigation for the window where (a) is defeated and (c) has not happened yet.

Egress is uncontained in v1: a seat with `bash` can reach the network. Containerised seats are
evaluated at P4; until then the mitigation is the sandbox-only pilot, and it is named as a
limitation rather than solved.

## Trust state

Explicit `-e <path>` extensions load **without** project trust (P0). Discovered
`.pi/extensions` require the project to be trusted. The driver therefore never depends on the
project being trusted for the deny extension to load — the one control that would otherwise be
silently absent in an untrusted project is not.

## What the operator sees

Every park names the block, the reason, and the exact answers it accepts. Nothing else is
accepted, and nothing happens without one:

| Park | Answers | Effect |
|:--|:--|:--|
| merge (every approved block) | `approve` / `reject <reason>` | the merge, or the block abandoned |
| `retry-cap` | `retry-raised-cap-once` / `abandon` / `stop-mandate` | one more attempt / block abandoned / mandate stopped |
| `budget-breach` | `terminate-seat` / `extend-once` / `abandon` / `stop-mandate` | kill the seat / double the budget once / abandon / stop |
| `block-file-edited` | `continue-with-snapshot` / `stop-mandate` | run the frozen snapshot / stop |
| `merge-not-landed` | `recheck` / `retry-merge` / `abandon` / `stop-mandate` | check again / merge again / abandon / stop |

A choice the escalation did not offer is refused at the command, and refused again at the
fold: an answer that is not in the escalation's own list grants nothing.
