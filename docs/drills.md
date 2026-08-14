# Drills

Every failure this design claims to survive, and how that claim is checked. A drill is
either **automated** — a test that fails if the behaviour regresses — or **manual**, with the
procedure written out. Nothing here is "should be fine".

Run the automated set with `npm test`.

## Failure drills

| Drill | How it is checked | Where |
|:--|:--|:--|
| **Merge park end to end** — build → gates → review → park → operator approves → push/merge → landing verified by command → wrap | automated | `test/graph.test.ts` "end to end: two blocks…" |
| **Reject path** — operator rejects the merge; the block is abandoned and the mandate moves on | automated | `test/graph.test.ts` "a rejected merge abandons the block" |
| **Detached park** — a park while the TUI is absent holds rather than resolving itself | automated | `test/commands.test.ts` (TUI-only set) + `src/index.ts` refuses `approve`/`reject`/`answer`/`mandate` when `ctx.mode !== "tui"` |
| **Kill / resume** — the host dies mid-mandate; the resume rebuilds state from the journal and re-parks the pending merge without re-running the block | automated | `test/graph.test.ts` "a kill mid-mandate resumes from the journal alone" |
| **Host SIGKILL with a live seat** — the resume terminates the recorded seat before anything else, and never kills a process that merely inherited the pid | automated, against real processes | `test/orphans.test.ts` |
| **Crash while a merge is pending** — the pending state survives; only a ruling clears it | automated | `test/journal.test.ts` "kill/resume with a merge pending" |
| **Stale lock + unlock liveness refusal** — `unlock` refuses while the heartbeat is fresh, releases once it is stale | automated | `test/lock.test.ts` |
| **Worker crash mid-phase** — a seat that exits without a payload is a failure, never a pass | automated | `test/pi-seats.test.ts` "a seat that crashes or says nothing" |
| **Worker hang mid-phase** — the wall-clock breach parks an escalation and **does not kill the seat** | automated | `test/graph.test.ts` "a breached budget parks an escalation and leaves the seat running" |
| **Cap enforcement** — a seat past its turn cap is stopped and reported as a failure | automated | `test/pi-seats.test.ts` "a seat past its turn cap is stopped" |
| **Abort, then resume on a dirty worktree** — the abort leaves the work; the resume finishes in the same worktree rather than fighting it | automated | `test/graph.test.ts` "an abort mid-build leaves the worktree" |
| **Reviewer rejection to the cap** — each retry carries the reviewer's own words; the cap parks | automated | `test/graph.test.ts` "a rejected review retries with the reviewer's words" |
| **Operator silence** — a parked mandate re-run is a no-op; nothing times out into a decision | automated | `test/graph.test.ts` "an open escalation blocks every further step" |
| **Block file edited mid-mandate** — parks; the snapshot is what runs, and only if the operator says so | automated | `test/graph.test.ts` "a block file edited mid-mandate parks" |
| **A seat tries to land work itself** — every direct spelling is denied; what pattern matching cannot catch is measured, not assumed | automated | `test/law.test.ts`, and [law.md](law.md) |
| **Telegram unreachable** — the park still lands in the TUI; the relay returns false and nothing else changes | automated | `test/telegram.test.ts` |

## Manual drills

Two things cannot be honestly automated here, because their whole point is that a person is
involved.

### The notify → approve → land drill

1. Configure `.pi/tron-clu.env` with a bot token and chat id.
2. Start a mandate whose first block is trivial.
3. When the merge parks: check the phone. The message must name the repository, the block,
   the branch, and the exact command.
4. Walk back to the terminal, `/tron-clu approve <block>`, and confirm the landing check runs
   before the block is called done.

What this proves that a test cannot: that the message is *legible on a phone*, and that
nothing about the park invites resolution from there.

### The operator-away drill

Park a mandate and leave it overnight. The next morning: the lock is stale, `unlock` says so,
`/tron-clu status` still shows exactly where it stopped, and the pending merge is still
pending. Nothing decided anything in the dark.

## What a run costs

Every seat's usage comes from Pi's own stream — `usage.totalTokens` and `usage.cost` on each
assistant message — and folds into the journal as spend. `/tron-clu status` shows it:

```
spent: 27 turns · 412,000 tokens · $1.83
```

The caps are wall-clock and turns, not money, because those are the two a driver can enforce
without guessing a price list. The cost line is the honest report of what the enforced caps
actually cost, and it is per mandate, not per block.

A token budget is *possible* — `usage` is a required field and was populated in the live P0
probe — and is deliberately not implemented in v1. Two enforced caps that never surprise
anyone beat three where one depends on a provider's billing metadata being right.
