import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LEARN_MODE_PROMPT } from "./learn.ts";
import { PLAN_MODE_PROMPT, PLAN_TOOL, registerPlanTool } from "./plan.ts";
import { formatModeStatus } from "./status.ts";
import { type AgentMode, isSafeCommand, READ_ONLY_TOOLS } from "./utils.ts";

const MODE_PROMPTS = {
	plan: PLAN_MODE_PROMPT,
	learn: LEARN_MODE_PROMPT,
};

const MODE_NOTES = {
	plan: "Plan mode: follow the <plan_mode> rules. Read-only; call the plan tool when proposing a change.",
	learn: "Learn mode: follow the <learn_mode> rules. Guide, don't solve: no code, fixes, or solution steps. Under 100 words, at most one question.",
};

const NOTE_TYPES = new Set(["plan-mode-context", "learn-mode-context"]);

function noteType(mode: AgentMode): string {
	return `${mode}-mode-context`;
}

interface ModeState {
	mode: AgentMode;
	buildTools: string[];
}

export default function modesExtension(pi: ExtensionAPI): void {
	let mode: AgentMode = "build";
	let buildTools: string[] = [];

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("learn", {
		description: "Start in learn mode (guided thinking, no solutions)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		const status = formatModeStatus(mode, ctx.thinkingLevel, ctx.ui.theme?.name);
		ctx.ui.setStatus("agent-mode", status.mode);
		ctx.ui.setStatus("agent-thinking", status.thinking, { placement: "footer" });
	}

	function modeTools(): string[] {
		if (mode === "plan") return [...READ_ONLY_TOOLS, PLAN_TOOL];
		if (mode === "learn") return [...READ_ONLY_TOOLS];
		return buildTools;
	}

	function applyModeTools(): void {
		pi.setActiveTools(modeTools());
	}

	function persistState(): void {
		pi.appendEntry("agent-mode", { mode, buildTools } satisfies ModeState);
	}

	function setMode(nextMode: AgentMode, ctx: ExtensionContext): void {
		if (nextMode === mode) return;

		if (mode === "build") buildTools = pi.getActiveTools();
		mode = nextMode;
		applyModeTools();
		updateStatus(ctx);
		persistState();
	}

	function changeMode(nextMode: AgentMode, ctx: ExtensionContext): void {
		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait for the current turn to finish or cancel it before changing modes.", "warning");
			return;
		}
		setMode(nextMode, ctx);
	}

	function restoreState(ctx: ExtensionContext): void {
		mode = "build";
		const entry = ctx.sessionManager
			.getBranch()
			.findLast((e) => e.type === "custom" && e.customType === "agent-mode");

		if (entry?.type === "custom") {
			const state = entry.data as ModeState;
			mode = state.mode;
			buildTools = state.buildTools;
		}

		applyModeTools();
		updateStatus(ctx);
	}

	registerPlanTool(pi, (ctx) => setMode("build", ctx));

	pi.registerShortcut("shift+tab", {
		description: "Cycle build, plan, and learn modes",
		handler: async (ctx) => changeMode(mode === "build" ? "plan" : mode === "plan" ? "learn" : "build", ctx),
	});

	pi.on("tool_call", async (event, _ctx) => {
		if (mode === "build") return;

		const leave = "Ask the user to press Shift+Tab to return to build mode.";
		const allowed = modeTools();

		if (!allowed.includes(event.toolName)) {
			return {
				block: true,
				reason: `${mode} mode permits only ${allowed.join(", ")}. ${leave}`,
			};
		}

		if (event.toolName === "bash") {
			const command = event.input.command as string;
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `${mode} mode: command blocked (not allowlisted). ${leave}\nCommand: ${command}`,
				};
			}
		}
	});

	pi.on("context", async (event) => ({
		messages: event.messages.filter((m) => {
			const { customType } = m as AgentMessage & { customType?: string };
			return !customType || !NOTE_TYPES.has(customType) || customType === noteType(mode);
		}),
	}));

	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.hasUI) updateStatus(ctx);

		if (mode === "build") return;

		event.systemPromptOptions.sections[`${mode}_mode`] = MODE_PROMPTS[mode];
		return {
			message: { customType: noteType(mode), content: MODE_NOTES[mode], display: false },
		};
	});

	pi.on("thinking_level_select", async (_event, ctx) => {
		if (ctx.hasUI) updateStatus(ctx);
	});

	pi.on("session_start", async (event, ctx) => {
		buildTools = pi.getActiveTools();
		restoreState(ctx);

		if (event.reason === "startup") {
			if (pi.getFlag("learn") === true) setMode("learn", ctx);
			else if (pi.getFlag("plan") === true) setMode("plan", ctx);
		}
	});

	pi.on("session_tree", async (_event, ctx) => restoreState(ctx));
}
