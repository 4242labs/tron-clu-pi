import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * The shipped adapter is a contract with the memory engine, so it is checked like one. The
 * engine validates it at load — this suite exists so a typo is caught here rather than in
 * front of an operator, and so the two rules that matter cannot be quietly relaxed.
 */
const adapter = JSON.parse(
  readFileSync(join(process.cwd(), "adapters", "clu.adapter.json"), "utf8"),
) as Record<string, never>;

const spec = adapter as unknown as {
  name: string;
  identity_keys: string[];
  documents: Record<string, { sections: string[] }>;
  prefix_sections: { name: string; document: string; priority: number }[];
  collections: Record<string, { kind: string; identity_key: string }>;
  required_members: Record<string, string[]>;
  ordered_scales: Record<string, string[]>;
  ordered_scale_steps: Record<string, number>;
  schema: Record<string, { type: string; enum?: string[] }>;
  distillation_prompt: string;
};

test("every prefix section belongs to a document that declares it", () => {
  for (const section of spec.prefix_sections) {
    const document = spec.documents[section.document];
    assert.ok(document, `${section.name} names a document that does not exist`);
    assert.ok(
      document.sections.includes(section.name),
      `${section.document} does not declare ${section.name}`,
    );
  }
});

test("every declared list keys off one of the adapter's identity keys", () => {
  for (const [name, collection] of Object.entries(spec.collections)) {
    assert.equal(collection.kind, "list", name);
    assert.ok(
      spec.identity_keys.includes(collection.identity_key),
      `${name} keys off ${collection.identity_key}, which the floor could not address`,
    );
  }
});

test("the operator merges — and memory cannot forget it", () => {
  assert.ok(
    spec.required_members.practice?.includes("the-operator-merges"),
    "a consolidation that drops this rule must be refused by the gates, not by good manners",
  );
  assert.ok(spec.collections.practice, "required_members only bites on a declared collection");
});

test("the operator's appetite for review moves one step at a time, never in a leap", () => {
  assert.deepEqual(spec.ordered_scales["operator.review_appetite"], ["low", "medium", "high"]);
  assert.equal(spec.ordered_scale_steps["operator.review_appetite"], 1);
  assert.ok(
    Object.values(spec.ordered_scale_steps).every((step) => step <= 1),
    "the engine refuses a step above 1 at load; the spec must not ask for one",
  );
});

test("merge style is constrained to the strategies the driver actually implements", () => {
  assert.deepEqual(spec.schema["operator.merge_style"]?.enum, [
    "pr",
    "squash",
    "merge-commit",
    "rebase",
  ]);
});

test("the distillation prompt forbids what must never enter the store", () => {
  const prompt = spec.distillation_prompt;
  assert.match(prompt, /Never record a credential/);
  assert.match(prompt, /block ids|branch names|session ids/);
  assert.match(prompt, /still be true next week/);
});

test("the adapter tightens and declares — it never reaches for code", () => {
  assert.equal(
    JSON.stringify(adapter).includes("module:"),
    false,
    "agent consumers declare adapters by file",
  );
  for (const key of Object.keys(adapter)) {
    assert.ok(
      [
        "name",
        "prefix_budget_tokens",
        "recall_limit",
        "recall_budget_tokens",
        "identity_keys",
        "documents",
        "prefix_sections",
        "schema",
        "entry_schema",
        "ordered_scales",
        "ordered_scale_steps",
        "required_members",
        "collections",
        "retention",
        "distillation_prompt",
      ].includes(key),
      `${key} is not a key the engine accepts — unknown keys are refused at load, never ignored`,
    );
  }
});
