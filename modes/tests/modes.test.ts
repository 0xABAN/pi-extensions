import { expect, test } from "bun:test";
import modesExtension from "../index.ts";
import { LEARN_MODE_PROMPT } from "../learn.ts";
import { formatModeStatus } from "../status.ts";
import { isSafeCommand, READ_ONLY_TOOLS } from "../utils.ts";

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
	const commands = new Map<string, unknown>();
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
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
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
		commands,
		shortcuts,
		shiftTab: () => shortcuts.get("shift+tab")!.handler(ctx),
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
	await h.shiftTab();
	await h.shiftTab();
	return structuredClone(h.entries());
}

function promptEvent() {
	const sections: Record<string, string> = { unrelated: "keep me" };
	return { systemPromptOptions: { appendSystemPrompt: "Other instructions.\n", sections } };
}

test("shift+tab is the only mode control", async () => {
	const h = await harness();

	expect([...h.commands.keys()]).toEqual([]);
	expect([...h.shortcuts.keys()]).toEqual(["shift+tab"]);
});

test("plan and learn share one read-only tool set", async () => {
	const h = await harness();
	const readOnly = [
		"read", "grep", "find", "ls", "bash",
		"codemode",
		"web_search", "fetch_content", "get_search_content",
		"ask_user_question", "intercom",
	];

	await h.shiftTab();
	expect(h.mode()).toMatch(/plan mode$/);
	expect(h.tools()).toEqual(readOnly);

	await h.shiftTab();
	expect(h.mode()).toBe(LEARN_LABEL);
	expect(h.tools()).toEqual(readOnly);
});

for (const [mode, presses] of [["plan", 1], ["learn", 2]] as const) {
	test(`${mode} blocks every other tool and unsafe bash, including nested calls`, async () => {
		const h = await harness();
		for (let i = 0; i < presses; i++) await h.shiftTab();

		const blocked = ["powershell", "edit", "write", "tool_search", "todo", "Agent", "SubagentWorkflow", "source_check", "custom_tool", "mcp_write"];
		for (const toolName of blocked) {
			for (const parentToolCallId of [undefined, "outer-tool"]) {
				const result = await h.emit("tool_call", { toolName, input: {}, parentToolCallId });
				expect({ toolName, block: result?.block }).toEqual({ toolName, block: true });
				expect(result.reason).toStartWith(`${mode} mode permits only read, grep`);
			}
		}

		for (const toolName of READ_ONLY_TOOLS) {
			for (const parentToolCallId of [undefined, "outer-tool"]) {
				expect(await h.emit("tool_call", { toolName, input: { command: "git status" }, parentToolCallId })).toBeUndefined();
			}
		}

		for (const parentToolCallId of [undefined, "outer-tool"]) {
			const result = await h.emit("tool_call", { toolName: "bash", input: { command: "rm file" }, parentToolCallId });
			expect(result.block).toBe(true);
			expect(result.reason).toStartWith(`${mode} mode: command blocked`);
			expect(result.reason).toContain("press Shift+Tab");
		}
	});
}

test("every part of a bash command must be allowlisted", () => {
	const allowed = [
		"git status",
		"cd x && sed -n '1,5p' f",
		'grep -E "a|b" f',
		"ls 2>/dev/null",
		"git log 2>&1 | head -5",
	];
	const blocked = [
		"rm file",
		"cat x && python s.py",
		"cat x & python s.py",
		"cat x\npython s.py",
		"cat $(which python)",
		"cat `which python`",
		"cat <(python s.py)",
		"ls > f",
		"ls 2>/dev/null > f",
		'grep "unclosed f',
		"",
	];

	for (const command of allowed) {
		expect({ command, safe: isSafeCommand(command) }).toEqual({ command, safe: true });
	}

	for (const command of blocked) {
		expect({ command, safe: isSafeCommand(command) }).toEqual({ command, safe: false });
	}
});

test("learn sends its policy as the learn_mode section, only while learning", async () => {
	const h = await harness();
	const untouched = promptEvent().systemPromptOptions;

	const turn = async () => {
		const event = promptEvent();
		await h.emit("before_agent_start", event);
		return event.systemPromptOptions;
	};

	expect(await turn()).toEqual(untouched);

	await h.shiftTab();
	expect(await turn()).toEqual(untouched);

	await h.shiftTab();
	expect(await turn()).toEqual({
		appendSystemPrompt: "Other instructions.\n",
		sections: { unrelated: "keep me", learn_mode: LEARN_MODE_PROMPT },
	});

	await h.shiftTab();
	expect(await turn()).toEqual(untouched);
});

test("learn's policy reaches turns without a UI", async () => {
	const h = await harness({ flags: { learn: true } });
	const event = promptEvent();
	h.ctx.hasUI = false;

	await h.emit("before_agent_start", event);
	expect(event.systemPromptOptions.sections.learn_mode).toBe(LEARN_MODE_PROMPT);
});

test("learn adds a hidden note to every turn, and other modes do not", async () => {
	const h = await harness();
	const note = async () => (await h.emit("before_agent_start", promptEvent()))?.message;
	const learnNote = {
		customType: "learn-mode-context",
		content: expect.stringContaining("follow the <learn_mode> rules"),
		display: false,
	};

	expect(await note()).toBeUndefined();

	await h.shiftTab();
	expect((await note()).customType).toBe("plan-mode-context");

	await h.shiftTab();
	expect(await note()).toEqual(learnNote);
	expect(await note()).toEqual(learnNote);

	await h.shiftTab();
	expect(await note()).toBeUndefined();
});

test("each mode keeps only its own notes in context, and the lesson in all of them", async () => {
	const planNote = { role: "custom", customType: "plan-mode-context", content: "Produce a plan." };
	const execute = { role: "custom", customType: "plan-mode-execute", content: "Execute the plan." };
	const learnNote = { role: "custom", customType: "learn-mode-context", content: "Guide, don't solve." };
	const explanation = { role: "assistant", content: [{ type: "text", text: "A return exits the whole function." }] };
	const lesson = { role: "user", content: "I understand return. I have not traced the loop yet." };

	const h = await harness();
	const context = async () => {
		const messages = [planNote, execute, learnNote, explanation, lesson];
		return (await h.emit("context", { messages })).messages;
	};

	expect(await context()).toEqual([execute, explanation, lesson]);

	await h.shiftTab();
	expect(await context()).toEqual([planNote, execute, explanation, lesson]);

	await h.shiftTab();
	expect(await context()).toEqual([learnNote, explanation, lesson]);

	await h.shiftTab();
	expect(await context()).toEqual([execute, explanation, lesson]);
});

test("learn never offers to execute a Plan section", async () => {
	const h = await harness({ flags: { learn: true } });

	await h.emit("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "Plan:\n1. Implement a solution" }] }] });
	expect(h.sent).toHaveLength(0);
});

test("a full cycle back to build restores the original tools and allows edits", async () => {
	const h = await harness();
	await h.shiftTab();
	await h.shiftTab();
	await h.shiftTab();

	expect(h.mode()).toMatch(/build mode$/);
	expect(h.tools()).toEqual(BUILD_TOOLS);
	expect(await h.emit("tool_call", { toolName: "edit", input: {} })).toBeUndefined();
});

test("refuses to change modes while a turn is running", async () => {
	const h = await harness();
	h.setIdle(false);
	const before = structuredClone(h.entries());

	await h.shiftTab();
	expect(h.mode()).toMatch(/build mode$/);
	expect(h.entries()).toEqual(before);
	expect(h.notices).toHaveLength(1);
});

test("reload restores learn from the saved build tools, and the tree follows the branch", async () => {
	const saved = await savedLearn();
	const resumed = await harness({ entries: saved, tools: [...READ_ONLY_TOOLS], reason: "reload" });
	expect(resumed.mode()).toBe(LEARN_LABEL);

	await resumed.shiftTab();
	expect(resumed.tools()).toEqual(BUILD_TOOLS);

	resumed.setBranch(saved);
	await resumed.emit("session_tree");
	expect(resumed.mode()).toBe(LEARN_LABEL);

	resumed.setBranch([]);
	await resumed.emit("session_tree");
	expect(resumed.mode()).toMatch(/build mode$/);
	expect(resumed.tools()).toEqual(BUILD_TOOLS);
});

test("does not enable tools the user disabled before switching", async () => {
	const limited = await harness({ tools: ["read", "custom_tool"] });
	expect(limited.tools()).toEqual(["read", "custom_tool"]);

	await limited.shiftTab();
	await limited.shiftTab();
	await limited.shiftTab();
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
