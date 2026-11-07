// Run from the repository root: bun modes/check.mjs
import assert from "node:assert/strict";
import modeExtension from "./index.ts";
import { LEARN_MODE_PROMPT, LEARN_MODE_TOOLS } from "./learn.ts";
import { formatModeStatus } from "./status.ts";

const BUILD_TOOLS = ["read", "bash", "edit", "write", "codemode", "todo", "Agent", "intercom", "custom_tool"];
const stripColor = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

/** Exercise registered handlers without invoking a model or touching a session. */
async function harness({ entries = [], tools = BUILD_TOOLS, flags = {}, reason = "startup" } = {}) {
	let branch = structuredClone(entries);
	let activeTools = [...tools];
	let idle = true;
	let choice;
	const handlers = new Map();
	const commands = new Map();
	const shortcuts = new Map();
	const statuses = new Map();
	const notices = [];
	const sent = [];
	const flagValues = new Map();
	const ctx = {
		hasUI: true,
		thinkingLevel: "xhigh",
		isIdle: () => idle,
		sessionManager: { getBranch: () => branch },
		ui: {
			theme: { name: "everforest-dark-hard" },
			setStatus: (key, text) => statuses.set(key, text),
			notify: (text, level) => notices.push({ text, level }),
			select: async () => choice,
			editor: async () => "",
		},
	};

	modeExtension({
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
		registerShortcut: (key, shortcut) => shortcuts.set(key, shortcut),
		registerFlag: (name, flag) => flagValues.set(name, flags[name] ?? flag.default),
		getFlag: (name) => flagValues.get(name),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names) => { activeTools = [...names]; },
		appendEntry: (customType, data) => branch.push({ type: "custom", customType, data: structuredClone(data) }),
		sendMessage: (message, options) => sent.push({ message, options }),
		sendUserMessage: (content, options) => sent.push({ content, options }),
	});

	const emit = (type, event = {}) => handlers.get(type)?.({ type, ...event }, ctx);
	await emit("session_start", { reason });

	return {
		emit, ctx, statuses, notices, sent,
		command: (name) => commands.get(name).handler("", ctx),
		shortcut: (key) => shortcuts.get(key).handler(ctx),
		tools: () => activeTools,
		entries: () => branch,
		setBranch: (entries) => { branch = structuredClone(entries); },
		setIdle: (value) => { idle = value; },
		setChoice: (value) => { choice = value; },
		mode: () => stripColor(statuses.get("agent-mode")),
	};
}

const h = await harness();
assert.match(h.mode(), /build mode$/);
await h.shortcut("shift+tab");
assert.match(h.mode(), /plan mode$/);
assert(!h.tools().includes("edit"));
assert(h.tools().includes("custom_tool"));
assert(h.tools().includes("todo"));
assert.equal((await h.emit("tool_call", { toolName: "bash", input: { command: "rm file" } })).block, true);
assert.equal(await h.emit("tool_call", { toolName: "bash", input: { command: "git status" } }), undefined);

await h.shortcut("shift+tab");
assert.equal(h.mode(), "\uF19D  learn mode");
assert.deepEqual(h.tools(), [...LEARN_MODE_TOOLS]);

// Deferred and nested tools must not bypass the Learn permission boundary.
for (const toolName of ["bash", "powershell", "edit", "write", "codemode", "tool_search", "todo", "Agent", "SubagentWorkflow", "intercom", "source_check", "custom_tool", "mcp_write"]) {
	for (const parentToolCallId of [undefined, "outer-tool"]) {
		const result = await h.emit("tool_call", { toolName, input: {}, parentToolCallId });
		assert.equal(result.block, true, `Learn allowed ${toolName}`);
	}
}
for (const toolName of LEARN_MODE_TOOLS) {
	assert.equal(await h.emit("tool_call", { toolName, input: {} }), undefined);
}
// Documentation-heavy lessons need search and fetched pages, not only local files.
for (const toolName of ["web_search", "fetch_content", "get_search_content"]) {
	assert(LEARN_MODE_TOOLS.has(toolName), `Learn lacks ${toolName}`);
}

// appendSystemPrompt reaches both native providers and Claude bridge's projection.
const originalAppendix = "Other instructions.\n";
const promptEvent = { systemPromptOptions: { appendSystemPrompt: originalAppendix, sections: { unrelated: "keep me" } } };
await h.emit("before_agent_start", promptEvent);
assert(promptEvent.systemPromptOptions.appendSystemPrompt.includes(LEARN_MODE_PROMPT));
assert.equal(promptEvent.systemPromptOptions.sections.unrelated, "keep me");
const learnAppendix = promptEvent.systemPromptOptions.appendSystemPrompt;
await h.emit("before_agent_start", promptEvent);
assert.equal(promptEvent.systemPromptOptions.appendSystemPrompt, learnAppendix);

// Both tutor explanations and learner progress must survive context filtering.
const explanation = { role: "assistant", content: [{ type: "text", text: "A return exits the whole function." }] };
const lesson = { role: "user", content: "I understand return. I have not traced the loop yet." };
const context = await h.emit("context", { messages: [
	{ role: "custom", customType: "plan-mode-context", content: "Produce a plan." },
	{ role: "custom", customType: "plan-mode-execute", content: "Execute the plan." },
	{ role: "user", content: [{ type: "text", text: "[PLAN MODE ACTIVE]" }] },
	explanation,
	lesson,
] });
assert.deepEqual(context.messages, [explanation, lesson]);
await h.emit("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "Plan:\n1. Implement a solution" }] }] });
assert.equal(h.sent.length, 0, "Learn must not offer to execute a Plan section");

const savedLearn = structuredClone(h.entries());
await h.shortcut("shift+tab");
assert.match(h.mode(), /build mode$/);
assert.deepEqual(h.tools(), BUILD_TOOLS);
await h.emit("before_agent_start", promptEvent);
assert.deepEqual(promptEvent.systemPromptOptions.sections, { unrelated: "keep me" });
assert.equal(promptEvent.systemPromptOptions.appendSystemPrompt, originalAppendix);
assert.equal(await h.emit("tool_call", { toolName: "edit", input: {} }), undefined);

// Direct toggles and Plan ↔ Learn switches retain the original Build tools.
await h.command("learn");
await h.command("plan");
assert.match(h.mode(), /plan mode$/);
await h.emit("before_agent_start", promptEvent);
assert.equal(promptEvent.systemPromptOptions.appendSystemPrompt, originalAppendix);
await h.command("learn");
await h.command("learn");
assert.deepEqual(h.tools(), BUILD_TOOLS);
await h.shortcut("ctrl+alt+p");
assert.match(h.mode(), /plan mode$/);
await h.shortcut("ctrl+alt+p");
assert.match(h.mode(), /build mode$/);

// Refuse changes while instructions or tool calls from a turn are in flight.
h.setIdle(false);
const beforeBusy = structuredClone(h.entries());
await h.command("learn");
await h.shortcut("shift+tab");
assert.match(h.mode(), /build mode$/);
assert.deepEqual(h.entries(), beforeBusy);
assert.equal(h.notices.length, 2);
h.setIdle(true);

// Reload uses persisted Build tools, not the currently restricted tool list.
const resumed = await harness({ entries: savedLearn, tools: [...LEARN_MODE_TOOLS], reason: "reload" });
assert.equal(resumed.mode(), "\uF19D  learn mode");
await resumed.command("learn");
assert.deepEqual(resumed.tools(), BUILD_TOOLS);
resumed.setBranch(savedLearn);
await resumed.emit("session_tree");
assert.equal(resumed.mode(), "\uF19D  learn mode");
resumed.setBranch([]);
await resumed.emit("session_tree");
assert.match(resumed.mode(), /build mode$/);
assert.deepEqual(resumed.tools(), BUILD_TOOLS);

const legacy = await harness({ entries: [{
	type: "custom", customType: "plan-mode",
	data: { enabled: true, toolsBeforePlanMode: BUILD_TOOLS },
}] });
assert.match(legacy.mode(), /plan mode$/);
await legacy.command("learn");
assert.equal(legacy.entries().at(-1).customType, "agent-mode");
await legacy.command("learn");
assert.deepEqual(legacy.tools(), BUILD_TOOLS);

// Do not enable tools the user had deliberately disabled before learning.
const limited = await harness({ tools: ["read", "custom_tool"] });
assert.deepEqual(limited.tools(), ["read", "custom_tool"]);
await limited.command("learn");
await limited.command("plan");
await limited.command("plan");
assert.deepEqual(limited.tools(), ["read", "custom_tool"]);

const fresh = await harness({ reason: "new" });
assert.match(fresh.mode(), /build mode$/);
const resumeLearn = await harness({ entries: savedLearn, reason: "resume" });
assert.equal(resumeLearn.mode(), "\uF19D  learn mode");
const override = await harness({ entries: savedLearn, flags: { plan: true } });
assert.match(override.mode(), /plan mode$/);

const startup = await harness({ flags: { learn: true, plan: true } });
assert.equal(startup.mode(), "\uF19D  learn mode");
assert.equal(startup.entries().at(-1).data.mode, "learn");
const startPlan = await harness({ flags: { plan: true } });
assert.match(startPlan.mode(), /plan mode$/);
const noUi = await harness({ flags: { learn: true } });
noUi.ctx.hasUI = false;
await noUi.emit("before_agent_start", promptEvent);
assert(promptEvent.systemPromptOptions.appendSystemPrompt.includes(LEARN_MODE_PROMPT));

// The existing Execute flow may transition from agent_end before Pi is idle.
await h.command("plan");
h.setIdle(false);
h.setChoice("Execute the plan");
await h.emit("agent_end", { messages: [{ role: "assistant", content: [{
	type: "text", text: "Plan:\n1. Implement the feature\n2. Check the behavior",
}] }] });
assert.match(h.mode(), /build mode$/);
assert.deepEqual(h.tools(), BUILD_TOOLS);
assert.equal(h.sent.at(-1).message.customType, "plan-mode-execute");

// Mode icons share one neutral color; Everforest Learn uses its muted teal accent.
for (const theme of ["everforest-dark-hard", "everforest-dark-medium", "dark"]) {
	const learn = formatModeStatus("learn", "xhigh", theme);
	const build = formatModeStatus("build", "xhigh", theme);
	const plan = formatModeStatus("plan", "xhigh", theme);
	assert.equal(stripColor(learn.mode), "\uF19D  learn mode");
	assert.equal(stripColor(learn.thinking), "think:xhigh");
	assert.notEqual(learn.thinking, build.thinking);
	assert.notEqual(learn.thinking, plan.thinking);
	assert(learn.mode.endsWith("\x1b[0m"));

	const iconColor = /^\x1b\[38;2;\d+;\d+;\d+m/.exec(build.mode)?.[0];
	assert(iconColor);
	assert(learn.mode.startsWith(iconColor));
	assert(plan.mode.startsWith(iconColor));
	if (theme.startsWith("everforest")) {
		assert(learn.mode.startsWith("\x1b[38;2;211;198;170m"));
		assert(learn.thinking.includes("\x1b[38;2;127;187;179m"));
	}
}
assert.deepEqual(
	formatModeStatus("learn", "xhigh", "everforest-dark-hard"),
	formatModeStatus("learn", "xhigh", "everforest-dark-medium"),
);
assert.equal(stripColor(formatModeStatus("learn").thinking), "think:off");
startup.ctx.ui.theme.name = "dark";
await startup.emit("before_agent_start", promptEvent);
assert.equal(startup.statuses.get("agent-mode"), formatModeStatus("learn", "xhigh", "dark").mode);
startup.ctx.thinkingLevel = "medium";
await startup.emit("thinking_level_select");
assert.equal(stripColor(startup.statuses.get("agent-thinking")), "think:med");
console.log("Mode checks passed: transitions, tool guards, prompts, persistence, and Learn colors.");
