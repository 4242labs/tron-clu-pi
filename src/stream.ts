/**
 * The JSON-mode stream, read defensively. Pi's `-p --mode json` emits one JSON object per
 * line; the driver reads only what P0 verified — `message_end` for the authoritative
 * message, `agent_end` as the fallback carrier — and ignores everything else rather than
 * failing on a record it has not seen before.
 */

export interface SeatUsage {
  turns: number;
  tokens: number;
  cost: number;
}

export interface StreamState {
  sessionId?: string;
  /** Assistant text, newest last. */
  assistant: string[];
  usage: SeatUsage;
  toolCalls: number;
}

export const emptyStream = (): StreamState => ({
  assistant: [],
  usage: { turns: 0, tokens: 0, cost: 0 },
  toolCalls: 0,
});

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const p = part as { type?: string; text?: unknown };
      return p?.type === "text" && typeof p.text === "string" ? p.text : "";
    })
    .filter((t) => t !== "")
    .join("\n");
};

const addUsage = (state: StreamState, usage: unknown): void => {
  const u = usage as { totalTokens?: unknown; cost?: unknown } | undefined;
  if (typeof u?.totalTokens === "number") state.usage.tokens += u.totalTokens;
  const cost = (u?.cost as { total?: unknown } | number | undefined) ?? undefined;
  if (typeof cost === "number") state.usage.cost += cost;
  else if (cost && typeof (cost as { total?: unknown }).total === "number") {
    state.usage.cost += (cost as { total: number }).total;
  }
};

/** Fold one stream line into the state. Unparseable lines are ignored, not fatal. */
export function consumeLine(state: StreamState, line: string): StreamState {
  const trimmed = line.trim();
  if (trimmed === "") return state;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return state;
  }

  switch (event.type) {
    case "session": {
      if (typeof event.id === "string") state.sessionId = event.id;
      break;
    }
    case "message_end": {
      const message = event.message as
        | { role?: string; content?: unknown; usage?: unknown }
        | undefined;
      if (message?.role === "assistant") {
        const text = textOf(message.content);
        if (text !== "") state.assistant.push(text);
        state.usage.turns += 1;
        addUsage(state, message.usage);
      }
      break;
    }
    case "tool_execution_start": {
      state.toolCalls += 1;
      break;
    }
    case "agent_end": {
      // Only used when no message_end carried the final word.
      if (state.assistant.length > 0) break;
      const messages = event.messages as { role?: string; content?: unknown }[] | undefined;
      for (const m of messages ?? []) {
        if (m?.role !== "assistant") continue;
        const text = textOf(m.content);
        if (text !== "") state.assistant.push(text);
      }
      break;
    }
  }
  return state;
}

/** Split a chunk into complete lines, returning the unterminated remainder. */
export function drain(buffer: string, onLine: (line: string) => void): string {
  const parts = buffer.split("\n");
  const remainder = parts.pop() ?? "";
  for (const line of parts) onLine(line);
  return remainder;
}

export const finalMessage = (state: StreamState): string | undefined => state.assistant.at(-1);
