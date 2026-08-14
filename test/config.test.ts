import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  ConfigError,
  configPathFor,
  loadGateConfig,
  saveGateConfig,
  validateGateConfig,
} from "../src/config.ts";
import type { ProjectGateConfig } from "../src/types.ts";
import { scratch } from "./helpers.ts";

const good: ProjectGateConfig = {
  version: 1,
  defaultGates: ["npm test"],
  classGates: { code: ["npm run lint"], data: [], security: ["npm audit"] },
  protectedPaths: [".github/workflows/**"],
  mergeStrategy: "pr",
  defaultBranch: "main",
  gateTimeoutSeconds: 600,
  piBinary: "/usr/local/bin/pi",
  piVersion: "0.84.1",
};

test("a complete config round-trips through disk", () => {
  const { path, cleanup } = scratch("config");
  try {
    const written = saveGateConfig(path, good);
    assert.equal(written, configPathFor(path));
    assert.deepEqual(loadGateConfig(path), good);
  } finally {
    cleanup();
  }
});

test("a project with no gates cannot be supervised", () => {
  assert.throws(
    () => validateGateConfig({ ...good, defaultGates: [] }),
    /fail-open does not exist/,
  );
});

test("fail-closed on every malformed field", () => {
  const cases: [unknown, RegExp][] = [
    [null, /must be an object/],
    [{ ...good, version: 2 }, /version must be 1/],
    [{ ...good, defaultGates: "npm test" }, /defaultGates must be an array of strings/],
    [{ ...good, classGates: null }, /classGates must be an object/],
    [
      { ...good, classGates: { ...good.classGates, code: [1] } },
      /classGates.code must be an array of strings/,
    ],
    [{ ...good, mergeStrategy: "yolo" }, /mergeStrategy must be one of/],
    [{ ...good, defaultBranch: "" }, /defaultBranch must be a non-empty string/],
    [{ ...good, gateTimeoutSeconds: 0 }, /gateTimeoutSeconds must be a positive number/],
    [{ ...good, gateTimeoutSeconds: "600" }, /gateTimeoutSeconds must be a positive number/],
    [{ ...good, piBinary: "" }, /piBinary must be a non-empty string/],
    [{ ...good, piVersion: undefined }, /piVersion must be a non-empty string/],
  ];
  for (const [raw, message] of cases) {
    assert.throws(
      () => validateGateConfig(raw),
      (e: unknown) => e instanceof ConfigError && message.test((e as Error).message),
      `expected ${message}`,
    );
  }
});

test("missing classes default to empty, protectedPaths defaults to none", () => {
  const parsed = validateGateConfig({
    ...good,
    classGates: { code: ["x"] },
    protectedPaths: undefined,
  });
  assert.deepEqual(parsed.classGates, { code: ["x"], data: [], security: [] });
  assert.deepEqual(parsed.protectedPaths, []);
});

test("an absent or unreadable config sends the operator to init, not to a default", () => {
  const { path, cleanup } = scratch("config-missing");
  try {
    assert.throws(() => loadGateConfig(path), /run \/tron-clu init first/);
    writeFileSync(configPathFor(saveGateConfig(path, good) && path), "{ truncated");
    assert.throws(() => loadGateConfig(path), ConfigError);
  } finally {
    cleanup();
  }
});

test("the config lives under .pi/ in the repo", () => {
  assert.equal(configPathFor("/repo"), join("/repo", ".pi", "tron-clu.json"));
});
