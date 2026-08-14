# pi-tron-clu

TRON-CLU for [Pi](https://github.com/earendil-works/pi-mono) — a supervisor extension that
drives a fleet of Pi seats through a build → review → merge pipeline, one block at a time,
without a human in the loop for the ordinary case.

> **Status: experimental.** The scaffold and the verified Pi API contract are in place; the
> driver is under construction. Not yet usable.

## What it does

You give CLU a pipeline. It runs each block through a fixed phase graph — an engineer seat
builds, a reviewer seat reviews, the gates run in a driver-owned verification worktree, the
merge happens — and it escalates to you only when a wall it cannot clear shows up.

Seats are child `pi` processes with their own session, their own tool allowlist, and their
own worktree. The driver holds the state journal, the gates, and the escalations.

## Install

```bash
pi install npm:pi-tron-clu
```

Then `/clu` in a Pi session.

## Requirements

- pi **0.84.1** or later (the verified baseline — see [docs/pi-api.md](docs/pi-api.md))
- git 2.5+ (worktrees)

## License

Apache-2.0 — see [LICENSE](LICENSE).
