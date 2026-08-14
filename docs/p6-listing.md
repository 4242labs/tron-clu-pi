# P6 — the listing, prepared

**This phase is run with the operator present. Nothing here is executed autonomously.**

Everything that could be done ahead of them is done, and is written out below so the session
itself is short: install, publish, confirm, in that order, with a person reading the result.

## Already verified, dark

| Check | Result |
|:--|:--|
| Both packages install from a local path (`pi install ./path -l`) | ✅ |
| Both register their command in a live session — `tron-clu`, `memento` | ✅ verified by probing `pi.getCommands()` inside a real `pi -p` run |
| Tarball contents | ✅ `npm run pack:check` in both repos: source, adapters, licence, readme, manifest, nothing else |
| Manifest shape for the gallery | ✅ `keywords` carries `pi-package`, `pi.extensions` names the entry point |
| Gallery route | ✅ <https://pi.dev/packages> indexes npm on the `pi-package` keyword. **No submission step exists** — see [publishing.md](publishing.md) |

### One thing to know before the session

This machine already has a **TRON-CLU mode skill** registered as
`skill:source-command-tron-clu`. It does not collide with the extension's `/tron-clu`, and
the probe confirms both coexist. If it ever registers as plain `tron-clu`, the extension
**refuses to run** and says so — that check is deliberate, and this is the environment where
it would fire first.

## What the operator does, in order

Everything below needs their credentials or their judgement. That is the whole reason this
phase waits.

### 1. Unblock (theirs alone)

- `npm login` on this machine — currently `ENEEDAUTH`.
- Create the **`4242labs` npm org** — `@4242labs/pi-memento` cannot publish without it.
  (`pi-memento` unscoped is taken by an unrelated package; both packages are scoped to keep one namespace.)
- Add `NPM_TOKEN` as a repository secret in both repos, for the release workflow.
- Decide whether the repos go **public**. The gallery shows a repository link, and
  `pi install git:…` needs one. A private repo means a listing that points at a 404.

### 2. Publish, in this order

`@4242labs/pi-memento` first — pi-tron-clu consumes it, and a package whose dependency does
not exist is a package nobody can install.

```bash
# in memento-pi
npm run check && npm run typecheck && npm test && npm run pack:check
npm publish --provenance --access public

# then in tron-clu-pi
npm run check && npm run typecheck && npm test && npm run pack:check
npm publish --provenance --access public
```

Or by release tag, if the release workflow is preferred — same gates, same order.

### 3. Wire the dependency that was parked

Once `@4242labs/pi-memento` exists on npm, pi-tron-clu declares it and the library linkage
in [memento-adapter.md](memento-adapter.md) stops being a document and starts being an
import. This is a one-line PR held deliberately: declaring an unpublishable dependency would
break `npm ci` for everyone, including CI.

### 4. Confirm the listing — the part worth a human

Install each from npm into a scratch project and run the command once:

```bash
mkdir /tmp/listing-check && cd /tmp/listing-check && git init
pi install npm:@4242labs/pi-memento -l --approve
pi install npm:@4242labs/pi-tron-clu -l --approve
pi   # then: /tron-clu status, /memento status
```

Then open <https://pi.dev/packages> and read the entries as a stranger would:

- Does the **description** say what it does, in one line, without jargon?
- Is the **author** right, and the **repository link** live?
- Is `experimental` visible? Both declare `piExtension.lifecycle: "experimental"`, and that
  is the honest state — the driver has run one three-block pilot, on a sandbox.
- Optional: a `pi.image` or `pi.video` preview. Neither package has one. A short capture of
  a merge park arriving and being approved would be the single most useful thing to show,
  and it needs the operator's screen, not mine.

### 5. Say what it is

The gallery entry is the first thing anyone will see of this project. Current descriptions:

- **@4242labs/pi-tron-clu** — "TRON-CLU for Pi — a supervisor extension that drives a fleet of Pi seats
  through a build/review/merge pipeline."
- **@4242labs/pi-memento** — "MEMENTO for Pi — persistent memory for a Pi session: recall at
  start, journal as you go, consolidate on exit."

Both are accurate. Whether they are *inviting* is a judgement, and it is the operator's.

## What must not be claimed in the listing

Stated here so it is not written in a hurry on the day:

- Not "production ready". One pilot, three blocks, one sandbox repository.
- Not "sandboxed seats". Seats are **not** contained in v1 — see
  [containerization.md](containerization.md).
- Not "prevents a rogue agent from merging". The tool allowlist and the parked merge do the
  work; the deny patterns are bypassable and [law.md](law.md) says exactly how.
