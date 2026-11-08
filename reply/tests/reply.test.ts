import { expect, test } from "bun:test";
import { collectCandidates, formatQuote, QuotePicker, type QuoteCandidate, reply } from "../index.ts";

const timestamp = "2026-11-07T12:00:00.000Z";

const branch = [
	{ type: "message", id: "aaa111", timestamp, message: { role: "user", content: "How do I rename a branch?" } },
	{ type: "custom", id: "ccc333", timestamp, customType: "note", data: {} },
	{
		type: "message",
		id: "bbb222",
		timestamp,
		message: { role: "assistant", content: [{ type: "text", text: "Use git branch -m.\n\nThen push." }, { type: "toolCall" }] },
	},
	{ type: "message", id: "ddd444", timestamp, message: { role: "toolResult", content: "ignored" } },
] as never;

function context(editorText = "") {
	const notices: string[] = [];
	let text = editorText;
	const ctx = {
		sessionManager: { getBranch: () => branch },
		ui: {
			notify: (message: string) => notices.push(message),
			getEditorText: () => text,
			setEditorText: (value: string) => {
				text = value;
			},
		},
	};
	return { ctx: ctx as never, notices, text: () => text };
}

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text } as never;

test("collects user and assistant text, newest first", () => {
	const candidates = collectCandidates(branch);

	expect(candidates.map((candidate) => [candidate.id, candidate.role, candidate.text])).toEqual([
		["bbb222", "assistant", "Use git branch -m.\n\nThen push."],
		["aaa111", "user", "How do I rename a branch?"],
	]);
});

test("formats a quote as a block followed by a reply prompt", () => {
	const [candidate] = collectCandidates(branch);

	expect(formatQuote(candidate!)).toBe(
		"Quoted previous assistant message bbb222 for reference only:\n\n> Use git branch -m.\n>\n> Then push.\n\nMy reply:\n",
	);
});

test("inserts the quote for a unique id prefix before the current draft", async () => {
	const { ctx, notices, text } = context("draft");

	await reply("#aaa", ctx);

	expect(text()).toStartWith("Quoted previous user message aaa111");
	expect(text()).toEndWith("My reply:\ndraft");
	expect(notices).toEqual(["Inserted quote from user message aaa111."]);
});

test("reports an id prefix that matches nothing", async () => {
	const { ctx, notices } = context();

	await reply("zzz", ctx);

	expect(notices).toEqual(['No quotable message matches id "zzz".']);
});

test("the picker filters by typed text and quotes the selection", () => {
	let picked: QuoteCandidate | undefined;
	const picker = new QuotePicker(collectCandidates(branch), theme, (candidate) => {
		picked = candidate;
	});

	for (const char of "rename") picker.handleInput(char);
	expect(picker.render(100).filter((line) => line.includes("▸"))).toHaveLength(1);
	picker.handleInput("\r");

	expect(picked?.id).toBe("aaa111");
});
