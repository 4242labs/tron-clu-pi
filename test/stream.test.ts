import assert from "node:assert/strict";
import { test } from "node:test";
import { consumeLine, drain, emptyStream, finalMessage } from "../src/stream.ts";

const line = (o: unknown) => JSON.stringify(o);

test("the session header gives the seat's own session id", () => {
  const s = consumeLine(
    emptyStream(),
    line({ type: "session", version: 3, id: "abc-123", cwd: "/x" }),
  );
  assert.equal(s.sessionId, "abc-123");
});

test("assistant messages accumulate, newest last, and the last one is the seat's word", () => {
  let s = emptyStream();
  s = consumeLine(
    s,
    line({ type: "message_end", message: { role: "assistant", content: "thinking" } }),
  );
  s = consumeLine(s, line({ type: "message_end", message: { role: "user", content: "ignored" } }));
  s = consumeLine(
    s,
    line({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "final" }] },
    }),
  );
  assert.deepEqual(s.assistant, ["thinking", "final"]);
  assert.equal(finalMessage(s), "final");
  assert.equal(s.usage.turns, 2, "only assistant messages are turns");
});

test("usage adds up across turns, in tokens and in money", () => {
  let s = emptyStream();
  const turn = (totalTokens: number, cost: number) =>
    line({
      type: "message_end",
      message: { role: "assistant", content: "x", usage: { totalTokens, cost } },
    });
  s = consumeLine(s, turn(100, 0.01));
  s = consumeLine(s, turn(250, 0.02));
  assert.equal(s.usage.tokens, 350);
  assert.ok(Math.abs(s.usage.cost - 0.03) < 1e-9);
});

test("a broken-down cost object is read the same as a number", () => {
  const s = consumeLine(
    emptyStream(),
    line({
      type: "message_end",
      message: {
        role: "assistant",
        content: "x",
        usage: { totalTokens: 10, cost: { total: 0.5, input: 0.2 } },
      },
    }),
  );
  assert.equal(s.usage.cost, 0.5);
});

test("agent_end is the fallback, never a second copy", () => {
  const agentEnd = line({
    type: "agent_end",
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: "from agent_end" },
    ],
  });
  const fallback = consumeLine(emptyStream(), agentEnd);
  assert.equal(finalMessage(fallback), "from agent_end");

  let both = consumeLine(
    emptyStream(),
    line({ type: "message_end", message: { role: "assistant", content: "real" } }),
  );
  both = consumeLine(both, agentEnd);
  assert.deepEqual(
    both.assistant,
    ["real"],
    "agent_end does not duplicate what message_end already carried",
  );
});

test("tool executions are counted, unknown and unparseable records are ignored", () => {
  let s = emptyStream();
  s = consumeLine(s, line({ type: "tool_execution_start", name: "bash" }));
  s = consumeLine(s, line({ type: "something_new_in_a_later_pi" }));
  s = consumeLine(s, "{ not json");
  s = consumeLine(s, "   ");
  assert.equal(s.toolCalls, 1);
  assert.equal(finalMessage(s), undefined);
});

test("drain yields complete lines and keeps the partial one for the next chunk", () => {
  const seen: string[] = [];
  const rest = drain('{"a":1}\n{"b":2}\n{"c":', (l) => seen.push(l));
  assert.deepEqual(seen, ['{"a":1}', '{"b":2}']);
  assert.equal(rest, '{"c":');
});
