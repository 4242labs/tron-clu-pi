import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Kept in step with package.json; surfaced by `/clu` so a run can be pinned to a build. */
export const VERSION = "0.1.0";

/** Pi version this extension is verified against (see docs/pi-api.md). */
export const PI_BASELINE = "0.84.1";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("clu", {
    description: "TRON-CLU — supervise a fleet of Pi seats against a pipeline",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`TRON-CLU ${VERSION} (pi ${PI_BASELINE}) — driver not yet armed`, "info");
    },
  });
}
