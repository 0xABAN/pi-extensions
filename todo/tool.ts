import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolSummary } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { displayText, type Op, type Task, type TaskDetails, type TaskParams, type TaskState } from "./tasks.ts";

export const TOOL_NAME = "todo";

export const DESCRIPTION =
	"Manage a task list for tracking multi-step progress. Actions: create (new task, or several tasks at once via tasks[]), update (change status/fields), list (all tasks, optionally filtered by status), get (single task details), delete (tombstone), clear (reset all). Status: pending → in_progress → completed, plus deleted tombstone. Use this to plan and track multi-step work like research, design, and implementation.";

export const PROMPT_SNIPPET =
	"Track substantial, long-running work with the todo tool when progress must stay coordinated across many turns.";

export const PROMPT_GUIDELINES = [
	"Use the `todo` tool only when the user explicitly requests a task list or when work has several substantial phases or independent deliverables that need coordination across many turns. Do not use it for questions, short investigations, or routine inspect-edit-test-commit work; tool calls and file count alone are not triggers. Create the list before starting qualifying work.",
	"When open todos exist, your FIRST tool call this turn should be `todo` update: mark the current task in_progress (with activeForm) before any read/edit/bash. When that task is done, immediately `todo` update it to completed — never batch completions at the end.",
	"Exactly one task may be in_progress at a time. Do not start the next task until the current one is completed or blocked.",
	"Never mark a task completed if tests fail, the change is partial, or errors remain — keep it in_progress and add a blocker task if needed.",
	'Task status is pending → in_progress → completed (deleted is a tombstone). Example: {"action":"update","id":3,"status":"completed"} or {"action":"update","id":3,"status":"in_progress","activeForm":"writing tests"}.',
	"Subject: short imperative. activeForm: present-continuous while in_progress. Prefer create+update over inventing a parallel checklist in prose.",
	"Leaving the todo list stale is a failure. If you finish work without updating todos, fix that before your final reply.",
];

const ACTIVE_FORM = "Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')";

export const TodoParams = Type.Object({
	action: StringEnum(["create", "update", "list", "get", "delete", "clear"] as const),
	subject: Type.Optional(Type.String({ description: "Task subject line (required for create unless tasks[] is set)" })),
	description: Type.Optional(Type.String({ description: "Long-form task description" })),
	activeForm: Type.Optional(Type.String({ description: ACTIVE_FORM })),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
			description:
				"Set this task's status (update): one of pending, in_progress, completed, deleted. When action is list, filters returned tasks by this status.",
		}),
	),
	id: Type.Optional(Type.Number({ description: "Task id (required for update, get, delete)" })),
	includeDeleted: Type.Optional(
		Type.Boolean({ description: "If true, list action returns deleted (tombstoned) tasks as well. Default: false." }),
	),
	tasks: Type.Optional(
		Type.Array(
			Type.Object({
				subject: Type.String({ description: "Task subject line" }),
				description: Type.Optional(Type.String({ description: "Long-form task description" })),
				activeForm: Type.Optional(Type.String({ description: ACTIVE_FORM })),
			}),
			{ description: "Batch create: several tasks in one call, one-of with subject." },
		),
	),
});

function listLine(task: Task): string {
	const form = task.status === "in_progress" && task.activeForm ? ` (${displayText(task.activeForm)})` : "";
	return `[${task.status}] #${task.id} ${displayText(task.subject)}${form}`;
}

function getLines(task: Task): string {
	const lines = [`#${task.id} [${task.status}] ${displayText(task.subject)}`];
	if (task.description) lines.push(`  description: ${displayText(task.description)}`);
	if (task.activeForm) lines.push(`  activeForm: ${displayText(task.activeForm)}`);
	return lines.join("\n");
}

export function resultText(op: Op, state: TaskState): string {
	switch (op.kind) {
		case "create":
			return op.ids
				.map((id) => `Created #${id}: ${displayText(state.tasks.find((task) => task.id === id)!.subject)} (pending)`)
				.join("\n");
		case "update":
			if (!op.changed) return `No change: #${op.id} already matches the requested values (status: ${op.to})`;
			return `Updated #${op.id}${op.from !== op.to ? ` (${op.from} → ${op.to})` : ""}`;
		case "delete":
			return `Deleted #${op.id}: ${displayText(op.subject)}`;
		case "clear":
			return `Cleared ${op.count} tasks`;
		case "list": {
			const tasks = state.tasks.filter(
				(task) => (op.includeDeleted || task.status !== "deleted") && (!op.status || task.status === op.status),
			);
			return tasks.length === 0 ? "No tasks" : tasks.map(listLine).join("\n");
		}
		case "get":
			return getLines(op.task);
		case "error":
			return `Error: ${op.message}`;
	}
}

export function toolResult(params: TaskParams, state: TaskState, op: Op) {
	const { action, ...rest } = params;
	const details: TaskDetails = {
		action,
		params: rest,
		tasks: state.tasks,
		nextId: state.nextId,
		...(op.kind === "error" && { error: op.message }),
	};
	return { content: [{ type: "text" as const, text: resultText(op, state) }], details };
}

export function statusLabel(status: string): string {
	return status.replace("_", " ");
}

function summaryTarget(params: Partial<TaskParams>, state: TaskState): string {
	switch (params.action) {
		case "create":
			return params.subject ?? (params.tasks ? `${params.tasks.length} tasks` : "");
		case "update":
		case "get":
		case "delete": {
			if (params.id === undefined) return "";
			const subject = state.tasks.find((task) => task.id === params.id)?.subject ?? `#${params.id}`;
			return params.action === "update" && params.status ? `${subject} → ${statusLabel(params.status)}` : subject;
		}
		case "list":
			return params.status ? statusLabel(params.status) : "";
		default:
			return "";
	}
}

export function summarizeTodo(params: Partial<TaskParams>, state: TaskState): ToolSummary {
	return {
		label: "Tasks",
		icon: "☷",
		target: displayText([params.action, summaryTarget(params, state)].filter(Boolean).join(" ")),
	};
}
