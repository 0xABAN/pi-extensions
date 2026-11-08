import type { Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { NEXT_LABEL, OTHER_LABEL, type Question } from "./questions.ts";
import type { RenderedRows } from "./rows.ts";

export type PreviewMode = "side-by-side" | "stacked";
export type NoteHint = "add" | "edit" | "none";

export interface PreviewLayout {
	rows: (width: number) => RenderedRows;
	index: number;
	width: number;
	mode: PreviewMode;
	leftWidth: number;
	hint: NoteHint;
	allowance?: number;
}

const NOTE_HINTS: Record<NoteHint, string> = {
	add: "Notes: press n to add notes",
	edit: "Note saved: press n to edit",
	none: "",
};

const SIDE_BY_SIDE_MIN_WIDTH = 100;
const MAX_BOX_HEIGHT: Record<PreviewMode, number> = { "side-by-side": 20, stacked: 15 };
const NOTE_HINT_ROWS = 2;
const BOX_FRAME = 2;
const BOX_PADDING = 1;
const BOX_MIN_CONTENT_WIDTH = 40;
const COLUMN_GAP = 2;
const PREVIEW_INDENT = 1;
const MIN_LEFT_WIDTH = 30;
const MIN_PREVIEW_WIDTH = 45;
const MIN_PREVIEW_ROWS = 3;

const FENCE = /^`{3}/;
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripFenceMarkers(lines: readonly string[]): string[] {
	return lines.filter((line) => !FENCE.test(line.replace(ANSI, "")));
}

export function previewMode(terminalWidth: number, width: number): PreviewMode {
	return terminalWidth >= SIDE_BY_SIDE_MIN_WIDTH && width >= SIDE_BY_SIDE_MIN_WIDTH ? "side-by-side" : "stacked";
}

export function leftColumnWidth(questions: readonly Question[], width: number): number {
	const ratioCeiling = Math.floor(width / 2);
	const previewCeiling = width - COLUMN_GAP - MIN_PREVIEW_WIDTH;

	const labelWidths = questions.map((question) => {
		const labels = [...question.options.map((option) => option.label), OTHER_LABEL];
		if (question.multiSelect) labels.push(NEXT_LABEL);
		const desired = Math.max(...labels.map(visibleWidth)) + String(labels.length).length + 6;
		return Math.max(MIN_LEFT_WIDTH, Math.min(desired, ratioCeiling, Math.max(1, previewCeiling)));
	});
	const previewWidths = questions.map((question) => {
		const lines = question.options.flatMap((option) => option.preview?.split("\n") ?? []);
		const widest = Math.max(0, ...lines.map(visibleWidth));
		return Math.min(widest, width - COLUMN_GAP - MIN_LEFT_WIDTH) + BOX_FRAME + 2 * BOX_PADDING + PREVIEW_INDENT;
	});

	const labelDriven = Math.max(MIN_LEFT_WIDTH, ...labelWidths);
	const slack = width - COLUMN_GAP - Math.max(MIN_PREVIEW_WIDTH, ...previewWidths);
	return Math.min(Math.max(labelDriven, slack), Math.max(1, Math.min(previewCeiling, ratioCeiling)));
}

function scrollStart(focus: [number, number] | undefined, rows: number, total: number): number {
	if (!focus) return 0;
	const ideal = focus[0] - Math.floor(Math.max(0, rows - (focus[1] - focus[0])) / 2);
	return Math.max(0, Math.min(ideal, total - rows));
}

export function scrollWindow(
	lines: readonly string[],
	rows: number,
	focus: [number, number] | undefined,
	theme: Theme,
): { lines: string[]; focus: [number, number] | undefined } {
	if (lines.length <= rows) return { lines: [...lines], focus };

	const start = scrollStart(focus, rows, lines.length);
	const visible = lines.slice(start, start + rows);
	const shifted: [number, number] | undefined = focus && [focus[0] - start, focus[1] - start];
	const free = (row: number) => !shifted || row < shifted[0] || row >= shifted[1];
	const above = start > 0;
	const below = start + rows < lines.length;
	const last = visible.length - 1;

	if (above && below && visible.length === 1) {
		if (free(0)) visible[0] = theme.fg("dim", "↕");
	} else {
		if (above && free(0)) visible[0] = theme.fg("dim", "↑");
		if (below && last > 0 && free(last)) visible[last] = theme.fg("dim", "↓");
	}
	return { lines: visible, focus: shifted };
}

export class Previews {
	private readonly question: Question;
	private readonly theme: Theme;
	private readonly markdownTheme: MarkdownTheme;
	private readonly markdown = new Map<number, Markdown>();

	constructor(question: Question, theme: Theme, markdownTheme: MarkdownTheme) {
		this.question = question;
		this.theme = theme;
		this.markdownTheme = markdownTheme;
	}

	get any(): boolean {
		return this.question.options.some((option) => option.preview);
	}

	has(index: number): boolean {
		return Boolean(this.question.options[index]?.preview);
	}

	invalidate(): void {
		for (const markdown of this.markdown.values()) markdown.invalidate();
	}

	private content(index: number, width: number): string[] {
		const preview = this.question.options[index]?.preview;
		if (!preview) {
			const placeholder = this.theme.fg("dim", "No preview available");
			return [placeholder + " ".repeat(Math.max(0, width - visibleWidth(placeholder)))];
		}

		let markdown = this.markdown.get(index);
		if (!markdown) {
			markdown = new Markdown(preview, 0, 0, this.markdownTheme);
			this.markdown.set(index, markdown);
		}
		return stripFenceMarkers(markdown.render(width));
	}

	private box(index: number, width: number, mode: PreviewMode, hint: NoteHint, maxRows?: number): string[] {
		const innerWidth = Math.max(1, width - BOX_FRAME - 2 * BOX_PADDING);
		const content = this.content(index, innerWidth);

		let rows = Math.min(content.length, Math.max(1, MAX_BOX_HEIGHT[mode] - BOX_FRAME - NOTE_HINT_ROWS));
		let showHint = true;
		if (maxRows !== undefined && BOX_FRAME + rows + NOTE_HINT_ROWS > maxRows) {
			rows = Math.min(rows, maxRows - BOX_FRAME);
			showHint = false;
		}
		if (rows < 1) return [];

		const shown = content.slice(0, rows);
		const widest = Math.max(
			Math.min(BOX_MIN_CONTENT_WIDTH, innerWidth),
			...shown.map((line) => visibleWidth(line.replace(/\s+$/, ""))),
		);
		const span = Math.min(widest, innerWidth) + 2 * BOX_PADDING;
		const border = (text: string) => this.theme.fg("accent", text);
		const hidden = content.length - rows;

		let bottom = "─".repeat(span);
		if (hidden > 0) {
			const label = ` ✂ ── ${hidden} lines hidden ── `;
			const left = "─".repeat(Math.max(0, Math.floor((span - label.length) / 2)));
			bottom = `${left}${label}${"─".repeat(Math.max(0, span - left.length - label.length))}`;
		}
		const lines = [
			border(`┌${"─".repeat(span)}┐`),
			...shown.map((line) => `${border("│")} ${truncateToWidth(line, span - 2, "", true)} ${border("│")}`),
			border(`└${bottom}┘`),
		];
		if (!showHint) return lines;

		const text = this.has(index) ? NOTE_HINTS[hint] : "";
		return [...lines, "", text ? this.theme.fg("muted", text) : ""];
	}

	layout(options: PreviewLayout): RenderedRows {
		return options.mode === "side-by-side" ? this.sideBySide(options) : this.stacked(options);
	}

	private sideBySide({ rows, index, width, mode, leftWidth, hint, allowance }: PreviewLayout): RenderedRows {
		const left = Math.min(leftWidth, Math.max(1, width - COLUMN_GAP - 1));
		const right = Math.max(1, width - left - COLUMN_GAP);
		const rendered = rows(left);
		const column =
			allowance === undefined ? rendered : scrollWindow(rendered.lines, allowance, rendered.focus, this.theme);

		const box = this.box(index, Math.max(1, right - PREVIEW_INDENT), mode, hint, allowance);
		const boxIndent = Math.max(PREVIEW_INDENT, right - visibleWidth(box[0] ?? ""));
		const preview = box.map((line) => {
			if (line === "") return "";
			const indent = Math.max(PREVIEW_INDENT, Math.min(boxIndent, right - visibleWidth(line)));
			return `${" ".repeat(indent)}${truncateToWidth(line, right - indent, "")}`;
		});

		const lines = Array.from({ length: Math.max(column.lines.length, preview.length) }, (_, row) => {
			const cell = truncateToWidth(column.lines[row] ?? "", left, "");
			const padding = " ".repeat(Math.max(0, left - visibleWidth(cell)));
			return truncateToWidth(`${cell}${padding}${" ".repeat(COLUMN_GAP)}${preview[row] ?? ""}`, width, "");
		});
		return { lines, focus: column.focus ?? [0, 1] };
	}

	private stacked({ rows, index, width, mode, hint, allowance }: PreviewLayout): RenderedRows {
		const rendered = rows(width);
		const full = this.box(index, width, mode, hint);
		if (allowance === undefined || rendered.lines.length + 1 + full.length <= allowance) {
			return { lines: [...rendered.lines, "", ...full], focus: rendered.focus };
		}

		const focusRows = rendered.focus[1] - rendered.focus[0];
		const boxRows = (optionFloor: number) =>
			Math.min(full.length, allowance - 1 - Math.min(rendered.lines.length, optionFloor));
		const roomy = boxRows(focusRows + 2);
		const box = this.box(index, width, mode, hint, roomy >= MIN_PREVIEW_ROWS ? roomy : boxRows(focusRows));
		const optionRows = allowance - (box.length > 0 ? 1 + box.length : 0);
		const column = scrollWindow(rendered.lines, Math.max(1, optionRows), rendered.focus, this.theme);
		return {
			lines: box.length > 0 ? [...column.lines, "", ...box] : column.lines,
			focus: column.focus ?? rendered.focus,
		};
	}
}
