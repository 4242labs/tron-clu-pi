import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CLU_ENTRY, journalFrom } from "./journal.ts";
import type { JournalEntry } from "./types.ts";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export interface RunOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
}

/**
 * Everything the driver needs from Pi, and nothing else. The phase loop, the gates and
 * the git mechanics are written against this, so the whole driver is exercisable in a
 * test without a Pi session — which is the only way the kill/resume paths get tested at all.
 */
export interface Host {
  cwd: string;
  mode: string;
  sessionId(): string | undefined;
  run(command: string, args: string[], options?: RunOptions): Promise<RunResult>;
  append(entry: JournalEntry): void;
  journal(): JournalEntry[];
  notify(text: string, level?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  setWidget(key: string, lines: string[] | undefined): void;
}

export function hostFromPi(pi: ExtensionAPI, ctx: ExtensionContext): Host {
  return {
    cwd: ctx.cwd,
    mode: ctx.mode,
    sessionId: () => ctx.sessionManager.getSessionId(),
    run: (command, args, options) => pi.exec(command, args, options),
    append: (entry) => pi.appendEntry(CLU_ENTRY, entry),
    journal: () => journalFrom(ctx.sessionManager.getEntries()),
    // UI calls are no-ops outside TUI/RPC by Pi's own contract; the driver never depends
    // on one landing.
    notify: (text, level = "info") => ctx.ui.notify(text, level),
    setStatus: (key, text) => ctx.ui.setStatus(key, text),
    setWidget: (key, lines) => ctx.ui.setWidget(key, lines),
  };
}
