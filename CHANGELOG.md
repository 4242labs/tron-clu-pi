# Changelog

## [0.2.0](https://github.com/4242labs/tron-clu-pi/compare/pi-tron-clu-v0.1.1...pi-tron-clu-v0.2.0) (2026-08-20)


### Features

* answers that do something, and the law written down ([#4](https://github.com/4242labs/tron-clu-pi/issues/4)) ([d95e30a](https://github.com/4242labs/tron-clu-pi/commit/d95e30a79fc40f95b06231a1908d5bbb56a8f296))
* real seats — child `pi` processes, personas, custody, and caps ([#3](https://github.com/4242labs/tron-clu-pi/issues/3)) ([69bf863](https://github.com/4242labs/tron-clu-pi/commit/69bf8632bc55244f4b0265432511140ebf2fea8e))
* the CLU memory adapter, and a gate on what ships ([#5](https://github.com/4242labs/tron-clu-pi/issues/5)) ([f727fee](https://github.com/4242labs/tron-clu-pi/commit/f727feeacf16dd7fd75a482585022c87d508c910))
* the line to an operator who is not at the terminal, and the drills ([#6](https://github.com/4242labs/tron-clu-pi/issues/6)) ([74ba3b6](https://github.com/4242labs/tron-clu-pi/commit/74ba3b625c6a9eff21363cefd999210e2bb850c5))
* the P1 driver — mandate, gates, lock, journal, and a parked merge ([#2](https://github.com/4242labs/tron-clu-pi/issues/2)) ([32fcd03](https://github.com/4242labs/tron-clu-pi/commit/32fcd033024a941a6cf08fadcba4839aa17e061b))

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
