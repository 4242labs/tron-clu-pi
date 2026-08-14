import assert from "node:assert/strict";
import { test } from "node:test";
import { LOCK_EXEMPT, parseCommand, TUI_ONLY } from "../src/commands.ts";

test("bare and unknown-free forms parse to their subcommand", () => {
  assert.deepEqual(parseCommand(""), { kind: "status" });
  assert.deepEqual(parseCommand("   "), { kind: "status" });
  assert.deepEqual(parseCommand("status"), { kind: "status" });
  assert.deepEqual(parseCommand("abort"), { kind: "abort" });
  assert.deepEqual(parseCommand("unlock"), { kind: "unlock" });
  assert.deepEqual(parseCommand("init --force"), { kind: "init", args: ["--force"] });
});

test("approve needs a block id", () => {
  assert.deepEqual(parseCommand("approve b1"), { kind: "approve", blockId: "b1" });
  assert.equal(parseCommand("approve").kind, "error");
});

test("a rejection without a reason is not reviewable", () => {
  assert.deepEqual(parseCommand("reject b1 gates are green but the fix is wrong"), {
    kind: "reject",
    blockId: "b1",
    reason: "gates are green but the fix is wrong",
  });
  const bare = parseCommand("reject b1");
  assert.equal(bare.kind, "error");
  assert.match(bare.kind === "error" ? bare.message : "", /not reviewable/);
});

test("answer needs both an item and a choice", () => {
  assert.deepEqual(parseCommand("answer a-1f2 abandon"), {
    kind: "answer",
    itemId: "a-1f2",
    choice: "abandon",
  });
  assert.equal(parseCommand("answer a-1f2").kind, "error");
});

test("anything else is a mandate path, whitespace-collapsed", () => {
  assert.deepEqual(parseCommand("  ./mandates/m1.json "), {
    kind: "mandate",
    path: "./mandates/m1.json",
  });
  assert.deepEqual(parseCommand("a/b.json"), { kind: "mandate", path: "a/b.json" });
});

test("starting a mandate and ruling on a merge are TUI-only", () => {
  for (const kind of ["mandate", "approve", "reject", "answer"])
    assert.ok(TUI_ONLY.has(kind), kind);
  for (const kind of ["status", "init", "abort", "unlock"])
    assert.equal(TUI_ONLY.has(kind), false, kind);
});

test("every subcommand except starting a mandate answers without the lock", () => {
  const all = ["status", "init", "abort", "unlock", "approve", "reject", "answer", "mandate"];
  assert.deepEqual(
    all.filter((k) => !LOCK_EXEMPT.has(k)),
    ["mandate"],
  );
});
