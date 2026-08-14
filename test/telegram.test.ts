import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as telegram from "../src/telegram.ts";
import {
  clip,
  ENV_RELATIVE,
  loadTelegramConfig,
  relayMessage,
  silentRelay,
  telegramRelay,
} from "../src/telegram.ts";
import { scratch } from "./helpers.ts";

const writeEnv = (root: string, body: string) => {
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ENV_RELATIVE), body);
};

test("credentials come from the project's gitignored env file", () => {
  const { path, cleanup } = scratch("tg-env");
  try {
    writeEnv(path, '# the bot\nTELEGRAM_BOT_TOKEN="123:abc"\nTELEGRAM_CHAT_ID = 100200300\n\n');
    const config = loadTelegramConfig(path, {} as NodeJS.ProcessEnv);
    assert.equal(config?.token, "123:abc");
    assert.equal(config?.chatId, "100200300");
    assert.equal(config?.source, ENV_RELATIVE);
  } finally {
    cleanup();
  }
});

test("the environment is the fallback, and the project file wins over it", () => {
  const { path, cleanup } = scratch("tg-precedence");
  try {
    const env = {
      TRON_CLU_TELEGRAM_BOT_TOKEN: "env-token",
      TRON_CLU_TELEGRAM_CHAT_ID: "env-chat",
    } as NodeJS.ProcessEnv;
    assert.equal(loadTelegramConfig(path, env)?.token, "env-token");
    assert.equal(loadTelegramConfig(path, env)?.source, "the environment");

    writeEnv(path, "TELEGRAM_BOT_TOKEN=file-token\nTELEGRAM_CHAT_ID=file-chat\n");
    assert.equal(loadTelegramConfig(path, env)?.token, "file-token");
  } finally {
    cleanup();
  }
});

test("a project that configures nothing gets no relay, and that is a working configuration", () => {
  const { path, cleanup } = scratch("tg-none");
  try {
    assert.equal(loadTelegramConfig(path, {} as NodeJS.ProcessEnv), undefined);
    writeEnv(path, "TELEGRAM_BOT_TOKEN=only-half\n");
    assert.equal(
      loadTelegramConfig(path, {} as NodeJS.ProcessEnv),
      undefined,
      "half a configuration is none",
    );
    assert.match(silentRelay().describe(), /not configured/);
  } finally {
    cleanup();
  }
});

test("the env file never gets committed — init ignores it", async () => {
  const { readFileSync } = await import("node:fs");
  const init = readFileSync(join(process.cwd(), "src", "init.ts"), "utf8");
  assert.match(
    init,
    /\.pi\/tron-clu\.env/,
    "a bot token in a repository is a bot token on the internet",
  );
});

test("a long park is clipped from the head, so the command survives", () => {
  const text = `${"x".repeat(5_000)}\n/tron-clu approve b1`;
  const clipped = clip(text);
  assert.ok(clipped.length <= 3_901);
  assert.ok(clipped.endsWith("/tron-clu approve b1"));
  assert.ok(clipped.startsWith("…"));
  assert.equal(clip("short"), "short");
});

test("what rides out names the repository and says decisions stay at the terminal", () => {
  const message = relayMessage(
    "tron-clu-pi-sandbox",
    "CLU parked on block b1: retry-cap\n/tron-clu answer b1-9f2 abandon",
  );
  assert.match(message, /^tron-clu-pi-sandbox/);
  assert.match(
    message,
    /b1-9f2/,
    "the item id is echoed — the operator will not see it anywhere else",
  );
  assert.match(message, /reply here does nothing/);
});

test("the relay posts to sendMessage and reports what Telegram acknowledged", async () => {
  const posted: { url: string; body: string }[] = [];
  const relay = telegramRelay(
    { token: "123:abc", chatId: "42", source: "test" },
    async (url, body) => {
      posted.push({ url, body });
      return { status: 200, body: JSON.stringify({ ok: true }) };
    },
  );

  assert.equal(await relay.send("CLU parked"), true);
  assert.equal(posted[0]?.url, "https://api.telegram.org/bot123:abc/sendMessage");
  const sent = JSON.parse(posted[0]?.body ?? "{}") as { chat_id?: string; text?: string };
  assert.equal(sent.chat_id, "42");
  assert.equal(sent.text, "CLU parked");
  assert.match(relay.describe(), /Out only/);
  assert.equal(relay.describe().includes("123:abc"), false, "the token is never printed anywhere");
});

test("an unreachable or unhappy Telegram is a false, never a throw", async () => {
  const cases: (() => Promise<{ status: number; body: string }>)[] = [
    async () => ({ status: 500, body: "" }),
    async () => ({ status: 0, body: "" }),
    async () => ({ status: 200, body: "not json" }),
    async () => ({
      status: 200,
      body: JSON.stringify({ ok: false, description: "chat not found" }),
    }),
    async () => {
      throw new Error("network on fire");
    },
  ];
  for (const poster of cases) {
    const relay = telegramRelay({ token: "t", chatId: "c", source: "test" }, poster);
    assert.equal(await relay.send("anything"), false, "a notification cannot take a run down");
  }
});

test("the relay is out only: there is no inbound surface at all", () => {
  const surface = Object.keys(telegram);
  for (const inbound of ["poll", "getUpdates", "listen", "onMessage", "webhook", "receive"]) {
    assert.equal(
      surface.some((name) => name.toLowerCase().includes(inbound.toLowerCase())),
      false,
      `${inbound} would make a merge approvable from a phone`,
    );
  }
  const relay = telegramRelay({ token: "t", chatId: "c", source: "test" }, async () => ({
    status: 200,
    body: "{}",
  }));
  assert.deepEqual(Object.keys(relay).sort(), ["describe", "send"]);
});
