import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { INTERVAL_MS, randomMessage, sparkleFrames } from "./animation.ts";

export default function (pi: ExtensionAPI) {
	const pickMessage = async (_event: unknown, ctx: ExtensionContext) => {
		ctx.ui.setWorkingMessage(randomMessage());
	};

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setWorkingIndicator({ frames: sparkleFrames, intervalMs: INTERVAL_MS });
	});
	pi.on("agent_start", pickMessage);
	pi.on("turn_start", pickMessage);
}
