# The CLU memory adapter

What a supervisor is allowed to remember, and — more to the point — what it is not.

MEMENTO's scope in CLU is **the host session only**. The operator's session has memory;
seats do not. A seat gets a block, a worktree, and a tool allowlist, and it gets them fresh
every time. Nothing a worker learned in block three is carried into block four, because a
seat that accumulates is a seat whose behaviour stops being a function of its brief.

## The adapter

[`adapters/clu.adapter.json`](../adapters/clu.adapter.json) — declared to the engine with
`--adapter-file`, never `--adapter module:attribute`. Agent consumers do not load code.

Two documents, five sections:

| Document | Section | Holds |
|:--|:--|:--|
| `operator.md` | `operator` | how this operator wants work landed and reviewed |
| | `practice` | standing practice, as an identified list |
| `project.md` | `project` | what this project is, in a sentence or two |
| | `gates` | which gates this project actually enforces, and why |
| | `hazards` | what cost a block last time |

`practice`, `gates` and `hazards` are **lists** with `topic` as their identity key, so a
consolidation edits a member rather than rewriting the section — and the anti-erosion floor
can address what it is protecting.

## What it tightens

An adapter may make the gates stricter and can never make them looser. This one:

- **`schema` enums and patterns** — `merge_style` is one of the four strategies the driver
  actually implements; `default_branch` is a branch-shaped string.
- **`ordered_scale_steps: 1`** on `review_appetite` — a scale that can only move one step per
  consolidation. The operator's appetite for review does not go from `low` to `high` because
  one mandate went badly.
- **`required_members`** — `practice` must always carry `the-operator-merges`. That one
  survives even a tombstone: if a consolidation ever proposes dropping the rule that the
  operator merges, the gates refuse it. The law is not a preference the memory can forget.

## What must never enter the store

The distillation prompt says it, and the engine's secret gate enforces the worst of it:

- **Credentials of any shape.** Exit 4 is never retried in any form.
- **Block ids, branch names, session ids, PR numbers.** `git log` answers those better and
  they are stale within a day. Memory is for what is still true next week.
- **Paths outside this project.** A store lives beside the project it is about.

## What CLU journals

Only at the milestones a supervisor actually has:

| Moment | Journalled |
|:--|:--|
| a merge park | that a block reached review, and what the reviewer said in a sentence |
| an operator ruling | approved or rejected, and the reason they gave |
| an escalation answered | which limit they raised, and for which kind of block |
| a mandate ending | how many blocks landed, and what stopped the rest |

Not journalled: every turn, every gate run, every phase transition. The session journal
already holds those, and consolidating noise produces memory made of noise.

## Linkage

pi-tron-clu consumes `@4242labs/pi-memento` as a **library** — the same package, imported
directly, in the host session's process. Not a subprocess, not a second extension, not a
copy of the loop.

Declared in `package.json` as of 2026-08-14, when `@4242labs/pi-memento@0.1.0` was
published. Until then it was documented and deliberately undeclared: an unpublishable
dependency breaks `npm ci` for everyone, CI included.
