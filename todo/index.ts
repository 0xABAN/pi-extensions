import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	applyTaskAction,
	changesState,
	emptyState,
	isTaskDetails,
	lastReminder,
	openTasks,
	REMINDER_TYPE,
	replay,
	STATE_ENTRY,
	type TaskState,
	visibleTasks,
} from "./tasks.ts";
import {
	DESCRIPTION,
	PROMPT_GUIDELINES,
	PROMPT_SNIPPET,
	summarizeTodo,
	TOOL_NAME,
	TodoParams,
	toolResult,
} from "./tool.ts";
import { formatTodoList, notice, TodoWidget } from "./widget.ts";

export function reminderText(state: TaskState): string | undefined {
	const open = openTasks(state);
	if (open.length === 0) return undefined;

	const tasks = open.map((task) => `#${task.id} [${task.status}] ${task.subject}`).join("\n");
	return (
		`Open todos — call the todo tool this turn as you progress:\n${tasks}\n` +
		"Mark the task you are about to do in_progress (with activeForm) BEFORE other tools. " +
		"Mark it completed IMMEDIATELY when done. Exactly one in_progress. Never leave the list stale."
	);
}

export default function (pi: ExtensionAPI): void {
	let state = emptyState();
	let lastReminded: string | undefined;
	const widget = new TodoWidget(() => state);

	function clear(ctx: ExtensionContext, message: string): void {
		const result = applyTaskAction(state, { action: "clear" });
		state = result.state;
		pi.appendEntry(STATE_ENTRY, toolResult({ action: "clear" }, state, result.op).details);
		ctx.ui.notify(notice(message, ctx.ui.theme), "info");
	}

	function restore(ctx: ExtensionContext): void {
		const branch = ctx.sessionManager.getBranch();
		state = replay(branch);
		lastReminded = lastReminder(branch);
		widget.attach(ctx.ui);
	}

	pi.registerTool({
		name: TOOL_NAME,
		label: "Todo",
		description: DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: TodoParams,

		summarize: (args, result) => summarizeTodo(args, isTaskDetails(result?.details) ? result.details : state),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const applied = applyTaskAction(state, params);
			state = applied.state;
			const result = toolResult(params, state, applied.op);
			if (changesState(applied.op)) pi.appendEntry(STATE_ENTRY, result.details);

			const tasks = visibleTasks(state);
			if (tasks.length > 0 && tasks.every((task) => task.status === "completed")) {
				clear(ctx, "All todos done — cleared");
			}
			widget.update();
			return result;
		},
	});

	pi.registerCommand("todos", {
		description: "Show all todos on the current branch, grouped by status",
		handler: async (_args, ctx) => ctx.ui.notify(formatTodoList(state, ctx.ui.theme), "info"),
	});

	pi.registerCommand("todos-clear", {
		description: "Clear all todos",
		handler: async (_args, ctx) => {
			const count = visibleTasks(state).length;
			if (count === 0) {
				ctx.ui.notify(notice("No todos to clear", ctx.ui.theme), "info");
				return;
			}
			clear(ctx, `Cleared ${count} todo${count === 1 ? "" : "s"}`);
			widget.update();
		},
	});

	pi.on("before_agent_start", async () => {
		const content = reminderText(state);
		if (content === lastReminded) return;

		lastReminded = content;
		if (!content) return;
		return { message: { customType: REMINDER_TYPE, content, display: false } };
	});

	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_tree", async (_event, ctx) => restore(ctx));
	pi.on("session_compact", async () => {
		lastReminded = undefined;
	});
	pi.on("session_shutdown", async () => widget.detach());
}
