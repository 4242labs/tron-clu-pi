# Publishing

Two acts, and they are not the same one: **npm publication**, and **appearing in Pi's package
gallery**. What follows is what was verified about each, and the checklist that runs at every
publish.

## How Pi lists packages — verified 2026-08-14

The gallery at **<https://pi.dev/packages>** lists "extensions, skills, prompt templates, and
themes published to npm", installed with `pi install npm:<package>`.

- **Discovery is automatic.** The gallery displays packages tagged with the `pi-package`
  keyword; it indexes npm rather than accepting submissions.
- **There is no submission form, review queue, or approval step** documented — not on the
  gallery page, not in `packages.md`.
- **The listing shows** description, author, repository and npm links, monthly downloads, and
  publication time. There is a report control for problems.
- **Previews are optional:** `pi.image` (PNG/JPEG/GIF/WebP) or `pi.video` (MP4) in the
  manifest; video wins if both are present.

So "publishing on the Pi website" is not a separate destination. It is: publish to npm with
the right keyword, then confirm the listing appeared and reads correctly. The confirmation is
the part worth a human — it is the first thing anyone will see of this project.

Sources: [pi.dev/packages](https://pi.dev/packages),
[packages.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).

## What ships

Pi packages ship **TypeScript source, not a build** — Pi loads `.ts` directly. The manifest
declares the entry points:

```json
{
  "keywords": ["pi-package", "pi-extension"],
  "files": ["src", "adapters", "README.md", "LICENSE"],
  "pi": { "extensions": ["./src/index.ts"] }
}
```

`npm run pack:check` opens the tarball before the registry does. Source, adapters, licence,
readme, manifest — anything else fails the gate. It runs in CI on every pull request, and it
is not optional at publish time: a store path, a scratch file, or a `.env` reaching a
registry is not recoverable by unpublishing.

## The names

Both packages are scoped to **`@4242labs`** — `@4242labs/pi-memento` and
`@4242labs/pi-tron-clu`. `pi-memento` unscoped was taken by an unrelated package; scoping
both keeps one namespace for the family rather than leaving half of it to chance
(operator's call, 2026-08-14, superseding the earlier "unscoped unless taken" ruling).

## The order

`@4242labs/pi-memento` is published **first**. `@4242labs/pi-tron-clu` consumes it as a
library, and a package whose dependency does not exist is a package nobody can install.

## Checklist

Per package, in order:

1. `npm run check && npm run typecheck && npm test` — green.
2. `npm run pack:check` — the tarball contains what it should and nothing else.
3. `npm version <patch|minor>` and push the tag.
4. `npm publish --provenance --access public` (the release workflow does this with
   `NPM_TOKEN`; provenance ties the artefact to the workflow run that built it).
5. `pi install npm:<name>` into a scratch project, and run the command once. An extension
   that installs but does not register its command is a broken publish that npm will happily
   host.
6. Check <https://pi.dev/packages> for the listing: name, description, author, repository
   link, and that the description reads like something a stranger would understand.

## Release checklist state

Both packages are published as of 2026-08-14. Future releases go through the same gates and
the same order, and should run from CI with `NPM_TOKEN` so the artefact carries provenance.
