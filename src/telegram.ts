import { existsSync, readFileSync } from "node:fs";
import { request } from "node:https";
import { join } from "node:path";

/**
 * The line to an operator who is not at the terminal.
 *
 * It is a **relay, not a channel**: messages go out, nothing comes in. There is no polling,
 * no webhook, no inbound handler — deliberately. Every decision CLU can park on is resolved
 * in the TUI, and a merge approved from a phone is a merge approved by whoever has the
 * phone. What rides out is what parked and the exact command that clears it.
 *
 * Unconfigured or unreachable, it degrades to the TUI in silence: the transport is an exit
 * ramp, never a dependency.
 */

export interface TelegramConfig {
  token: string;
  chatId: string;
  /** Where the credentials came from, for the status line. Never the token itself. */
  source: string;
}

/** Gitignored, never committed: a bot token in a repository is a bot token on the internet. */
export const ENV_RELATIVE = join(".pi", "tron-clu.env");

const parseEnv = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return out;
};

/**
 * The project's env file first, the process environment second. A project that says nothing
 * about Telegram gets no Telegram, which is a working configuration and not an error.
 */
export function loadTelegramConfig(
  repo: string,
  env: NodeJS.ProcessEnv = process.env,
): TelegramConfig | undefined {
  const path = join(repo, ENV_RELATIVE);
  const fromFile = existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
  const token =
    fromFile.TELEGRAM_BOT_TOKEN ?? env.TRON_CLU_TELEGRAM_BOT_TOKEN ?? env.TELEGRAM_BOT_TOKEN;
  const chatId = fromFile.TELEGRAM_CHAT_ID ?? env.TRON_CLU_TELEGRAM_CHAT_ID ?? env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return undefined;
  return {
    token,
    chatId,
    source: fromFile.TELEGRAM_BOT_TOKEN ? ENV_RELATIVE : "the environment",
  };
}

/** Telegram refuses anything past 4096 characters; the ask lives at the end, so the head goes. */
export const clip = (text: string, limit = 3_900): string =>
  text.length <= limit ? text : `…${text.slice(-limit)}`;

export interface Relay {
  /** True when Telegram acknowledged it. Never throws: a notification cannot take a run down. */
  send(text: string): Promise<boolean>;
  describe(): string;
}

type Poster = (url: string, body: string) => Promise<{ status: number; body: string }>;

const post: Poster = (url, body) =>
  new Promise((resolve) => {
    const req = request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        timeout: 10_000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on("error", () => resolve({ status: 0, body: "" }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, body: "" });
    });
    req.write(body);
    req.end();
  });

/** A relay that does nothing, for a project that configured none. */
export const silentRelay = (): Relay => ({
  send: async () => false,
  describe: () => "Telegram: not configured — parks are announced in the TUI only.",
});

export function telegramRelay(config: TelegramConfig, poster: Poster = post): Relay {
  return {
    async send(text) {
      try {
        const r = await poster(
          `https://api.telegram.org/bot${config.token}/sendMessage`,
          JSON.stringify({
            chat_id: config.chatId,
            text: clip(text),
            disable_web_page_preview: true,
          }),
        );
        if (r.status !== 200) return false;
        return (JSON.parse(r.body) as { ok?: boolean }).ok === true;
      } catch {
        return false;
      }
    },
    describe: () =>
      `Telegram: relaying to chat ${config.chatId} (from ${config.source}). Out only — decisions stay in the TUI.`,
  };
}

/**
 * What the operator reads on a phone. The driver's own wording already names the block, the
 * reason and the exact command; this adds the two things a phone lacks — which repository,
 * and the reminder that the answer is typed at the terminal, not here.
 */
export const relayMessage = (repoName: string, text: string): string =>
  `${repoName}\n\n${text}\n\n(reply here does nothing — CLU only takes decisions at the terminal)`;
