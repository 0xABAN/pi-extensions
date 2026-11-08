import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ASK_USER_QUESTION_TOOL_NAME } from "./ask-user-question.ts";

export function reconcileAskUserQuestionTool(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const active = pi.getActiveTools();
	const hasTool = active.includes(ASK_USER_QUESTION_TOOL_NAME);
	if (!ctx.hasUI && hasTool) {
		pi.setActiveTools(active.filter((n) => n !== ASK_USER_QUESTION_TOOL_NAME));
	} else if (ctx.hasUI && !hasTool) {
		pi.setActiveTools([...active, ASK_USER_QUESTION_TOOL_NAME]);
	}
}

export function registerAskUserQuestionReconciler(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (_event, ctx) => reconcileAskUserQuestionTool(pi, ctx));
}
