import { expect, test } from "bun:test";
import todoExtension from "../index.ts";
import { applyTaskAction, emptyState, lastReminder, replay, type TaskState } from "../tasks.ts";
import { summarizeTodo } from "../tool.ts";
import { formatTodoList, renderTodoPanel } from "../widget.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	strikethrough: (text: string) => `~${text}~`,
} as never;

function run(state: TaskState, ...actions: Record<string, unknown>[]): TaskState {
	for (const action of actions) state = applyTaskAction(state, action as never).state;
	return state;
}

function fakePi() {
	const tools = new Map<string, { execute: Function; summarize: Function }>();
	const handlers = new Map<string, Function>();
	const commands = new Map<string, { handler: Function }>();
	const branch: Record<string, unknown>[] = [];
	const notices: string[] = [];
	const widgets = new Map<string, unknown>();
	const ctx = {
		sessionManager: { getBranch: () => branch },
		ui: {
			theme,
			notify: (text: string) => notices.push(text),
			setWidget: (key: string, factory: unknown) => (factory ? widgets.set(key, factory) : widgets.delete(key)),
			getToolsExpanded: () => false,
		},
	};
	const pi = {
		registerTool: (tool: { name: string; execute: Function; summarize: Function }) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: { handler: Function }) => commands.set(name, command),
		appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
		on: (event: string, handler: Function) => handlers.set(event, handler),
	};
	todoExtension(pi as never);

	const call = (params: Record<string, unknown>) =>
		tools.get("todo")!.execute("call", params, undefined, undefined, ctx);
	const turn = async () => {
		const result = await handlers.get("before_agent_start")!({}, ctx);
		if (result)
			branch.push({
				type: "custom_message",
				customType: result.message.customType,
				content: result.message.content,
			});
		return result?.message.content as string | undefined;
	};
	const event = (name: string) => handlers.get(name)!({}, ctx);
	return { call, turn, event, branch, notices, widgets, commands, ctx, summarize: tools.get("todo")!.summarize };
}

test("creates, updates and deletes tasks within the allowed transitions", () => {
	const state = run(
		emptyState(),
		{ action: "create", tasks: [{ subject: "Read notes" }, { subject: "Write summary" }] },
		{ action: "update", id: 1, status: "in_progress", activeForm: "reading" },
		{ action: "delete", id: 2 },
	);

	expect(state.tasks).toEqual([
		{ id: 1, subject: "Read notes", status: "in_progress", activeForm: "reading" },
		{ id: 2, subject: "Write summary", status: "deleted" },
	]);
	expect(state.nextId).toBe(3);

	const completed = run(state, { action: "update", id: 1, status: "completed" });
	expect(applyTaskAction(completed, { action: "update", id: 1, status: "in_progress" }).op).toEqual({
		kind: "error",
		message: "illegal transition completed → in_progress",
	});
	expect(applyTaskAction(completed, { action: "update", id: 1, status: "completed" }).op).toMatchObject({
		changed: false,
	});
	expect(applyTaskAction(emptyState(), { action: "create", subject: "a", tasks: [] }).op.kind).toBe("error");
});

test("replays the latest state entry, falling back to old tool results", () => {
	const snapshot = (subject: string) => ({
		action: "create",
		params: {},
		tasks: [{ id: 1, subject, status: "pending" }],
		nextId: 2,
	});
	const toolResult = {
		type: "message",
		message: { role: "toolResult", toolName: "todo", details: snapshot("from result") },
	};

	expect(replay([toolResult] as never).tasks[0]!.subject).toBe("from result");
	expect(
		replay([{ type: "custom", customType: "rpiv-todo-state", data: snapshot("from entry") }, toolResult] as never)
			.tasks[0]!.subject,
	).toBe("from entry");
	expect(
		replay([{ type: "custom", customType: "rpiv-todo-state", data: { tasks: ["broken"], nextId: 2 } }] as never),
	).toEqual(emptyState());
});

test("reminds the model of open todos only when the list changed", async () => {
	const app = fakePi();
	await app.event("session_start");
	expect(await app.turn()).toBeUndefined();

	await app.call({ action: "create", subject: "Read notes" });
	expect(await app.turn()).toContain("#1 [pending] Read notes");
	expect(await app.turn()).toBeUndefined();

	await app.call({ action: "update", id: 1, status: "in_progress" });
	expect(await app.turn()).toContain("#1 [in_progress] Read notes");

	await app.event("session_compact");
	expect(await app.turn()).toContain("#1 [in_progress] Read notes");
	await app.event("session_start");
	expect(await app.turn()).toBeUndefined();
});

test("finds the last reminder unless a compaction came after it", () => {
	const reminder = { type: "custom_message", customType: "todo-nudge", content: "Open todos" };

	expect(lastReminder([reminder] as never)).toBe("Open todos");
	expect(lastReminder([reminder, { type: "compaction" }] as never)).toBeUndefined();
});

test("clears the list once every task is completed and names the task in the row", async () => {
	const app = fakePi();
	await app.event("session_start");
	await app.call({ action: "create", tasks: [{ subject: "Read notes" }, { subject: "Say hi" }] });
	await app.call({ action: "update", id: 1, status: "completed" });
	expect(app.notices).toEqual([]);
	expect(app.widgets.has("todos")).toBe(true);

	const last = { action: "update", id: 2, status: "completed" };
	const result = await app.call(last);

	expect(app.notices).toEqual(["◇ All todos done — cleared"]);
	expect(app.widgets.has("todos")).toBe(false);
	expect(app.branch.at(-1)).toMatchObject({ customType: "rpiv-todo-state", data: { action: "clear", tasks: [] } });
	expect(app.summarize(last, result).target).toBe("update Say hi → completed");
	expect(app.summarize(last).target).toBe("update #2 → completed");
});

test("summarizes each action with the task it acts on", () => {
	const state = { tasks: [{ id: 3, subject: "Read notes", status: "pending" as const }], nextId: 4 };

	expect(summarizeTodo({ action: "create", subject: "Say hi" }, state).target).toBe("create Say hi");
	expect(summarizeTodo({ action: "create", tasks: [{ subject: "a" }, { subject: "b" }] }, state).target).toBe(
		"create 2 tasks",
	);
	expect(summarizeTodo({ action: "update", id: 3, status: "in_progress" }, state).target).toBe(
		"update Read notes → in progress",
	);
	expect(summarizeTodo({ action: "clear" }, state)).toEqual({ label: "Tasks", icon: "☷", target: "clear" });
});

test("draws the panel as a tree and folds completed tasks first when it overflows", () => {
	const state = run(
		emptyState(),
		{ action: "create", tasks: Array.from({ length: 16 }, (_, index) => ({ subject: `Task ${index + 1}` })) },
		{ action: "update", id: 1, status: "completed" },
		{ action: "update", id: 2, status: "in_progress", activeForm: "working" },
	);

	const lines = renderTodoPanel(state, theme, 60, false);

	expect(lines[0]).toBe(" ◈ Todos (1/16)");
	expect(lines[1]).toBe(" ├─ ◈ Task 2 (working)");
	expect(lines.at(-2)).toBe(" ╰─ +4 more (1 completed, 3 open)");
	expect(lines.at(-1)).toBe("");
	expect(lines).toHaveLength(15);
	expect(renderTodoPanel(state, theme, 60, true)).toHaveLength(18);
});

test("lists todos grouped by status for /todos", () => {
	const state = run(
		emptyState(),
		{ action: "create", tasks: [{ subject: "Read" }, { subject: "Write" }] },
		{ action: "update", id: 1, status: "completed" },
	);

	expect(formatTodoList(state, theme)).toBe(
		["◇ 1/2 completed · 1 pending", "◇ Pending", "╰─ ◇ #2 Write", "◇ Completed", "╰─ ✓ #1 ~Read~"].join("\n"),
	);
	expect(formatTodoList(emptyState(), theme)).toBe("◇ No todos yet. Ask the agent to add some!");
});
