import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "path";

export function debugLogPath(): string {
	return process.env.CLAUDE_BRIDGE_DEBUG_PATH || join(getAgentDir(), "claude-bridge.log");
}

export function diagLogPath(): string {
	return join(getAgentDir(), "claude-bridge-diag.log");
}
