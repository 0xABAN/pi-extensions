import type { EffortLevel, SDKMessage, ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";

const CC_CHILD_ENV = {
	ENABLE_CLAUDEAI_MCP_SERVERS: "0",
	DISABLE_AUTO_COMPACT: "1",
	CLAUDE_CODE_ELEGANT_MEADOW: "0",
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
	CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS: "1",
	CLAUDE_CODE_SILENT_TURN_REMINDER: "0",
	CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "16384",
} as const;

const PARENT_SESSION_VARS = [
	"CLAUDECODE",
	"CLAUDE_CODE_CHILD_SESSION",
	"CLAUDE_CODE_SESSION_ID",
	"CLAUDE_CODE_SESSION_ATTENDED",
	"CLAUDE_PID",
	"CLAUDE_EFFORT",
	"TRACEPARENT",
	"CLAUDE_CODE_INVOKED_SKILLS",
	"CLAUDE_ENV_FILE",
	"CLAUDE_CODE_ENTRYPOINT",
	"CLAUDE_AGENT_SDK_VERSION",
	"CLAUDE_CODE_EXECPATH",
	"CLAUDE_CODE_SSE_PORT",
	"CLAUDE_CODE_MESSAGING_SOCKET",
	"CLAUDE_CODE_MESSAGING_TOKEN",
];

const SESSION_STORAGE_VARS = ["CLAUDE_CONFIG_DIR", "HOME", "USERPROFILE"];

export function ccChildEnv(
	overrides: Record<string, string> = {},
	parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const storage = Object.keys(overrides).filter((name) => SESSION_STORAGE_VARS.includes(name.toUpperCase()));
	if (storage.length)
		throw new Error(
			`claude-bridge: provider env can't set ${storage.join(", ")}; the bridge reads Claude Code's session files through pi's own values`,
		);
	const env: NodeJS.ProcessEnv = { ...parent };
	if (parent.CLAUDECODE) for (const name of PARENT_SESSION_VARS) delete env[name];
	for (const [name, value] of Object.entries(overrides)) {
		if (value === "") delete env[name];
		else env[name] = value;
	}
	return { ...env, ...CC_CHILD_ENV };
}

export const CLAUDE_MD_EXCLUDES = ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"];

const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "max",
	max: "max",
};

export function resultErrorText(message: SDKMessage): string | undefined {
	const result = message as SDKMessage & {
		subtype?: string;
		is_error?: boolean;
		result?: string;
		errors?: unknown;
		error?: unknown;
	};
	if (result.subtype === "success")
		return result.is_error ? result.result || "Claude Code reported an error" : undefined;
	if (Array.isArray(result.errors) && result.errors.length) return result.errors.map(String).join("\n");
	if (typeof result.error === "string") return result.error;
	return `Claude Code failed: ${result.subtype ?? "unknown result"}`;
}

export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (err && typeof err === "object") {
		const obj = err as Record<string, unknown>;
		if (typeof obj.message === "string") return obj.message;
		if (typeof obj.error === "string") return obj.error;
		try {
			return JSON.stringify(err);
		} catch {}
	}
	return String(err);
}

const VALID_EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

export function effortForReasoning(model: Model<any>, reasoning: ThinkingLevel | undefined): EffortLevel | undefined {
	if (!reasoning) return undefined;
	const mapped = model.thinkingLevelMap?.[reasoning];
	if (mapped === undefined) return REASONING_TO_EFFORT[reasoning];
	return VALID_EFFORTS.has(mapped as EffortLevel) ? (mapped as EffortLevel) : undefined;
}

export function thinkingForReasoning(
	model: Model<any>,
	reasoning: ThinkingLevel | undefined,
): ThinkingConfig | undefined {
	if (reasoning || !model.reasoning || model.thinkingLevelMap?.off === null) return undefined;
	return { type: "disabled" };
}
