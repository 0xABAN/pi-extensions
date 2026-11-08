import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { OTHER_LABEL, type Question } from "./questions.ts";

const POINTER = "❯ ";
const NO_POINTER = "  ";
const CONFIRMED_MARK = " ✔";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface RowsState {
	question: Question;
	row: number;
	focused: boolean;
	typing: boolean;
	draft: string;
	cursor: number;
	checked: ReadonlySet<number>;
	confirmed?: { row: number; label?: string };
	nextLabel: string;
}

export interface RenderedRows {
	lines: string[];
	focus: [number, number];
}

interface Row {
	state: RowsState;
	index: number;
	active: boolean;
	number: string;
	theme: Theme;
	width: number;
}

function selected(theme: Theme, text: string): string {
	return theme.fg("accent", theme.bold(text));
}

function withCursor(text: string, offset: number): string {
	const [grapheme] = graphemes.segment(text.slice(offset));
	const raw = grapheme?.segment ?? "";
	const atLineEnd = raw === "\n";
	const shown = raw === "" || raw === " " || atLineEnd ? "\xa0" : raw;
	const after = text.slice(offset + (atLineEnd ? 0 : raw.length));
	return `${text.slice(0, offset)}${CURSOR_MARKER}\x1b[7m${shown}\x1b[27m${after}`;
}

function wrapAfter(prefix: string, text: string, width: number, style?: (line: string) => string): string[] {
	const indent = " ".repeat(visibleWidth(prefix));
	return wrapTextWithAnsi(text, Math.max(1, width - visibleWidth(prefix))).map((segment, index) => {
		const line = `${index === 0 ? prefix : indent}${segment}`;
		return style ? style(line) : line;
	});
}

function typedRow(row: Row, prefix: string): string[] {
	const { state, theme, width } = row;
	return wrapAfter(prefix, withCursor(state.draft, state.cursor), width, (line) => selected(theme, line));
}

function singleSelectRow(row: Row): string[] {
	const { state, index, active, theme, width } = row;
	const option = state.question.options[index];
	const prefix = `${active ? POINTER : NO_POINTER}${row.number}`;
	if (!option && active && state.typing) return typedRow(row, prefix);

	const draftDiffers = !option && state.draft !== "" && state.draft !== (state.confirmed?.label ?? "");
	const confirmed = state.confirmed?.row === index && !draftDiffers;
	const base = option ? option.label : state.draft || OTHER_LABEL;
	const label = confirmed ? `${state.confirmed?.label ?? base}${CONFIRMED_MARK}` : base;
	const lines = wrapAfter(prefix, label, width, active || confirmed ? (line) => selected(theme, line) : undefined);
	if (!option) return lines;

	const indent = " ".repeat(visibleWidth(prefix));
	const description = wrapTextWithAnsi(option.description, Math.max(1, width - indent.length)).map(
		(segment) => `${indent}${theme.fg("muted", segment)}`,
	);
	return [...lines, ...description];
}

function multiSelectRow(row: Row): string[] {
	const { state, index, active, theme, width } = row;
	const option = state.question.options[index];
	const checked = option ? state.checked.has(index) : state.draft.trim().length > 0;
	const box = checked ? theme.fg("accent", "[✔]") : theme.fg("muted", "[ ]");
	const prefix = `${active ? theme.fg("accent", POINTER) : NO_POINTER}${row.number}${box} `;
	const contentWidth = Math.max(1, width - visibleWidth(prefix));

	if (!option && active && state.typing) return typedRow(row, prefix);
	if (!option) {
		return wrapAfter(prefix, state.draft || OTHER_LABEL, width, active ? (line) => selected(theme, line) : undefined);
	}

	const label = truncateToWidth(option.label, contentWidth, "…");
	const description = wrapTextWithAnsi(option.description, contentWidth).map(
		(segment) => `  ${theme.fg("muted", segment)}`,
	);
	return [truncateToWidth(`${prefix}${active ? selected(theme, label) : label}`, width, ""), ...description];
}

function nextRow(row: Row): string[] {
	const { state, active, theme, width } = row;
	const pointer = active ? theme.fg("accent", POINTER) : NO_POINTER;
	const label = active ? selected(theme, state.nextLabel) : state.nextLabel;
	return [truncateToWidth(`${pointer}${label}`, width, "")];
}

export function renderRows(state: RowsState, theme: Theme, width: number): RenderedRows {
	const { question } = state;
	const rowCount = question.options.length + (question.multiSelect ? 2 : 1);
	const numberWidth = String(question.options.length + 1).length;
	const lines: string[] = [];
	let focus: [number, number] = [0, 1];

	for (let index = 0; index < rowCount; index++) {
		const row: Row = {
			state,
			index,
			active: state.focused && index === state.row,
			number: `${String(index + 1).padStart(numberWidth)}. `,
			theme,
			width,
		};
		const start = lines.length;
		if (!question.multiSelect) lines.push(...singleSelectRow(row));
		else if (index === rowCount - 1) lines.push(...nextRow(row));
		else lines.push(...multiSelectRow(row));
		if (index === state.row) focus = [start, lines.length];
	}
	return { lines, focus };
}
