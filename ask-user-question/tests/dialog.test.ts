import { beforeAll, expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import askUserQuestion from "../index.ts";

type Callback = (...args: any[]) => any;

const KEY = {
	enter: "\r",
	escape: "\x1b",
	down: "\x1b[B",
	up: "\x1b[A",
	left: "\x1b[D",
	space: " ",
	newline: "\x1b[13;2u",
	clear: "\x15",
};

const theme = new Proxy(
	{},
	{
		get:
			() =>
			(...args: string[]) =>
				args.at(-1),
	},
);

const database = {
	question: "Which database should the service use?",
	header: "Database",
	options: [
		{ label: "PostgreSQL", description: "Relational" },
		{ label: "SQLite", description: "A single file" },
	],
};

const features = {
	question: "Which features should ship?",
	header: "Features",
	multiSelect: true,
	options: [
		{ label: "Search", description: "Full-text search" },
		{ label: "Export", description: "CSV export" },
	],
};

const layout = {
	question: "Which layout should the settings page use?",
	header: "Layout",
	options: [
		{ label: "Sidebar", description: "Sections in a left rail", preview: "```\n| Menu | Content |\n```" },
		{ label: "Tabs", description: "Sections as tabs on top", preview: "```\n| Gen | Key |\n```" },
	],
};

beforeAll(() => initTheme("dark"));

type Component = { render(width: number): string[]; handleInput(data: string): void };

function open(questions: unknown[], { hasUI = true, rows = 40, columns = 100 } = {}) {
	let execute!: Callback;
	let component!: Component;
	const blocked: unknown[] = [];
	const pi = {
		registerTool: (tool: { execute: Callback }) => {
			execute = tool.execute;
		},
	};
	askUserQuestion(pi as never);

	const ctx = {
		hasUI,
		ui: {
			custom: (factory: Callback, options: { blocked: unknown }) =>
				new Promise((resolve) => {
					blocked.push(options.blocked);
					component = factory(
						{ terminal: { rows, columns }, requestRender() {} },
						theme,
						new KeybindingsManager(TUI_KEYBINDINGS),
						resolve,
					);
				}),
		},
	};
	const result = execute("call", { questions }, undefined, undefined, ctx) as Promise<{
		content: { text: string }[];
		details: { cancelled: boolean; error?: string };
	}>;
	const press = (...keys: string[]) => {
		for (const key of keys) component.handleInput(key);
	};
	const lines = () => component.render(columns).map(stripTerminalSequences);
	const screen = () => lines().join("\n");
	return { result, press, screen, lines, blocked };
}

test("answers a question with its digit and reports pi as waiting on a question", async () => {
	const dialog = open([database]);
	dialog.press("1");

	const { content } = await dialog.result;
	expect(content[0]!.text).toContain('"Which database should the service use?"="PostgreSQL"');
	expect(dialog.blocked).toEqual([{ kind: "question", message: database.question }]);
});

test("takes a typed answer from the Type something row", async () => {
	const dialog = open([database]);
	dialog.press(KEY.down, KEY.down, ..."Postgres with pgvector", KEY.enter);

	expect((await dialog.result).content[0]!.text).toContain('="Postgres with pgvector"');
});

test("adds a note to an answer", async () => {
	const dialog = open([database]);
	dialog.press("n", ..."we already run it", KEY.enter, "2");

	expect((await dialog.result).content[0]!.text).toContain("user notes: we already run it");
});

test("toggles several options and continues from Next", async () => {
	const dialog = open([features]);
	dialog.press(KEY.space, KEY.down, KEY.space, KEY.down, KEY.down, KEY.enter);

	expect((await dialog.result).content[0]!.text).toContain('"Which features should ship?"="Search, Export"');
});

test("walks two questions and submits from the review tab", async () => {
	const dialog = open([database, features]);
	dialog.press("2", "1", KEY.down, KEY.down, KEY.down, KEY.enter);
	expect(dialog.screen()).toContain("Ready to submit your answers?");
	dialog.press(KEY.enter);

	const { content } = await dialog.result;
	expect(content[0]!.text).toContain('="SQLite"');
	expect(content[0]!.text).toContain('="Search"');
});

test("shows the keys in the footer", () => {
	const dialog = open([database]);
	expect(dialog.screen()).toContain("n to add notes · esc to cancel");
});

test("treats escape as declining", async () => {
	const dialog = open([database]);
	dialog.press(KEY.escape);

	const { content, details } = await dialog.result;
	expect(content[0]!.text).toBe("User declined to answer questions");
	expect(details.cancelled).toBe(true);
});

test("refuses without a UI and rejects reserved labels", async () => {
	expect((await open([database], { hasUI: false }).result).details.error).toBe("no_ui");

	const reserved = { ...database, options: [{ label: "Other", description: "" }, database.options[0]] };
	expect((await open([reserved]).result).details.error).toBe("reserved_label");
});

test("refuses duplicate questions and duplicate labels", async () => {
	expect((await open([database, database]).result).details.error).toBe("duplicate_question");

	const twice = { ...database, options: [database.options[0], database.options[0]] };
	expect((await open([twice]).result).details.error).toBe("duplicate_option_label");
});

test("joins lines typed with shift+enter and clears the draft with ctrl+u", async () => {
	const dialog = open([database]);
	dialog.press(KEY.down, KEY.down, ..."scratch", KEY.clear);
	expect(dialog.screen()).not.toContain("scratch");

	dialog.press(..."first", KEY.newline, ..."second", KEY.enter);
	expect((await dialog.result).content[0]!.text).toContain('="first\nsecond"');
});

test("keeps a typed draft while browsing and sends it with the checked options", async () => {
	const dialog = open([features]);
	dialog.press(KEY.space, "3", ..."Sync", KEY.down, KEY.up);
	expect(dialog.screen()).toContain("[✔] Sync");

	dialog.press(KEY.down, KEY.enter);
	expect((await dialog.result).content[0]!.text).toContain('"Which features should ship?"="Search, Sync"');
});

test("marks the earlier answer when a question is revisited", () => {
	const dialog = open([database, features]);
	dialog.press("2", KEY.left);

	expect(dialog.screen()).toContain("❯ 2. SQLite ✔");
});

test("sends a note per question and a global note from the review tab", async () => {
	const dialog = open([database, features]);
	dialog.press("n", ..."we run it already", KEY.enter, "1");
	dialog.press(KEY.space, KEY.down, KEY.down, KEY.down, KEY.enter);
	dialog.press("n", ..."ship it", KEY.enter);
	expect(dialog.screen()).toContain("→ ship it");
	dialog.press(KEY.enter);

	const { content } = await dialog.result;
	expect(content[0]!.text).toContain("user notes: we run it already");
	expect(content[0]!.text).toContain("global note: ship it.");
});

test("shows previews beside the options on wide terminals and below them on narrow ones", async () => {
	const wide = open([layout], { columns: 140 });
	expect(wide.lines().some((line) => line.includes("1. Sidebar") && line.includes("┌"))).toBe(true);

	const narrow = open([layout], { columns: 90 });
	const lines = narrow.lines();
	const box = lines.findIndex((line) => line.startsWith("┌"));
	expect(box).toBeGreaterThan(lines.findIndex((line) => line.includes("2. Tabs")));
	expect(lines.slice(box, box + 4).join("\n")).toContain("| Menu | Content |");

	narrow.press(KEY.down);
	expect(narrow.screen()).toContain("| Gen | Key |");
	narrow.press(KEY.enter);
	expect((await narrow.result).content[0]!.text).toContain("selected preview: ```\n| Gen | Key |\n```");
});

test("fits a short terminal and keeps the focused option in view", () => {
	const dialog = open([database, features, layout], { rows: 18 });
	expect(dialog.lines().length).toBeLessThanOrEqual(12);
	expect(dialog.screen()).toContain("❯ 1. PostgreSQL");

	dialog.press(KEY.down, KEY.down);
	expect(dialog.lines().length).toBeLessThanOrEqual(12);
	expect(dialog.screen()).toContain("❯ 3.");
});
