import type { Theme, ToolSummary } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { NO_INPUT_PLACEHOLDER } from "../tool/format-answer.ts";
import {
	isQuestionnaireResult,
	type QuestionAnswer,
	type QuestionnaireResult,
	type QuestionParams,
} from "../tool/types.ts";
import { stripFenceMarkers } from "./components/preview/preview-box-renderer.ts";

const INDENT = "  ";
const COLUMN_GAP = "  ";
const RECOMMENDED_SUFFIX = /\s*\(Recommended\)$/;

type ToolResultView = { content: ReadonlyArray<{ type: string; text?: string }>; details?: unknown };

class WidthLines implements Component {
	private readonly layout: (width: number) => string[];

	constructor(layout: (width: number) => string[]) {
		this.layout = layout;
	}

	render(width: number): string[] {
		return this.layout(width);
	}
	invalidate(): void {}
}

function questionHeaders(args: QuestionParams | undefined): string {
	return (args?.questions ?? [])
		.map((q) => q?.header)
		.filter(Boolean)
		.join(" · ");
}

export function summarizeAsk(args: QuestionParams | undefined): ToolSummary {
	return { label: "Ask", icon: "◇", target: questionHeaders(args) };
}

export function renderAskCall(args: QuestionParams | undefined, theme: Theme): Component {
	const headers = questionHeaders(args);
	const title = theme.fg("toolTitle", theme.bold("Ask"));
	const text = headers ? `${title} ${theme.fg("accent", headers)}` : title;
	return new WidthLines((width) => [truncateToWidth(text, width, "…")]);
}

export function renderAskResult(
	result: ToolResultView,
	args: QuestionParams | undefined,
	theme: Theme,
	options: { expanded: boolean; isError: boolean },
): Component {
	const details = isQuestionnaireResult(result.details) ? result.details : undefined;
	if (options.isError || details?.error) {
		return new WidthLines(() => [theme.fg("error", `✗ ${firstTextLine(result)}`)]);
	}
	if (!details) return new WidthLines(() => [theme.fg("success", "✓")]);
	if (details.cancelled) {
		return new WidthLines(() => [theme.fg("dim", `✗ ${"no answer"}`)]);
	}
	const questions = args?.questions ?? [];
	return new WidthLines((width) =>
		questions.length > 1
			? tableLines(details, args as QuestionParams, theme, options.expanded, width)
			: singleLines(details, questions[0]?.question, theme, options.expanded, width),
	);
}

function singleLines(
	details: QuestionnaireResult,
	questionText: string | undefined,
	theme: Theme,
	expanded: boolean,
	width: number,
): string[] {
	const answer = details.answers[0];
	const lines = hanging(`${theme.fg("success", "✓")} `, answerText(answer, theme), width);
	lines.push(...detailLines(answer, expanded ? questionText : undefined, INDENT, theme, width));
	return [...lines, ...globalNoteLines(details, theme, width)];
}

function tableLines(
	details: QuestionnaireResult,
	args: QuestionParams,
	theme: Theme,
	expanded: boolean,
	width: number,
): string[] {
	const headerWidth = Math.max(...args.questions.map((q) => visibleWidth(q.header)));
	const answerIndent = " ".repeat(INDENT.length + headerWidth + COLUMN_GAP.length);
	const lines = args.questions.flatMap((q, i) => {
		const answer = details.answers.find((a) => a.questionIndex === i);
		const header = q.header + " ".repeat(headerWidth - visibleWidth(q.header));
		const row = hanging(`${INDENT}${theme.fg("muted", header)}${COLUMN_GAP}`, answerText(answer, theme), width);
		return [...row, ...detailLines(answer, expanded ? q.question : undefined, answerIndent, theme, width)];
	});
	return [...lines, ...globalNoteLines(details, theme, width)];
}

function detailLines(
	answer: QuestionAnswer | undefined,
	questionText: string | undefined,
	indent: string,
	theme: Theme,
	width: number,
): string[] {
	const lines: string[] = [];
	if (questionText) lines.push(...hanging(indent, theme.fg("dim", questionText), width));
	if (questionText && answer?.preview) {
		for (const line of stripFenceMarkers(answer.preview.split("\n"))) {
			lines.push(truncateToWidth(`${indent}${theme.fg("dim", `│ ${line}`)}`, width, "…"));
		}
	}
	if (answer?.notes) lines.push(...hanging(indent, theme.fg("dim", `✎ ${answer.notes}`), width));
	return lines;
}

function globalNoteLines(details: QuestionnaireResult, theme: Theme, width: number): string[] {
	return details.globalNote ? hanging(INDENT, theme.fg("dim", `✎ ${details.globalNote}`), width) : [];
}

function answerText(answer: QuestionAnswer | undefined, theme: Theme): string {
	if (!answer) return theme.fg("dim", "not answered");
	const typed = answer.answer ? `"${answer.answer}"` : undefined;
	const picks =
		answer.kind === "option"
			? [label(answer.answer ?? "")]
			: answer.kind === "custom"
				? [typed]
				: [...(answer.selected ?? []).map(label), typed];
	return theme.fg("toolOutput", picks.filter(Boolean).join(", ") || NO_INPUT_PLACEHOLDER);
}

function label(text: string): string {
	return text.replace(RECOMMENDED_SUFFIX, "");
}

function hanging(prefix: string, text: string, width: number): string[] {
	const indent = visibleWidth(prefix);
	return wrapTextWithAnsi(text, Math.max(1, width - indent)).map(
		(line, i) => (i === 0 ? prefix : " ".repeat(indent)) + line,
	);
}

function firstTextLine(result: ToolResultView): string {
	const text = result.content.find((c) => c.type === "text")?.text ?? "";
	return text.split("\n")[0] ?? "";
}
