/**
 * Build, Plan, and Learn share one mode controller and tool checkpoint.
 * Shift+Tab cycles modes.
 * Plan preserves the existing exploration/execute flow. Learn teaches without
 * doing the task and permits only local file inspection and web reading.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentMode, extractPlanSteps, isSafeCommand } from "./utils.ts";
import { formatModeStatus } from "./status.ts";
import { LEARN_MODE_PROMPT, LEARN_MODE_TOOLS } from "./learn.ts";

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

// Tools
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write"]);
const LEARN_MODE_APPENDIX = `\n\n<learn_mode>\n${LEARN_MODE_PROMPT}</learn_mode>`;

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
		ctx.ui.setStatus("agent-thinking", status.thinking);
	}

	function withTodo(toolNames: string[]): string[] {
		// Keep rpiv-todo available while planning, never in Learn.
		return [...new Set([...toolNames, "todo"])];
	}

	function getPlanModeTools(activeToolNames: string[]): string[] {
		return withTodo([
			...activeToolNames.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)),
			...PLAN_MODE_TOOLS,
		]);
	}

	function applyModeTools(): void {
		if (mode === "learn") {
			pi.setActiveTools([...LEARN_MODE_TOOLS]);
		} else if (mode === "plan") {
			pi.setActiveTools(getPlanModeTools(buildTools));
		} else {
			pi.setActiveTools(buildTools);
		}
	}

	function persistState(): void {
		pi.appendEntry("agent-mode", { mode, buildTools } satisfies ModeState);
	}

	function setMode(nextMode: AgentMode, ctx: ExtensionContext): void {
		if (nextMode === mode) return;

		// Carry the same Build checkpoint through Plan ↔ Learn transitions.
		if (mode === "build") buildTools = pi.getActiveTools();
		mode = nextMode;
		applyModeTools();
		updateStatus(ctx);
		persistState();
	}

	function changeMode(nextMode: AgentMode, ctx: ExtensionContext): void {
		// A running turn already has its instructions and may have tools in flight.
		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait for the current turn to finish or cancel it before changing modes.", "warning");
			return;
		}
		setMode(nextMode, ctx);
	}

	function restoreState(ctx: ExtensionContext): void {
		mode = "build";
		const entry = ctx.sessionManager.getBranch().findLast(
			(e) => e.type === "custom" && e.customType === "agent-mode",
		);

		if (entry?.type === "custom") {
			const state = entry.data as ModeState;
			mode = state.mode;
			buildTools = state.buildTools;
		}

		applyModeTools();
		updateStatus(ctx);
	}

	pi.registerShortcut("shift+tab", {
		description: "Cycle build, plan, and learn modes",
		handler: async (ctx) => changeMode(mode === "build" ? "plan" : mode === "plan" ? "learn" : "build", ctx),
	});

	// Exposure alone is not a permission boundary: also block nested/inactive calls.
	pi.on("tool_call", async (event, _ctx) => {
		if (mode === "learn" && !LEARN_MODE_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: `Learn mode permits only ${[...LEARN_MODE_TOOLS].join(", ")}. Guide the learner; do not execute their task.`,
			};
		}

		if (mode === "plan" && event.toolName === "bash") {
			const command = event.input.command as string;
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `${mode} mode: command blocked (not allowlisted). Ask the user to press Shift+Tab to return to build mode.\nCommand: ${command}`,
				};
			}
		}
	});

	// Drop stale Plan instructions, including execution reminders while learning.
	pi.on("context", async (event) => {
		if (mode === "plan") return;
		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (mode === "learn" && msg.customType === "plan-mode-execute") return false;
				return true;
			}),
		};
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// Status strings contain ANSI colors; refresh after a theme selection.
		if (ctx.hasUI) updateStatus(ctx);

		// The Claude bridge forwards appendSystemPrompt but drops custom sections.
		// Remove only our exact appendix so other extensions' instructions stay intact.
		const options = event.systemPromptOptions;
		options.appendSystemPrompt = options.appendSystemPrompt.replace(LEARN_MODE_APPENDIX, "");
		if (mode === "learn") {
			options.appendSystemPrompt += LEARN_MODE_APPENDIX;
			return;
		}
		if (mode !== "plan") return;
		return {
			message: {
				customType: "plan-mode-context",
				content:
					'Plan mode: read-only. Explore, ask questions, then output a numbered plan under a "Plan:" header. Do not modify files.',
				display: false,
			},
		};
	});

	// After a Plan: section, offer execute / stay / refine
	pi.on("agent_end", async (event, ctx) => {
		if (mode !== "plan" || !ctx.hasUI) return;

		const lastAssistant = event.messages.findLast(isAssistantMessage);
		if (!lastAssistant) return;

		const steps = extractPlanSteps(getTextContent(lastAssistant));
		if (steps.length === 0) return;

		const choice = await ctx.ui.select("Plan mode - what next?", [
			"Execute the plan",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (mode !== "plan") return;

		if (choice?.startsWith("Execute")) {
			setMode("build", ctx);

			const list = steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
			pi.sendMessage(
				{
					customType: "plan-mode-execute",
					content: `Execute the plan.

Reminder: seed these as todos first (one create per step), then work them in order.

${list}`,
					display: true,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
	});

	pi.on("thinking_level_select", async (_event, ctx) => {
		if (ctx.hasUI) updateStatus(ctx);
	});

	pi.on("session_start", async (event, ctx) => {
		buildTools = pi.getActiveTools();
		restoreState(ctx);

		// Explicit startup flags override saved state; Learn wins if both are set.
		if (event.reason === "startup") {
			if (pi.getFlag("learn") === true) setMode("learn", ctx);
			else if (pi.getFlag("plan") === true) setMode("plan", ctx);
		}
	});

	pi.on("session_tree", async (_event, ctx) => restoreState(ctx));
}
