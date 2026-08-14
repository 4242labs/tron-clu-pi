import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readMandate } from "./block.ts";
import { promptBootConfig } from "./boot.ts";
import { LOCK_EXEMPT, parseCommand, TUI_ONLY } from "./commands.ts";
import { loadGateConfig } from "./config.ts";
import { gitCommonDir, repoRoot } from "./git.ts";
import { PhaseLoop } from "./graph.ts";
import { type Host, hostFromPi } from "./host.ts";
import { initProject } from "./init.ts";
import { boundToSession, fold, isLive, now } from "./journal.ts";
import {
  acquireLock,
  forceUnlock,
  HEARTBEAT_INTERVAL_MS,
  lockPathFor,
  readLock,
  releaseLock,
  touchLock,
} from "./lock.ts";
import { describeOrphans, terminateOrphans } from "./orphans.ts";
import { piSeatRunner } from "./pi-seats.ts";
import type { DriverState } from "./types.ts";

export const VERSION = "0.1.0";
export const PI_BASELINE = "0.84.1";
export const COMMAND = "tron-clu";

/** Session-scoped, started by the command that needs it — never by the factory. */
interface Runtime {
  loop?: PhaseLoop;
  abort?: AbortController;
  heartbeat?: NodeJS.Timeout;
  lockPath?: string;
  sessionId?: string;
}

export default function (pi: ExtensionAPI) {
  const rt: Runtime = {};

  const stopRuntime = () => {
    rt.abort?.abort();
    if (rt.heartbeat) clearInterval(rt.heartbeat);
    rt.heartbeat = undefined;
    if (rt.lockPath && rt.sessionId) releaseLock(rt.lockPath, rt.sessionId);
    rt.lockPath = undefined;
    rt.loop = undefined;
  };

  pi.on("session_start", async (_event, ctx) => {
    // A collided command name would make every printed instruction a lie.
    const mine = pi.getCommands().filter((c) => c.name.startsWith(COMMAND));
    if (mine.length > 0 && !mine.some((c) => c.name === COMMAND)) {
      ctx.ui.notify(
        `tron-clu is registered as /${mine[0]?.name} — another extension owns /${COMMAND}. Refusing to run: every instruction CLU prints names /${COMMAND}.`,
        "error",
      );
      return;
    }
    const state = fold(hostFromPi(pi, ctx).journal());
    if (isLive(state)) {
      const bound = boundToSession(state, ctx.sessionManager.getSessionId());
      ctx.ui.setStatus(
        "tron-clu",
        bound
          ? `CLU: mandate ${state.mandateId} resumable — /tron-clu status`
          : `CLU: mandate ${state.mandateId} belongs to session ${state.sessionId}; this session can read it, not run it`,
      );
    }
  });

  pi.on("session_shutdown", async () => {
    stopRuntime();
  });

  pi.registerCommand(COMMAND, {
    description: "TRON-CLU — supervise a fleet of Pi seats against a mandate of blocks",
    handler: async (args, ctx) => {
      const host = hostFromPi(pi, ctx);
      const parsed = parseCommand(args);

      if (parsed.kind === "error") {
        ctx.ui.notify(parsed.message, "error");
        return;
      }
      if (TUI_ONLY.has(parsed.kind) && ctx.mode !== "tui") {
        ctx.ui.notify(
          `/${COMMAND} ${parsed.kind} runs in the TUI only — there is no programmatic path to starting a mandate or approving a merge.`,
          "error",
        );
        return;
      }
      if (!LOCK_EXEMPT.has(parsed.kind)) {
        const held = await heldLock(host);
        if (held && held.sessionId !== ctx.sessionManager.getSessionId()) {
          ctx.ui.notify(
            `a mandate is already live in session ${held.sessionId} on ${held.host} (heartbeat ${held.heartbeat}). /${COMMAND} unlock refuses while it is fresh.`,
            "error",
          );
          return;
        }
      }

      switch (parsed.kind) {
        case "status":
          return void printStatus(host, ctx);
        case "init":
          return void (await runInit(host, ctx));
        case "unlock":
          return void (await runUnlock(host, ctx));
        case "abort":
          stopRuntime();
          host.append({ kind: "mandate_ended", reason: "aborted", at: now() });
          ctx.ui.setStatus("tron-clu", undefined);
          ctx.ui.notify(
            "CLU: aborted. Seats recorded in state are terminated on the next resume.",
            "warning",
          );
          return;
        case "approve":
        case "reject":
        case "answer":
          return void (await resolve(host, ctx, parsed));
        case "mandate":
          return void (await startMandate(host, ctx, parsed.path, rt, pi));
      }
    },
  });
}

/** Seats load the deny extension from this package, wherever it was installed from. */
export const denyExtensionPath = (): string =>
  fileURLToPath(new URL("./seat-deny.ts", import.meta.url));

const heldLock = async (host: Host) => {
  try {
    return readLock(lockPathFor(await gitCommonDir(host)));
  } catch {
    return undefined;
  }
};

function printStatus(host: Host, ctx: ExtensionContext): void {
  const state = fold(host.journal());
  if (!state.mandateId) {
    ctx.ui.notify("CLU: no mandate in this session.", "info");
    return;
  }
  ctx.ui.setWidget("tron-clu-status", renderStatus(state));
  ctx.ui.notify(`CLU: mandate ${state.mandateId} — ${summarize(state)}`, "info");
}

export function renderStatus(state: DriverState): string[] {
  const lines = [`mandate ${state.mandateId ?? "—"} (${state.ended ?? "live"})`];
  for (const b of state.blocks) {
    const verdict = state.verdicts[b.id]?.verdict;
    lines.push(
      `  ${b.id.padEnd(12)} ${state.blockState[b.id] ?? "pending"}${verdict ? ` · ${verdict}` : ""}`,
    );
  }
  if (state.pendingMerge)
    lines.push(
      `  awaiting your merge: ${state.pendingMerge.blockId} (${state.pendingMerge.branch})`,
    );
  for (const e of state.openEscalations)
    lines.push(`  parked ${e.itemId}: ${e.kind} — ${e.answers.join(" | ")}`);
  for (const s of state.liveSeats)
    lines.push(`  seat running: ${s.role} on ${s.blockId} (pid ${s.pid})`);
  if (state.spend.turns > 0) {
    lines.push(
      `  spent: ${state.spend.turns} turns · ${state.spend.tokens.toLocaleString("en-US")} tokens · $${state.spend.cost.toFixed(2)}`,
    );
  }
  return lines;
}

const summarize = (state: DriverState): string => {
  const done = state.blocks.filter((b) => state.blockState[b.id] === "done").length;
  const parked = state.openEscalations.length + (state.pendingMerge ? 1 : 0);
  return `${done}/${state.blocks.length} blocks done, ${parked} parked`;
};

async function runInit(host: Host, ctx: ExtensionCommandContext): Promise<void> {
  try {
    const repo = await repoRoot(host);
    const branch = await ctx.ui.input("CLU init — branch blocks land on", "main", {
      timeout: 120_000,
    });
    if (branch === undefined) return void ctx.ui.notify("CLU init: cancelled.", "warning");
    const strategy = await ctx.ui.select(
      "CLU init — how blocks land",
      ["pr", "squash", "merge-commit", "rebase"],
      { timeout: 120_000 },
    );
    if (!strategy) return void ctx.ui.notify("CLU init: cancelled.", "warning");
    const gates = await ctx.ui.input(
      "CLU init — default gate commands, semicolon-separated",
      "npm test",
      {
        timeout: 120_000,
      },
    );
    if (gates === undefined) return void ctx.ui.notify("CLU init: cancelled.", "warning");

    const report = await initProject(host, {
      repo,
      defaultBranch: branch.trim() === "" ? "main" : branch.trim(),
      mergeStrategy: strategy as never,
      defaultGates: gates
        .split(";")
        .map((g) => g.trim())
        .filter((g) => g !== ""),
    });
    ctx.ui.setWidget("tron-clu-status", [
      `init wrote ${report.configPath}`,
      ...report.notes.map((n) => `  ${n}`),
    ]);
    ctx.ui.notify(`CLU init: wrote ${report.configPath}`, "info");
  } catch (e) {
    ctx.ui.notify(`CLU init failed: ${(e as Error).message}`, "error");
  }
}

async function runUnlock(host: Host, ctx: ExtensionCommandContext): Promise<void> {
  const lockPath = lockPathFor(await gitCommonDir(host));
  const held = readLock(lockPath);
  if (!held) return void ctx.ui.notify("CLU: no lock held.", "info");
  const result = forceUnlock(lockPath);
  if (!result.released) return void ctx.ui.notify(`CLU: ${result.reason}`, "error");
  const confirmed = await ctx.ui.confirm(
    "CLU unlock",
    `The lock was stale (last heartbeat ${held.heartbeat}). It has been released. Continue?`,
  );
  if (!confirmed)
    ctx.ui.notify("CLU: lock released anyway — a stale lock is not a running mandate.", "warning");
}

async function resolve(
  host: Host,
  ctx: ExtensionCommandContext,
  parsed: {
    kind: "approve" | "reject" | "answer";
    blockId?: string;
    reason?: string;
    itemId?: string;
    choice?: string;
  },
): Promise<void> {
  const state = fold(host.journal());
  if (!boundToSession(state, ctx.sessionManager.getSessionId())) {
    return void ctx.ui.notify(
      "CLU: this mandate belongs to another session. Resume it there.",
      "error",
    );
  }

  if (parsed.kind === "answer") {
    const open = state.openEscalations.find((e) => e.itemId === parsed.itemId);
    if (!open) return void ctx.ui.notify(`CLU: no open item ${parsed.itemId}.`, "error");
    if (!open.answers.includes(parsed.choice ?? "")) {
      return void ctx.ui.notify(
        `CLU: ${parsed.itemId} accepts ${open.answers.join(" | ")}.`,
        "error",
      );
    }
    host.append({
      kind: "answer",
      itemId: open.itemId,
      choice: parsed.choice as string,
      at: now(),
    });
    ctx.ui.notify(
      `CLU: recorded ${parsed.choice} for ${open.itemId}. Run /${COMMAND} <mandate> to continue.`,
      "info",
    );
    return;
  }

  if (state.pendingMerge?.blockId !== parsed.blockId) {
    return void ctx.ui.notify(
      `CLU: block ${parsed.blockId} is not awaiting a merge ruling.`,
      "error",
    );
  }
  host.append({
    kind: "ruling",
    blockId: parsed.blockId as string,
    ruling: parsed.kind === "approve" ? "approve" : "reject",
    ...(parsed.reason ? { reason: parsed.reason } : {}),
    at: now(),
  });
  ctx.ui.notify(
    parsed.kind === "approve"
      ? `CLU: ${parsed.blockId} approved. Landing is verified by command before the block is called done.`
      : `CLU: ${parsed.blockId} rejected — ${parsed.reason}`,
    "info",
  );
}

async function startMandate(
  host: Host,
  ctx: ExtensionCommandContext,
  mandatePath: string,
  rt: Runtime,
  _pi: ExtensionAPI,
): Promise<void> {
  const existing = fold(host.journal());
  if (isLive(existing) && !boundToSession(existing, ctx.sessionManager.getSessionId())) {
    return void ctx.ui.notify(
      "CLU: a mandate from another session is recorded here. This session may read it, not run it.",
      "error",
    );
  }

  try {
    const repo = await repoRoot(host);
    const gates = loadGateConfig(repo);
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId)
      return void ctx.ui.notify(
        "CLU: this session has no id — a mandate must be bound to one.",
        "error",
      );

    if (!isLive(existing)) {
      const mandateId = `m${Date.now().toString(36)}`;
      const blocks = readMandate(mandatePath, mandateId);
      const models = ctx.scopedModels.map((m) => m.model.id);
      const config = await promptBootConfig(
        ctx,
        models.length > 0 ? models : [ctx.model?.id ?? "default"],
      );

      const lockPath = lockPathFor(await gitCommonDir(host));
      const lock = acquireLock(lockPath, sessionId, mandateId);
      if (!lock.ok) {
        return void ctx.ui.notify(
          `CLU: locked by session ${lock.held.sessionId} on ${lock.held.host}${lock.stale ? " (stale — /tron-clu unlock)" : ""}.`,
          "error",
        );
      }
      rt.lockPath = lockPath;
      rt.sessionId = sessionId;
      rt.heartbeat = setInterval(() => touchLock(lockPath, sessionId), HEARTBEAT_INTERVAL_MS);
      host.append({
        kind: "mandate_started",
        mandateId,
        sessionId,
        config,
        gates,
        blocks,
        at: now(),
      });
      ctx.ui.notify(`CLU: mandate ${mandateId} started — ${blocks.length} blocks.`, "info");
    }

    // A resume inherits whatever the killed session left running. Two writers on one
    // worktree is the failure this prevents, so it happens before the loop starts.
    const state = fold(host.journal());
    if (state.liveSeats.length > 0) {
      const report = await terminateOrphans(host, state, gates.piBinary);
      const described = describeOrphans(report);
      if (described) ctx.ui.notify(described, "warning");
    }

    const mandateId = state.mandateId ?? "";
    const bootConfig = state.config;
    if (!bootConfig)
      return void ctx.ui.notify("CLU: no boot config in state — cannot start seats.", "error");

    rt.abort = new AbortController();
    rt.loop = new PhaseLoop({
      host,
      repo,
      seats: piSeatRunner(
        {
          piBinary: gates.piBinary,
          denyExtension: denyExtensionPath(),
          config: bootConfig,
          gates,
          evidenceFor: (blockId) =>
            fold(host.journal()).evidence.filter((e) => e.blockId === blockId),
          onExit: (blockId, _role, pid, usage) =>
            host.append({ kind: "seat_exit", blockId, pid: pid ?? -1, usage, at: now() }),
        },
        mandateId,
      ),
      signal: rt.abort.signal,
      notifyOperator: (text) => ctx.ui.notify(text, "info"),
    });

    // The handler returns now; the loop runs behind it so the TUI and every subcommand
    // stay dispatchable for the whole run.
    void rt.loop
      .run()
      .then((outcome) =>
        ctx.ui.notify(`CLU: loop ${outcome}.`, outcome === "complete" ? "info" : "warning"),
      )
      .catch((e: unknown) => ctx.ui.notify(`CLU: loop stopped — ${(e as Error).message}`, "error"));
  } catch (e) {
    ctx.ui.notify(`CLU: ${(e as Error).message}`, "error");
  }
}
