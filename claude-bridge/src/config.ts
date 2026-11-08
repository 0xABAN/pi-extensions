import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface Config {
	askClaude?: { enabled?: boolean };
	provider?: {
		strictMcpConfig?: boolean;
		autoMemoryEnabled?: boolean;
		pathToClaudeCodeExecutable?: string;
		plan?: "pro" | "max";
		longContextExtraUsage?: boolean;
		forceTwoHundredK?: string[];
	};
}

function tryParseJson(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		console.error(`claude-bridge: failed to parse ${path}: ${e}`);
		return {};
	}
}

export function claudeCodeSettings(provider: Config["provider"] = {}): { autoMemoryEnabled: boolean } {
	return { autoMemoryEnabled: provider.autoMemoryEnabled ?? false };
}

export function globalConfigPath(): string {
	return join(getAgentDir(), "claude-bridge.json");
}

export function loadConfig(): Config {
	const global = tryParseJson(globalConfigPath());
	return { askClaude: global.askClaude, provider: { ...global.provider } };
}
