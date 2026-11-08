import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";

export const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === "1";

export function debugLogPath(): string {
	return join(getAgentDir(), "claude-bridge.log");
}

function format(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ""}`;
	return JSON.stringify(value);
}

export function debug(...args: unknown[]) {
	if (!DEBUG) return;
	mkdirSync(getAgentDir(), { recursive: true });
	appendFileSync(debugLogPath(), `[${new Date().toISOString()}] ${args.map(format).join(" ")}\n`);
}

let nextCliDebugSeq = 1;

export function makeCliDebugOptions(tag: string): {
	debug?: boolean;
	debugFile?: string;
	stderr?: (data: string) => void;
} {
	if (!DEBUG) return {};

	const seq = nextCliDebugSeq++;
	const logDir = join(getAgentDir(), "cc-cli-logs");
	mkdirSync(logDir, { recursive: true });
	const debugFile = join(logDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${tag}-${seq}.log`);
	debug(`cli-debug: ${tag} #${seq} → ${debugFile}`);
	return {
		debug: true,
		debugFile,
		stderr: (data: string) => {
			for (const line of data.split(/\r?\n/)) {
				if (line) debug(`[cli-stderr ${tag}#${seq}] ${line}`);
			}
		},
	};
}
