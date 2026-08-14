# Containerised seats — evaluated, and deferred

**Decision for v1: not adopted.** The reasoning and the cost of that decision are below, so
the next person to ask does not have to re-derive it — and so nobody mistakes the deferral
for a judgement that the risk is small.

## The risk it would address

A worker seat has `bash`. `bash` reaches the network, the filesystem outside its worktree,
the operator's shell profile, and every credential the operator's environment happens to
carry. The tool allowlist decides *which tools* a seat has; it does not sandbox what one of
those tools can then do.

Concretely, in v1, a worker seat can:

- read anything the operator's user can read, including `~/.ssh`, `~/.npmrc`, `.env` files in
  other projects;
- make arbitrary outbound network requests — exfiltration is a `curl` away;
- install packages, and run whatever those packages run at install time.

The deny extension stops a seat from *landing* work. It does nothing about any of the above,
and was never meant to.

## What containerisation would buy

| Control | With a container | Today |
|:--|:--|:--|
| Filesystem | only the block worktree is mounted | the whole user account is readable |
| Network | egress denied by default, allowlisted per project | unrestricted |
| Credentials | none injected unless declared | whatever is in the environment |
| Blast radius of a bad package | the container | the machine |

## Why it is not in v1

1. **The seat is a `pi` process, and `pi` is the operator's install.** Containerising the
   seat means containerising Pi — its model credentials, its session directory, its
   extension resolution, its `--session-id` continuity across a retry. Every one of those is
   a surface P0 verified *on this machine*, and none of it has been verified inside a
   container. Shipping it unverified would trade a named risk for an unnamed one.
2. **The credential problem does not go away, it moves.** A seat still needs a model API key.
   Passing it into the container is a decision about credential scope that belongs to the
   operator, not to a default.
3. **Cost against the actual v1 use.** v1 runs against a private sandbox repository, with
   one mandate at a time, with a human reading every review before anything lands. The
   window a container would close is the window between a seat doing something hostile and
   an operator noticing — and in v1 that window is short and watched.

## The condition for adopting it

Not "when there is time". Specifically:

- **Any run against a repository the operator would mind losing** — the pilot's sandbox-only
  rule is what makes v1 safe, and it expires the moment CLU is pointed at real work.
- **Any unattended run.** A container is the substitute for a person watching, so the moment
  nobody is watching, the container is no longer optional.
- **Any third-party mandate** — blocks the operator did not write.

## The shape it would take

Recorded so the evaluation is not repeated from scratch:

- one container per block, image pinned by digest, `--network=none` by default;
- the block worktree bind-mounted, nothing else;
- `pi` and its model credential injected at run time, scoped to one provider and one model;
- gates run in the driver's verification worktree **outside** the container, as they do now —
  the gates are the driver's instrument and a seat should not be able to reach them at all;
- egress, where a project needs it, as an explicit allowlist in `.pi/tron-clu.json` — the
  same file that already says what may be run.

## Until then

The risk is named in [law.md](law.md) and here, the pilot is sandbox-only, and this document
is the answer to "why isn't this sandboxed?" — which is: it should be, before v1 is pointed
at anything that matters.
