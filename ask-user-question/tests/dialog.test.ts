import { beforeAll, expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import askUserQuestion from "../index.ts";

const KEY = {
	enter: "\r",
	escape: "\x1b",
	down: "\x1b[B",
	space: " ",
	collapse: "\x1d",
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

beforeAll(() => initTheme("dark"));

type Component = { render(width: number): string[]; handleInput(data: string): void };

function open(questions: unknown[], hasUI = true) {
	let execute!: Function;
	let component!: Component;
	const blocked: unknown[] = [];
	const pi = { registerTool: (tool: { execute: Function }) => (execute = tool.execute) };
	askUserQuestion(pi as never);

	const ctx = {
		hasUI,
		ui: {
			custom: (factory: Function, options: { blocked: unknown }) =>
				new Promise((resolve) => {
					blocked.push(options.blocked);
					component = factory(
						{ terminal: { rows: 40, columns: 100 }, requestRender() {} },
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
	const screen = () => component.render(100).map(stripTerminalSequences).join("\n");
	return { result, press, screen, blocked };
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

test("collapses to one hint row and expands again", () => {
	const dialog = open([database]);
	expect(dialog.screen()).toContain("n to add notes · esc to cancel · ctrl+] to collapse");

	dialog.press(KEY.collapse);
	expect(dialog.screen()).toBe(" ctrl+] to expand · esc to cancel ");
	dialog.press(KEY.collapse);
	expect(dialog.screen()).toContain(database.question);
});

test("treats escape as declining", async () => {
	const dialog = open([database]);
	dialog.press(KEY.escape);

	const { content, details } = await dialog.result;
	expect(content[0]!.text).toBe("User declined to answer questions");
	expect(details.cancelled).toBe(true);
});

test("refuses without a UI and rejects reserved labels", async () => {
	expect((await open([database], false).result).details.error).toBe("no_ui");

	const reserved = { ...database, options: [{ label: "Other", description: "" }, database.options[0]] };
	expect((await open([reserved]).result).details.error).toBe("reserved_label");
});
