import { expect, test } from "bun:test";
import modesExtension from "../index.ts";
import { LEARN_MODE_PROMPT, LEARN_MODE_TOOLS } from "../learn.ts";
import { formatModeStatus } from "../status.ts";

const BUILD_TOOLS = ["read", "bash", "edit", "write", "codemode", "todo", "Agent", "intercom", "custom_tool"];
const LEARN_LABEL = "\uF19D  learn mode";

const stripColor = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

type Entry = { type: string; customType: string; data: any };

interface HarnessOptions {
	entries?: Entry[];
	tools?: string[];
	flags?: Record<string, boolean>;
	reason?: string;
}

async function harness({ entries = [], tools = BUILD_TOOLS, flags = {}, reason = "startup" }: HarnessOptions = {}) {
	let branch = structuredClone(entries);
	let activeTools = [...tools];
	let idle = true;
	let choice: string | undefined;

	const handlers = new Map<string, Function>();
	const commands = new Map<string, { handler: Function }>();
	const shortcuts = new Map<string, { handler: Function }>();
	const statuses = new Map<string, string>();
	const flagValues = new Map<string, unknown>();
	const notices: { text: string; level: string }[] = [];
	const sent: any[] = [];

	const ctx = {
		hasUI: true,
		thinkingLevel: "xhigh",
		isIdle: () => idle,
		sessionManager: { getBranch: () => branch },
		ui: {
			theme: { name: "everforest-dark-hard" },
			setStatus: (key: string, text: string) => statuses.set(key, text),
			notify: (text: string, level: string) => notices.push({ text, level }),
			select: async () => choice,
			editor: async () => "",
		},
	};

	modesExtension({
		on: (name: string, handler: Function) => handlers.set(name, handler),
		registerCommand: (name: string, command: { handler: Function }) => commands.set(name, command),
		registerShortcut: (key: string, shortcut: { handler: Function }) => shortcuts.set(key, shortcut),
		registerFlag: (name: string, flag: { default: unknown }) => flagValues.set(name, flags[name] ?? flag.default),
		getFlag: (name: string) => flagValues.get(name),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
		appendEntry: (customType: string, data: unknown) => {
			branch.push({ type: "custom", customType, data: structuredClone(data) });
		},
		sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
		sendUserMessage: (content: unknown, options: unknown) => sent.push({ content, options }),
	} as never);

	const emit = (type: string, event: object = {}) => handlers.get(type)?.({ type, ...event }, ctx);
	await emit("session_start", { reason });

	return {
		emit,
		ctx,
		statuses,
		notices,
		sent,
		command: (name: string) => commands.get(name)!.handler("", ctx),
		shortcut: (key: string) => shortcuts.get(key)!.handler(ctx),
		tools: () => activeTools,
		entries: () => branch,
		setBranch: (next: Entry[]) => {
			branch = structuredClone(next);
		},
		setIdle: (value: boolean) => {
			idle = value;
		},
		setChoice: (value: string) => {
			choice = value;
		},
		mode: () => stripColor(statuses.get("agent-mode")!),
	};
}

async function savedLearn() {
	const h = await harness();
	await h.shortcut("shift+tab");
	await h.shortcut("shift+tab");
	return structuredClone(h.entries());
}

function promptEvent() {
	const sections: Record<string, string> = { unrelated: "keep me" };
	return { systemPromptOptions: { appendSystemPrompt: "Other instructions.\n", sections } };
}

test("plan hides edits, keeps other tools, and filters bash", async () => {
	const h = await harness();
	expect(h.mode()).toMatch(/build mode$/);

	await h.shortcut("shift+tab");
	expect(h.mode()).toMatch(/plan mode$/);
	expect(h.tools()).not.toContain("edit");
	expect(h.tools()).toContain("custom_tool");
	expect(h.tools()).toContain("todo");

	expect((await h.emit("tool_call", { toolName: "bash", input: { command: "rm file" } })).block).toBe(true);
	expect(await h.emit("tool_call", { toolName: "bash", input: { command: "git status" } })).toBeUndefined();
});

test("learn blocks every tool outside its list, including nested calls", async () => {
	const h = await harness();
	await h.shortcut("shift+tab");
	await h.shortcut("shift+tab");
	expect(h.mode()).toBe(LEARN_LABEL);
	expect(h.tools()).toEqual([...LEARN_MODE_TOOLS]);

	const blocked = ["bash", "powershell", "edit", "write", "codemode", "tool_search", "todo", "Agent", "SubagentWorkflow", "intercom", "source_check", "custom_tool", "mcp_write"];
	for (const toolName of blocked) {
		for (const parentToolCallId of [undefined, "outer-tool"]) {
			const result = await h.emit("tool_call", { toolName, input: {}, parentToolCallId });
			expect({ toolName, block: result?.block }).toEqual({ toolName, block: true });
		}
	}

	for (const toolName of LEARN_MODE_TOOLS) {
		expect(await h.emit("tool_call", { toolName, input: {} })).toBeUndefined();
	}

	for (const toolName of ["web_search", "fetch_content", "get_search_content"]) {
		expect([...LEARN_MODE_TOOLS]).toContain(toolName);
	}
});

test("learn appends its policy once, and leaving removes only that policy", async () => {
	const h = await harness();
	const event = promptEvent();
	const options = event.systemPromptOptions;

	await h.command("learn");
	await h.emit("before_agent_start", event);
	expect(options.appendSystemPrompt).toContain(LEARN_MODE_PROMPT);
	expect(options.sections.unrelated).toBe("keep me");

	const learnAppendix = options.appendSystemPrompt;
	await h.emit("before_agent_start", event);
	expect(options.appendSystemPrompt).toBe(learnAppendix);

	await h.command("learn");
	await h.emit("before_agent_start", event);
	expect(options.sections).toEqual({ unrelated: "keep me" });
	expect(options.appendSystemPrompt).toBe("Other instructions.\n");

	await h.command("learn");
	await h.command("plan");
	await h.emit("before_agent_start", event);
	expect(options.appendSystemPrompt).toBe("Other instructions.\n");
});

test("learn's policy reaches turns without a UI", async () => {
	const h = await harness({ flags: { learn: true } });
	const event = promptEvent();
	h.ctx.hasUI = false;

	await h.emit("before_agent_start", event);
	expect(event.systemPromptOptions.appendSystemPrompt).toContain(LEARN_MODE_PROMPT);
});

test("learn drops plan notes from context but keeps the lesson", async () => {
	const h = await harness({ flags: { learn: true } });
	const explanation = { role: "assistant", content: [{ type: "text", text: "A return exits the whole function." }] };
	const lesson = { role: "user", content: "I understand return. I have not traced the loop yet." };

	const context = await h.emit("context", {
		messages: [
			{ role: "custom", customType: "plan-mode-context", content: "Produce a plan." },
			{ role: "custom", customType: "plan-mode-execute", content: "Execute the plan." },
			{ role: "user", content: [{ type: "text", text: "[PLAN MODE ACTIVE]" }] },
			explanation,
			lesson,
		],
	});
	expect(context.messages).toEqual([explanation, lesson]);
});

test("learn never offers to execute a Plan section", async () => {
	const h = await harness({ flags: { learn: true } });

	await h.emit("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "Plan:\n1. Implement a solution" }] }] });
	expect(h.sent).toHaveLength(0);
});

test("returning to build restores the original tools and allows edits", async () => {
	const h = await harness();
	await h.shortcut("shift+tab");
	await h.shortcut("shift+tab");
	await h.shortcut("shift+tab");

	expect(h.mode()).toMatch(/build mode$/);
	expect(h.tools()).toEqual(BUILD_TOOLS);
	expect(await h.emit("tool_call", { toolName: "edit", input: {} })).toBeUndefined();
});

test("direct toggles and plan ↔ learn switches keep the original build tools", async () => {
	const h = await harness();

	await h.command("learn");
	await h.command("plan");
	expect(h.mode()).toMatch(/plan mode$/);

	await h.command("learn");
	await h.command("learn");
	expect(h.tools()).toEqual(BUILD_TOOLS);

	await h.shortcut("ctrl+alt+p");
	expect(h.mode()).toMatch(/plan mode$/);
	await h.shortcut("ctrl+alt+p");
	expect(h.mode()).toMatch(/build mode$/);
});

test("refuses to change modes while a turn is running", async () => {
	const h = await harness();
	h.setIdle(false);
	const before = structuredClone(h.entries());

	await h.command("learn");
	await h.shortcut("shift+tab");
	expect(h.mode()).toMatch(/build mode$/);
	expect(h.entries()).toEqual(before);
	expect(h.notices).toHaveLength(2);
});

test("reload restores learn from the saved build tools, and the tree follows the branch", async () => {
	const saved = await savedLearn();
	const resumed = await harness({ entries: saved, tools: [...LEARN_MODE_TOOLS], reason: "reload" });
	expect(resumed.mode()).toBe(LEARN_LABEL);

	await resumed.command("learn");
	expect(resumed.tools()).toEqual(BUILD_TOOLS);

	resumed.setBranch(saved);
	await resumed.emit("session_tree");
	expect(resumed.mode()).toBe(LEARN_LABEL);

	resumed.setBranch([]);
	await resumed.emit("session_tree");
	expect(resumed.mode()).toMatch(/build mode$/);
	expect(resumed.tools()).toEqual(BUILD_TOOLS);
});

test("migrates a legacy plan-mode entry on the next switch", async () => {
	const legacy = await harness({
		entries: [{ type: "custom", customType: "plan-mode", data: { enabled: true, toolsBeforePlanMode: BUILD_TOOLS } }],
	});
	expect(legacy.mode()).toMatch(/plan mode$/);

	await legacy.command("learn");
	expect(legacy.entries().at(-1)!.customType).toBe("agent-mode");

	await legacy.command("learn");
	expect(legacy.tools()).toEqual(BUILD_TOOLS);
});

test("does not enable tools the user disabled before switching", async () => {
	const limited = await harness({ tools: ["read", "custom_tool"] });
	expect(limited.tools()).toEqual(["read", "custom_tool"]);

	await limited.command("learn");
	await limited.command("plan");
	await limited.command("plan");
	expect(limited.tools()).toEqual(["read", "custom_tool"]);
});

test("startup flags override saved state, and learn wins over plan", async () => {
	const saved = await savedLearn();

	expect((await harness({ reason: "new" })).mode()).toMatch(/build mode$/);
	expect((await harness({ entries: saved, reason: "resume" })).mode()).toBe(LEARN_LABEL);
	expect((await harness({ entries: saved, flags: { plan: true } })).mode()).toMatch(/plan mode$/);

	const both = await harness({ flags: { learn: true, plan: true } });
	expect(both.mode()).toBe(LEARN_LABEL);
	expect(both.entries().at(-1)!.data.mode).toBe("learn");

	expect((await harness({ flags: { plan: true } })).mode()).toMatch(/plan mode$/);
});

test("execute switches to build even before pi is idle", async () => {
	const h = await harness({ flags: { plan: true } });
	h.setIdle(false);
	h.setChoice("Execute the plan");

	await h.emit("agent_end", {
		messages: [{ role: "assistant", content: [{ type: "text", text: "Plan:\n1. Implement the feature\n2. Check the behavior" }] }],
	});
	expect(h.mode()).toMatch(/build mode$/);
	expect(h.tools()).toEqual(BUILD_TOOLS);
	expect(h.sent.at(-1).message.customType).toBe("plan-mode-execute");
});

test("mode icons share one neutral color, and everforest learn uses muted teal", () => {
	for (const theme of ["everforest-dark-hard", "everforest-dark-medium", "dark"]) {
		const learn = formatModeStatus("learn", "xhigh", theme);
		const build = formatModeStatus("build", "xhigh", theme);
		const plan = formatModeStatus("plan", "xhigh", theme);

		expect(stripColor(learn.mode)).toBe(LEARN_LABEL);
		expect(stripColor(learn.thinking)).toBe("think:xhigh");
		expect(learn.thinking).not.toBe(build.thinking);
		expect(learn.thinking).not.toBe(plan.thinking);
		expect(learn.mode.endsWith("\x1b[0m")).toBe(true);

		const iconColor = /^\x1b\[38;2;\d+;\d+;\d+m/.exec(build.mode)?.[0];
		expect(iconColor).toBeDefined();
		expect(learn.mode.startsWith(iconColor!)).toBe(true);
		expect(plan.mode.startsWith(iconColor!)).toBe(true);

		if (theme.startsWith("everforest")) {
			expect(learn.mode.startsWith("\x1b[38;2;211;198;170m")).toBe(true);
			expect(learn.thinking).toContain("\x1b[38;2;127;187;179m");
		}
	}

	expect(formatModeStatus("learn", "xhigh", "everforest-dark-hard")).toEqual(formatModeStatus("learn", "xhigh", "everforest-dark-medium"));
	expect(stripColor(formatModeStatus("learn").thinking)).toBe("think:off");
});

test("the status follows theme and thinking changes", async () => {
	const h = await harness({ flags: { learn: true } });

	h.ctx.ui.theme.name = "dark";
	await h.emit("before_agent_start", promptEvent());
	expect(h.statuses.get("agent-mode")).toBe(formatModeStatus("learn", "xhigh", "dark").mode);

	h.ctx.thinkingLevel = "medium";
	await h.emit("thinking_level_select");
	expect(stripColor(h.statuses.get("agent-thinking")!)).toBe("think:med");
});
