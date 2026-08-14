import type { Host } from "./host.ts";
import { now } from "./journal.ts";
import type { DriverState } from "./types.ts";

/**
 * A host that was killed leaves its seats running. On resume they are terminated before
 * anything else happens: two writers on one worktree is the failure this exists to prevent.
 *
 * PIDs are reused, so a recorded pid is only killed when the process still running under it
 * is the same `pi` the driver spawned.
 */
export interface OrphanReport {
  terminated: number[];
  alreadyGone: number[];
  skipped: { pid: number; reason: string }[];
}

export async function isOurSeat(host: Host, pid: number, piBinary: string): Promise<boolean> {
  const r = await host.run("ps", ["-o", "command=", "-p", String(pid)]);
  if (r.code !== 0) return false;
  const command = r.stdout.trim();
  return command !== "" && command.includes(piBinary);
}

export async function terminateOrphans(
  host: Host,
  state: DriverState,
  piBinary: string,
): Promise<OrphanReport> {
  const report: OrphanReport = { terminated: [], alreadyGone: [], skipped: [] };

  for (const seat of state.liveSeats) {
    if (!(await isOurSeat(host, seat.pid, piBinary))) {
      const exists = (await host.run("ps", ["-o", "pid=", "-p", String(seat.pid)])).code === 0;
      if (exists)
        report.skipped.push({ pid: seat.pid, reason: "pid belongs to another process now" });
      else report.alreadyGone.push(seat.pid);
      host.append({ kind: "seat_exit", blockId: seat.blockId, pid: seat.pid, at: now() });
      continue;
    }

    await host.run("kill", ["-TERM", String(seat.pid)]);
    if (await isOurSeat(host, seat.pid, piBinary))
      await host.run("kill", ["-KILL", String(seat.pid)]);
    report.terminated.push(seat.pid);
    host.append({ kind: "seat_exit", blockId: seat.blockId, pid: seat.pid, at: now() });
  }

  return report;
}

export const describeOrphans = (report: OrphanReport): string | undefined => {
  const parts: string[] = [];
  if (report.terminated.length > 0)
    parts.push(`terminated ${report.terminated.length} seat(s) left over from a killed session`);
  if (report.alreadyGone.length > 0) parts.push(`${report.alreadyGone.length} already gone`);
  for (const s of report.skipped) parts.push(`left pid ${s.pid} alone — ${s.reason}`);
  return parts.length > 0 ? `CLU: ${parts.join("; ")}.` : undefined;
};
