import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";
export type TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear";

export interface TaskInput {
	subject?: string;
	description?: string;
	activeForm?: string;
}

export interface TaskParams extends TaskInput {
	action: TaskAction;
	status?: TaskStatus;
	id?: number;
	includeDeleted?: boolean;
	tasks?: TaskInput[];
}

export interface Task {
	id: number;
	subject: string;
	description?: string;
	activeForm?: string;
	status: TaskStatus;
}

export interface TaskState {
	tasks: Task[];
	nextId: number;
}

export interface TaskDetails {
	action: TaskAction;
	params: Omit<TaskParams, "action">;
	tasks: Task[];
	nextId: number;
	error?: string;
}

export type Op =
	| { kind: "create"; ids: number[] }
	| { kind: "update"; id: number; from: TaskStatus; to: TaskStatus; changed: boolean }
	| { kind: "delete"; id: number; subject: string }
	| { kind: "list"; status?: TaskStatus; includeDeleted: boolean }
	| { kind: "get"; task: Task }
	| { kind: "clear"; count: number }
	| { kind: "error"; message: string };

export const STATE_ENTRY = "rpiv-todo-state";
export const REMINDER_TYPE = "todo-nudge";

const STATUSES: readonly TaskStatus[] = ["pending", "in_progress", "completed", "deleted"];

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
	pending: ["in_progress", "completed", "deleted"],
	in_progress: ["pending", "completed", "deleted"],
	completed: ["deleted"],
	deleted: [],
};

export function emptyState(): TaskState {
	return { tasks: [], nextId: 1 };
}

export function visibleTasks(state: TaskState): Task[] {
	return state.tasks.filter((task) => task.status !== "deleted");
}

export function openTasks(state: TaskState): Task[] {
	return state.tasks.filter((task) => task.status === "pending" || task.status === "in_progress");
}

export function changesState(op: Op): boolean {
	return op.kind === "create" || op.kind === "delete" || op.kind === "clear" || (op.kind === "update" && op.changed);
}

function newTask(id: number, input: TaskInput): Task {
	const task: Task = { id, subject: input.subject!, status: "pending" };
	if (input.description) task.description = input.description;
	if (input.activeForm) task.activeForm = input.activeForm;
	return task;
}

function error(state: TaskState, message: string): { state: TaskState; op: Op } {
	return { state, op: { kind: "error", message } };
}

function create(state: TaskState, params: TaskParams): { state: TaskState; op: Op } {
	const inputs = params.tasks ?? [params];
	if (params.tasks && params.subject !== undefined) return error(state, "create takes subject or tasks[], not both");
	if (params.tasks && (params.description !== undefined || params.activeForm !== undefined)) {
		return error(state, "create with tasks[] takes description and activeForm on each item");
	}
	if (inputs.length === 0) return error(state, "tasks[] must not be empty");

	const missing = inputs.findIndex((input) => !input.subject?.trim());
	if (missing !== -1)
		return error(state, params.tasks ? `tasks[${missing}]: subject required` : "subject required for create");

	const created = inputs.map((input, index) => newTask(state.nextId + index, input));
	return {
		state: { tasks: [...state.tasks, ...created], nextId: state.nextId + created.length },
		op: { kind: "create", ids: created.map((task) => task.id) },
	};
}

function update(state: TaskState, params: TaskParams): { state: TaskState; op: Op } {
	if (params.id === undefined) return error(state, "id required for update");
	const index = state.tasks.findIndex((task) => task.id === params.id);
	if (index === -1) return error(state, `#${params.id} not found`);

	const current = state.tasks[index]!;
	const { subject, description, activeForm, status } = params;
	if (subject === undefined && description === undefined && activeForm === undefined && status === undefined) {
		return error(state, "update requires subject, description, activeForm, or status");
	}
	if (status !== undefined && status !== current.status && !TRANSITIONS[current.status].includes(status)) {
		return error(state, `illegal transition ${current.status} → ${status}`);
	}

	const updated: Task = {
		...current,
		...(subject !== undefined && { subject }),
		...(description !== undefined && { description }),
		...(activeForm !== undefined && { activeForm }),
		...(status !== undefined && { status }),
	};
	const tasks = state.tasks.with(index, updated);
	const changed = JSON.stringify(updated) !== JSON.stringify(current);
	return {
		state: { tasks, nextId: state.nextId },
		op: { kind: "update", id: updated.id, from: current.status, to: updated.status, changed },
	};
}

export function applyTaskAction(state: TaskState, params: TaskParams): { state: TaskState; op: Op } {
	switch (params.action) {
		case "create":
			return create(state, params);
		case "update":
			return update(state, params);
		case "list":
			return { state, op: { kind: "list", status: params.status, includeDeleted: params.includeDeleted === true } };
		case "get": {
			if (params.id === undefined) return error(state, "id required for get");
			const task = state.tasks.find((candidate) => candidate.id === params.id);
			return task ? { state, op: { kind: "get", task } } : error(state, `#${params.id} not found`);
		}
		case "delete": {
			if (params.id === undefined) return error(state, "id required for delete");
			const index = state.tasks.findIndex((task) => task.id === params.id);
			if (index === -1) return error(state, `#${params.id} not found`);
			const task = state.tasks[index]!;
			if (task.status === "deleted") return error(state, `#${task.id} is already deleted`);
			return {
				state: { tasks: state.tasks.with(index, { ...task, status: "deleted" }), nextId: state.nextId },
				op: { kind: "delete", id: task.id, subject: task.subject },
			};
		}
		case "clear":
			return { state: emptyState(), op: { kind: "clear", count: state.tasks.length } };
	}
}

function isTask(value: unknown): value is Task {
	const task = value as Partial<Task> | null;
	return (
		typeof task === "object" &&
		task !== null &&
		Number.isSafeInteger(task.id) &&
		typeof task.subject === "string" &&
		STATUSES.includes(task.status!)
	);
}

export function isTaskDetails(value: unknown): value is TaskDetails {
	const details = value as Partial<TaskDetails> | null;
	return (
		typeof details === "object" &&
		details !== null &&
		Array.isArray(details.tasks) &&
		details.tasks.every(isTask) &&
		Number.isSafeInteger(details.nextId)
	);
}

export function replay(branch: readonly SessionEntry[]): TaskState {
	let fromEntries: TaskDetails | undefined;
	let fromResults: TaskDetails | undefined;

	for (const entry of branch) {
		if (entry.type === "custom" && entry.customType === STATE_ENTRY && isTaskDetails(entry.data)) {
			fromEntries = entry.data;
		} else if (
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolName === "todo" &&
			isTaskDetails(entry.message.details)
		) {
			fromResults = entry.message.details;
		}
	}

	const latest = fromEntries ?? fromResults;
	return latest ? { tasks: latest.tasks.map((task) => ({ ...task })), nextId: latest.nextId } : emptyState();
}

export function lastReminder(branch: readonly SessionEntry[]): string | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type === "compaction") return undefined;
		if (entry.type === "custom_message" && entry.customType === REMINDER_TYPE && typeof entry.content === "string") {
			return entry.content;
		}
	}
	return undefined;
}

export function displayText(value: string): string {
	return value
		.replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
		.replace(/(?:\u001b\]|\u009d)[^\u0007\u009c\u001b]*(?:\u0007|\u009c|\u001b\\)?/g, "")
		.replace(/\u001b./g, "")
		.replace(/[\u2028\u2029\n\r\t]/g, " ")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
		.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}
