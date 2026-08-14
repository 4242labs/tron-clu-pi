import assert from "node:assert/strict";
import { test } from "node:test";
import { REVIEWER_TOOLS } from "../src/personas.ts";
import { seatArgs } from "../src/pi-seats.ts";
import extension, { deniedReason } from "../src/seat-deny.ts";

/**
 * The negative law suite: every way a seat might try to land work itself. What the patterns
 * catch is asserted here; what they cannot catch is asserted here too, so the residual risk
 * is a test result rather than a claim in a document.
 */

const DIRECT = [
  "git merge main",
  "git merge --no-ff origin/main",
  "git -C /repo merge main",
  "git --git-dir=/repo/.git --work-tree=/repo merge main",
  "git rebase main",
  "git rebase --onto main HEAD~2",
  "git push",
  "git push origin HEAD:main",
  "git push --force-with-lease origin my-branch",
  "git cherry-pick deadbeef",
];

const VIA_GH = [
  "gh pr merge 42",
  "gh pr merge --squash --admin",
  "gh pr create --fill",
  "gh pr ready 42",
  "gh api -X PUT repos/o/r/pulls/42/merge",
  "gh api --method PUT repos/o/r/pulls/42/merge -f merge_method=squash",
];

const VIA_CONFIG = [
  "git config alias.land '!git push origin HEAD:main'",
  "git config --global alias.yolo '!gh pr merge'",
  "git remote set-url origin git@elsewhere:me/repo.git",
  "git remote add mine git@elsewhere:me/repo.git",
];

test("direct git landing is denied in every spelling", () => {
  for (const command of DIRECT) assert.ok(deniedReason(command), command);
});

test("landing through gh is denied, including the raw API call", () => {
  for (const command of VIA_GH) assert.ok(deniedReason(command), command);
});

test("rewriting the tooling to land later is denied", () => {
  for (const command of VIA_CONFIG) assert.ok(deniedReason(command), command);
});

test("ordinary work is not denied — the deny is a lock, not a wall", () => {
  const allowed = [
    "git status",
    "git add -A",
    "git commit -m 'fix the retry'",
    "git diff main...HEAD",
    "git log --oneline -20",
    "git worktree list",
    "npm test",
    "npm run lint",
    "gh pr view 42 --json state",
    "gh run list --limit 5",
  ];
  for (const command of allowed) assert.equal(deniedReason(command), undefined, command);
});

test("the handler blocks both tool input shapes, and passes everything else through", async () => {
  const handlers: Record<string, (e: unknown) => Promise<unknown>> = {};
  extension({
    on: (event: string, handler: (e: unknown) => Promise<unknown>) => {
      handlers[event] = handler;
    },
  } as never);
  const call = handlers.tool_call;
  assert.ok(call, "the extension registers a tool_call handler");

  const blocked = (await call({ input: { command: "git push origin main" } })) as {
    block?: boolean;
  };
  assert.equal(blocked?.block, true);
  const blockedAlt = (await call({ input: { cmd: "gh pr merge 1" } })) as { block?: boolean };
  assert.equal(blockedAlt?.block, true, "a tool that names its argument `cmd` is read too");

  assert.equal(await call({ input: { command: "npm test" } }), undefined);
  assert.equal(
    await call({ input: { path: "src/index.ts" } }),
    undefined,
    "a read is not a command",
  );
  assert.equal(await call({}), undefined);
});

test("the block's reason names the policy, so the seat learns what it may not do", () => {
  const reason = deniedReason("git push origin main") ?? "";
  assert.match(reason, /tron-clu seat policy/);
  assert.match(reason, /seats never merge, push, or rewrite remotes/);
});

/**
 * Known-bypassable, on purpose. These are the shapes pattern matching cannot see; they are
 * asserted so the limitation is measured rather than assumed, and so the day someone claims
 * the deny is a guarantee, this test says otherwise.
 */
test("a denied command is caught even when it is quoted inside another command", () => {
  assert.ok(deniedReason("node -e \"require('child_process').execSync('git push')\""));
  assert.ok(deniedReason("bash -c 'git merge main'"));
  assert.ok(deniedReason("echo 'running git push now' && sh -c 'git push'"));
});

test("what the deny cannot catch is exactly what the other two controls are for", () => {
  const undetected = [
    "sh ./scripts/land.sh",
    "g=merge; git $g main",
    "echo Z2l0IHB1c2g= | base64 -d | sh",
    "node -e \"require('child_process').execSync(['git','pu'+'sh'].join(' '))\"",
    "git update-ref refs/heads/main HEAD",
  ];
  for (const command of undetected) {
    assert.equal(
      deniedReason(command),
      undefined,
      `${command} is expected to slip the pattern — if it now matches, tighten docs/law.md, not this test`,
    );
  }
});

test("a reviewer has no write capability at all — an absence, not a policy", () => {
  const args = seatArgs({
    piBinary: "pi",
    denyExtension: "/d.ts",
    model: "m",
    tools: REVIEWER_TOOLS,
    cwd: "/w",
    prompt: "review",
    sessionId: "s",
    resume: false,
    turnCap: 10,
  });
  const allowlist = args[args.indexOf("-t") + 1];
  assert.equal(allowlist, "read,bash");
  for (const tool of ["write", "edit"]) assert.equal(allowlist?.includes(tool), false, tool);
});

test("every seat is spawned with the deny extension and without discovered ones", () => {
  const args = seatArgs({
    piBinary: "pi",
    denyExtension: "/pkg/src/seat-deny.ts",
    model: "m",
    tools: ["read", "bash"],
    cwd: "/w",
    prompt: "go",
    sessionId: "s",
    resume: false,
    turnCap: 10,
  });
  assert.equal(args[args.indexOf("-e") + 1], "/pkg/src/seat-deny.ts");
  assert.ok(
    args.includes("-ne"),
    "no discovered extensions — a seat never inherits the operator's",
  );
  assert.ok(args.includes("-ns"), "no discovered skills either");
});
