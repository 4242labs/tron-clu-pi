import assert from "node:assert/strict";
import { test } from "node:test";
import { deniedReason } from "../src/seat-deny.ts";
import {
  parseSeatPayload,
  SeatOutputError,
  validateReviewerResult,
  validateWorkerResult,
} from "../src/seats.ts";

test("the seat's last fenced JSON is the payload, prose around it is ignored", () => {
  const text = [
    "I looked at the failing test.",
    "```json",
    '{"status":"BLOCKED","evidence":"first thought"}',
    "```",
    "On reflection:",
    "```json",
    '{"status":"DONE","evidence":"tests pass"}',
    "```",
    "Done!",
  ].join("\n");
  assert.deepEqual(parseSeatPayload(text), { status: "DONE", evidence: "tests pass" });
});

test("an unfenced payload still parses; prose alone does not", () => {
  assert.deepEqual(parseSeatPayload('result: {"verdict":"APPROVED","evidence":"ok"}'), {
    verdict: "APPROVED",
    evidence: "ok",
  });
  assert.throws(
    () => parseSeatPayload("I finished the work, everything is fine."),
    SeatOutputError,
  );
  assert.throws(() => parseSeatPayload("```json\n{ nope\n```"), SeatOutputError);
});

test("a worker's word is DONE or BLOCKED with evidence, or it is an error", () => {
  assert.deepEqual(validateWorkerResult({ status: "DONE", evidence: "e" }), {
    status: "DONE",
    evidence: "e",
  });
  assert.throws(() => validateWorkerResult({ status: "done", evidence: "e" }), /DONE" or "BLOCKED/);
  assert.throws(
    () => validateWorkerResult({ status: "DONE", evidence: "  " }),
    /non-empty evidence/,
  );
  assert.throws(() => validateWorkerResult(undefined), SeatOutputError);
});

test("a reviewer's verdict is APPROVED or REJECTED with evidence", () => {
  assert.deepEqual(validateReviewerResult({ verdict: "REJECTED", evidence: "e" }), {
    verdict: "REJECTED",
    evidence: "e",
  });
  assert.throws(
    () => validateReviewerResult({ verdict: "LGTM", evidence: "e" }),
    /APPROVED" or "REJECTED/,
  );
  assert.throws(() => validateReviewerResult({ verdict: "APPROVED" }), /non-empty evidence/);
});

test("no seat has a path to a merge, a push, or a rewritten remote", () => {
  const denied = [
    "git merge main",
    "git -C /repo merge --no-ff main",
    "git --git-dir=/repo/.git rebase main",
    "git push origin HEAD",
    "git push -u origin my-branch",
    "git cherry-pick abc123",
    "gh pr merge 12 --squash",
    "gh pr create --fill",
    "gh pr ready 12",
    "gh api -X PUT repos/o/r/pulls/1/merge",
    "git config alias.yolo '!gh pr merge'",
    "git remote set-url origin git@evil:x.git",
    "git remote add mirror git@evil:x.git",
  ];
  for (const command of denied) assert.ok(deniedReason(command), `should be denied: ${command}`);

  const allowed = [
    "git status",
    "git add -A",
    "git commit -m 'work'",
    "git log --oneline -5",
    "git diff main...HEAD",
    "npm test",
    "gh pr view 12 --json state",
    "echo 'git merge is not run here'".replace("git merge", "git-merge"),
  ];
  for (const command of allowed)
    assert.equal(deniedReason(command), undefined, `should be allowed: ${command}`);
});
