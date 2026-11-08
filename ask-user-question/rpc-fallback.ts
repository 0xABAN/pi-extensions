import { displayLabel, t } from "./state/i18n-bridge.ts";
import type { QuestionAnswer, QuestionData, QuestionnaireResult, QuestionParams } from "./tool/types.ts";

const MULTI_SELECT_INSTRUCTIONS =
	'Enter the numbers of all that apply, comma-separated (e.g. "1,3"). Add "; custom answer" to include your own text, or type only custom text.';
const CUSTOM_ANSWER_TITLE = "Type your answer:";
const MULTI_SELECT_PLACEHOLDER = "1,3; custom answer";

const MAX_PREVIEW_CHARS = 600;

export type DialogUI = {
	select: (title: string, options: string[]) => Promise<string | undefined>;
	input: (title: string, placeholder?: string) => Promise<string | undefined>;
};

export function hasDialogUI(ui: unknown): ui is DialogUI {
	const u = ui as Partial<Record<"select" | "input", unknown>> | null | undefined;
	return typeof u?.select === "function" && typeof u?.input === "function";
}

type Option = QuestionData["options"][number];

function formatOptionLine(option: Option, index: number): string {
	return `${index + 1}. ${option.label} — ${option.description}`;
}

function parseIndex(token: string, count: number): number | null {
	const i = Number.parseInt(token, 10) - 1;
	return i >= 0 && i < count ? i : null;
}

function buildPreviewBlock(question: QuestionData): string {
	const blocks = question.options.flatMap((o, i) =>
		o.preview && o.preview.length > 0
			? [`--- ${i + 1}. ${o.label} preview ---\n${o.preview.slice(0, MAX_PREVIEW_CHARS)}`]
			: [],
	);
	return blocks.length > 0 ? `\n\n${blocks.join("\n\n")}` : "";
}

export async function runRpcQuestionnaire(ui: DialogUI, params: QuestionParams): Promise<QuestionnaireResult> {
	const answers: QuestionAnswer[] = [];
	for (let qi = 0; qi < params.questions.length; qi++) {
		const q = params.questions[qi];
		const header = q.header ? `[${q.header}] ` : "";
		const answer = q.multiSelect ? await askMultiSelect(ui, q, qi, header) : await askSingleSelect(ui, q, qi, header);
		if (answer === undefined) return { answers, cancelled: true };
		answers.push(answer);
	}
	return { answers, cancelled: false };
}

async function askSingleSelect(
	ui: DialogUI,
	q: QuestionData,
	questionIndex: number,
	header: string,
): Promise<QuestionAnswer | undefined> {
	const options = q.options.map(formatOptionLine);
	options.push(`${q.options.length + 1}. ${displayLabel("other")}`);
	const title = `${header}${q.question}${buildPreviewBlock(q)}`;
	for (;;) {
		const chosen = await ui.select(title, options);
		if (chosen == null) return undefined;
		const reply = chosen.trim();
		if (reply.length === 0) return undefined;
		const idx = resolveSingleSelectReply(chosen, reply, options, q);
		if (idx === undefined) return { questionIndex, question: q.question, kind: "custom", answer: reply };
		if (idx < q.options.length) {
			const o = q.options[idx];
			return {
				questionIndex,
				question: q.question,
				kind: "option",
				answer: o.label,
				preview: o.preview && o.preview.length > 0 ? o.preview : undefined,
			};
		}
		const typed = await ui.input(
			`${header}${q.question}\n\n${q.options.map(formatOptionLine).join("\n")}\n\n${t("rpc.custom_answer_title", CUSTOM_ANSWER_TITLE)}`,
			"",
		);
		if (typed == null || typed.trim().length === 0) continue;
		return { questionIndex, question: q.question, kind: "custom", answer: typed };
	}
}

function resolveSingleSelectReply(
	chosen: string,
	reply: string,
	lines: readonly string[],
	q: QuestionData,
): number | undefined {
	const line = lines.indexOf(chosen);
	if (line >= 0) return line;
	if (/^\d+\.?$/.test(reply)) return parseIndex(reply, lines.length) ?? undefined;
	const label = q.options.findIndex((o) => o.label === reply);
	return label >= 0 ? label : undefined;
}

async function askMultiSelect(
	ui: DialogUI,
	q: QuestionData,
	questionIndex: number,
	header: string,
): Promise<QuestionAnswer | undefined> {
	const list = q.options.map(formatOptionLine).join("\n");
	const value = await ui.input(
		`${header}${q.question}\n\n${list}\n\n${t("rpc.multi_instructions", MULTI_SELECT_INSTRUCTIONS)}`,
		MULTI_SELECT_PLACEHOLDER,
	);
	if (value == null) return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return { questionIndex, question: q.question, kind: "multi", answer: null, selected: [] };
	}
	const [selectionPart = "", ...customParts] = trimmed.split(";");
	const selection = selectionPart.trim();
	const custom = customParts.join(";").trim();
	const tokens = selection.split(/[,\s]+/).filter((tok) => tok.length > 0);
	const indices = tokens.map((tok) => (/^\d+\.?$/.test(tok) ? parseIndex(tok, q.options.length) : null));
	if (selection.length === 0 || indices.every((i): i is number => i != null)) {
		const selected: string[] = [];
		for (const i of indices) {
			if (i == null) continue;
			const label = q.options[i].label;
			if (!selected.includes(label)) selected.push(label);
		}
		return {
			questionIndex,
			question: q.question,
			kind: "multi",
			answer: custom.length > 0 ? custom : null,
			selected,
		};
	}
	return { questionIndex, question: q.question, kind: "multi", answer: trimmed, selected: [] };
}
