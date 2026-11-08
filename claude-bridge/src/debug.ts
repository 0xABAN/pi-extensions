import { appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { debugLogPath } from "./log-paths.js";

export const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === "1";

export const moduleInstanceId = Math.random().toString(36).slice(2, 8);

export function debug(...args: unknown[]) {
	if (!DEBUG) return;
	const logPath = debugLogPath();
	try { mkdirSync(dirname(logPath), { recursive: true }); } catch {  }
	const ts = new Date().toISOString();
	const fmt = (a: unknown): string => {
		if (typeof a === "string") return a;
		if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? "\n" + a.stack : ""}`;
		return JSON.stringify(a);
	};
	const msg = args.map(fmt).join(" ");
	appendFileSync(logPath, `[${ts}] [${moduleInstanceId}] ${msg}\n`);
}

let nextCliDebugSeq = 1;
export function makeCliDebugOptions(tag: string): { debug?: boolean; debugFile?: string; stderr?: (data: string) => void } {
	if (!DEBUG) return {};
	const seq = nextCliDebugSeq++;
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const logDir = join(dirname(debugLogPath()), "cc-cli-logs");
	try { mkdirSync(logDir, { recursive: true }); } catch {  }
	const debugFile = join(logDir, `${ts}-${tag}-${seq}.log`);
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
