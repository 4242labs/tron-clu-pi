# Contributing

> [!IMPORTANT]
> **Experimental, and moving.** This extension supervises a fleet of coding agents against
> real repositories. Its interfaces — block schema, journal entries, gate config — are not
> stable yet, and a change that breaks yours may land without a major version while it says
> `lifecycle: experimental`.

Issues are welcome, especially ones that show a way a seat could land work without an
operator's ruling. Pull requests are read, but expect the design questions in
[docs/law.md](docs/law.md) to be applied to them.

## The one rule

**A seat never lands work.** Every change is measured against that. If a patch makes it
easier for an agent to merge, push, or rewrite a remote without a human ruling — however
convenient — it does not land here.

## Working on it

```bash
npm ci
npm run check      # biome
npm run typecheck  # tsc
npm test           # the suite: 130+ tests, real git repositories, real child processes
npm run pack:check # what would ship to npm
```

The tests are not mocks. They drive real `git` worktrees, real child processes, and a
stand-in `pi` that speaks the JSON stream. A test that passes on a mock and fails on a
process is the kind of test this project exists to avoid.

## Branches and commits

- **Work in a worktree**, never on the checkout of the integration branch. The repo's
  `.githooks/pre-commit` enforces it — `.repo-class` and `.integration-branch` at the root
  say which branch is protected.
- **Conventional Commits.** `release-please` builds the changelog and the version bump from
  the history, so `feat:` / `fix:` / `chore:` are load-bearing, not decoration.
- **Every change lands through a pull request** with CI green.

## What a good change looks like

- It names what it is protecting against, not just what it adds.
- It leaves a test that fails if the behaviour regresses — see [docs/drills.md](docs/drills.md),
  where every failure this design claims to survive is mapped to the test that proves it.
- It does not weaken a gate to make a test pass.
- It says what it does **not** cover. Half the value of this codebase's documentation is the
  paragraphs about where a control stops working.
