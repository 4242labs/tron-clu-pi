import assert from "node:assert/strict";
import { test } from "node:test";
import { REVIEWER_TOOLS, reviewerPrompt, WORKER_TOOLS, workerPrompt } from "../src/personas.ts";
import type { BlockSnapshot, ProjectGateConfig } from "../src/types.ts";

const block: BlockSnapshot = {
  id: "b1",
  task: "add the retry to the uploader",
  acceptance: [
    { criterion: "the uploader retries three times", verify: "npm test -- uploader" },
    { criterion: "no new dependency", verify: "git diff --exit-code main...HEAD -- package.json" },
  ],
  reviewerClass: "code",
  path: "/blocks/b1.json",
  hash: "h",
  resolvedBranch: "clu/m1-b1",
};

const gates: ProjectGateConfig = {
  version: 1,
  defaultGates: ["npm test"],
  classGates: { code: ["npm run lint"], data: [], security: ["npm audit"] },
  protectedPaths: ["test/**"],
  mergeStrategy: "pr",
  defaultBranch: "main",
  gateTimeoutSeconds: 600,
  piBinary: "/opt/homebrew/bin/pi",
  piVersion: "0.84.1",
};

test("a worker is told the task, every criterion, and the command that decides it", () => {
  const prompt = workerPrompt(block, gates);
  assert.match(prompt, /add the retry to the uploader/);
  for (const c of block.acceptance) {
    assert.ok(prompt.includes(c.criterion), c.criterion);
    assert.ok(prompt.includes(c.verify), c.verify);
  }
  assert.ok(prompt.includes("npm test"), "the default gates are stated up front");
  assert.ok(prompt.includes("npm run lint"), "so are the class gates it will be judged by");
  assert.match(prompt, /Commit your work/);
  assert.match(prompt, /cannot merge, push, rebase/);
  assert.match(prompt, /"status": "DONE" \| "BLOCKED"/);
  assert.doesNotMatch(prompt, /This is a retry/);
});

test("a retry carries the rejection as its brief", () => {
  const prompt = workerPrompt(
    block,
    gates,
    "the retry counts attempts wrong: 3 means 3 total, not 3 extra",
  );
  assert.match(prompt, /This is a retry/);
  assert.match(prompt, /3 means 3 total, not 3 extra/);
  assert.match(prompt, /Do not start over unless the feedback says to/);
});

test("a reviewer gets the evidence, the diff command, and the class it is reviewing for", () => {
  const prompt = reviewerPrompt(block, gates, "- `npm test` → exit 0 (project gate)", []);
  assert.match(prompt, /git diff main\.\.\.HEAD/);
  assert.match(prompt, /npm test` → exit 0/);
  assert.match(prompt, /Correctness first/);
  assert.match(prompt, /no edit tools/);
  assert.match(prompt, /Passing gates are necessary, not sufficient/);
  assert.match(prompt, /"verdict": "APPROVED" \| "REJECTED"/);
  assert.doesNotMatch(prompt, /protected paths/i);
});

test("touched protected paths are named to the reviewer, with why they matter", () => {
  const prompt = reviewerPrompt(block, gates, "- (none recorded)", [
    "test/uploader.test.ts",
    "package.json",
  ]);
  assert.match(prompt, /test\/uploader\.test\.ts/);
  assert.match(prompt, /package\.json/);
  assert.match(prompt, /Green gates prove less when the diff edits them/);
});

test("each reviewer class is pointed at what its class actually risks", () => {
  const data = reviewerPrompt({ ...block, reviewerClass: "data" }, gates, "-", []);
  assert.match(data, /schema, types, nullability/);
  const security = reviewerPrompt({ ...block, reviewerClass: "security" }, gates, "-", []);
  assert.match(security, /Trust boundaries/);
  assert.match(security, /Secrets in the diff|secrets in the diff/);
});

test("a reviewer has no way to write; a worker does", () => {
  assert.deepEqual(REVIEWER_TOOLS, ["read", "bash"]);
  for (const forbidden of ["write", "edit"]) {
    assert.equal(REVIEWER_TOOLS.includes(forbidden), false, `reviewers must not have ${forbidden}`);
  }
  assert.ok(
    WORKER_TOOLS.includes("write") &&
      WORKER_TOOLS.includes("edit") &&
      WORKER_TOOLS.includes("bash"),
  );
});
