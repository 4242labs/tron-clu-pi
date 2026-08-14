import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  BlockError,
  blockFileChanged,
  readMandate,
  snapshotBlock,
  validateBlock,
} from "../src/block.ts";
import { scratch } from "./helpers.ts";

const good = {
  id: "b1",
  task: "add a file",
  reviewerClass: "code",
  acceptance: [{ criterion: "the file exists", verify: "test -f added.txt" }],
};

test("a well-formed block validates", () => {
  const block = validateBlock(good, "x");
  assert.equal(block.id, "b1");
  assert.equal(block.acceptance.length, 1);
  assert.equal(block.branch, undefined);
});

test("fail-closed: every malformed shape is rejected", () => {
  const cases: [unknown, RegExp][] = [
    [null, /must be a JSON object/],
    [[], /must be a JSON object/],
    [{ ...good, extra: 1 }, /unknown field "extra"/],
    [{ ...good, id: "" }, /non-empty string/],
    [{ ...good, id: "has space" }, /must be \[A-Za-z0-9/],
    [{ ...good, task: "  " }, /non-empty string/],
    [{ ...good, reviewerClass: "vibes" }, /reviewerClass must be one of/],
    [{ ...good, branch: "" }, /branch, when present/],
    [{ ...good, acceptance: [] }, /non-empty array/],
    [
      { ...good, acceptance: [{ criterion: "c" }] },
      /verify must be a non-empty verification command/,
    ],
    [{ ...good, acceptance: [{ criterion: "c", verify: "t", note: "x" }] }, /unknown field "note"/],
    [
      { ...good, acceptance: [{ criterion: "", verify: "t" }] },
      /criterion must be a non-empty string/,
    ],
  ];
  for (const [raw, message] of cases) {
    assert.throws(
      () => validateBlock(raw, "x"),
      (e: unknown) => e instanceof BlockError && message.test((e as Error).message),
      `expected ${message} for ${JSON.stringify(raw)}`,
    );
  }
});

test("a criterion with no verify command is not a criterion", () => {
  assert.throws(
    () => validateBlock({ ...good, acceptance: [{ criterion: "looks nice", verify: "" }] }, "x"),
    /not a criterion/,
  );
});

test("snapshot freezes content and derives the branch", () => {
  const { path, cleanup } = scratch("block");
  try {
    const file = join(path, "b1.json");
    writeFileSync(file, JSON.stringify(good));
    const snap = snapshotBlock(file, "m1");
    assert.equal(snap.resolvedBranch, "clu/m1-b1");
    assert.equal(blockFileChanged(snap), false);

    writeFileSync(file, JSON.stringify({ ...good, task: "something else" }));
    assert.equal(blockFileChanged(snap), true, "a disk edit after the snapshot is detected");
    assert.equal(snap.task, "add a file", "the snapshot itself never adopts the edit");
  } finally {
    cleanup();
  }
});

test("a missing block file counts as changed, never as unchanged", () => {
  const snap = {
    ...validateBlock(good, "x"),
    path: "/nope/gone.json",
    hash: "abc",
    resolvedBranch: "b",
  };
  assert.equal(blockFileChanged(snap), true);
});

test("an authored branch wins over the derived one", () => {
  const { path, cleanup } = scratch("block-branch");
  try {
    const file = join(path, "b1.json");
    writeFileSync(file, JSON.stringify({ ...good, branch: "feat/mine" }));
    assert.equal(snapshotBlock(file, "m1").resolvedBranch, "feat/mine");
  } finally {
    cleanup();
  }
});

test("mandate reading: both shapes, ordered, duplicates rejected", () => {
  const { path, cleanup } = scratch("mandate");
  try {
    writeFileSync(join(path, "a.json"), JSON.stringify({ ...good, id: "a" }));
    writeFileSync(join(path, "b.json"), JSON.stringify({ ...good, id: "b" }));
    writeFileSync(join(path, "dupe.json"), JSON.stringify({ ...good, id: "a" }));

    const arrayForm = join(path, "m-array.json");
    writeFileSync(arrayForm, JSON.stringify(["a.json", "b.json"]));
    assert.deepEqual(
      readMandate(arrayForm, "m1").map((b) => b.id),
      ["a", "b"],
    );

    const objectForm = join(path, "m-object.json");
    writeFileSync(objectForm, JSON.stringify({ blocks: ["b.json", "a.json"] }));
    assert.deepEqual(
      readMandate(objectForm, "m1").map((b) => b.id),
      ["b", "a"],
    );

    const dupes = join(path, "m-dupes.json");
    writeFileSync(dupes, JSON.stringify(["a.json", "dupe.json"]));
    assert.throws(() => readMandate(dupes, "m1"), /duplicate block id "a"/);

    const empty = join(path, "m-empty.json");
    writeFileSync(empty, JSON.stringify([]));
    assert.throws(() => readMandate(empty, "m1"), /names no blocks/);

    const junk = join(path, "m-junk.json");
    writeFileSync(junk, "{not json");
    assert.throws(() => readMandate(junk, "m1"), /not valid JSON/);
  } finally {
    cleanup();
  }
});
