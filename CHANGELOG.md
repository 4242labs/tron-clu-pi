# Changelog

## 0.1.1 (2026-08-14)

Nothing in the driver changed. This release exists because npm snapshots the README at
publish time, and the 0.1.0 page still showed a front door we had already fixed.

### Documentation

* the README opens with a terminal session — install, mandate, build, gates, review, and the
  run stopping on "awaiting your merge" until an operator types `approve`
* repo-lifecycle canon: status and maintenance badges, `LICENSING.md`, the contribution
  licence grant, issue templates
* no commercial-licence offer — Apache-2.0 already grants what one would sell
* no "experimental" banner; "pre-v1" plus the specific thing that is unfinished

## 0.1.0 (2026-08-14)

First release. Experimental: one three-block pilot on a private sandbox, and nothing else.

### Features

* the driver — mandate of frozen block snapshots, a phase graph that re-derives its position
  from the session journal, gates in a detached checkout of what was committed, a repo-wide
  lock with a heartbeat, and a merge that is a parked state no code path can clear
* real seats — child `pi` processes, one worker and one reviewer per block, each in its own
  worktree with its own tool allowlist; the reviewer has no way to write
* retry as continuation — a rejected block resumes the same seat session with the reviewer's
  words as its brief
* escalations with enumerated answers, each one a grant the operator makes by hand: raise the
  cap once, extend the budget once, terminate a seat, run the snapshot anyway, abandon, stop
* seat policy — merge, push, rebase, cherry-pick, `gh pr merge|create|ready`, alias
  definitions and remote rewrites blocked in the seat, including through global git options
* Telegram relay, out only: parks are announced, decisions stay at the terminal
* PID custody — seats journalled at spawn, orphans terminated on resume, and a recycled pid
  left alone
* spend accounting — turns, tokens and cost folded out of the journal into `/tron-clu status`
