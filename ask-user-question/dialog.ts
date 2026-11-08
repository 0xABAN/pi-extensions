import { DynamicBorder, getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	CURSOR_MARKER,
	Editor,
	Key,
	matchesKey,
	Text,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { leftColumnWidth, type NoteHint, Previews, previewMode, scrollWindow } from "./preview.ts";
import { type Answer, formatAnswer, NEXT_LABEL, type Question, type QuestionnaireResult } from "./questions.ts";
import { type RenderedRows, type RowsState, renderRows } from "./rows.ts";

interface Keybindings {
	matches(data: string, name: string): boolean;
}

const NOTES_KEY = "n";
const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
const MIN_SCROLL_ROWS = 3;

export class QuestionDialog implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keys: Keybindings;
	private readonly questions: Question[];
	private readonly done: (result: QuestionnaireResult) => void;
	private readonly tabbed: boolean;
	private readonly previews: Previews[];
	private readonly typing: Editor;
	private readonly noteEditor: Editor;

	private tab = 0;
	private row = 0;
	private noting = false;
	private reviewChoice = 0;
	private checked = new Set<number>();
	private readonly answers = new Map<number, Answer>();
	private readonly drafts = new Map<number, string>();
	private readonly notes = new Map<number, string>();

	constructor(
		tui: TUI,
		theme: Theme,
		keys: Keybindings,
		questions: Question[],
		done: (result: QuestionnaireResult) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keys = keys;
		this.questions = questions;
		this.done = done;
		this.tabbed = questions.length > 1;

		const markdownTheme = getMarkdownTheme();
		this.previews = questions.map((question) => new Previews(question, theme, markdownTheme));

		const editorTheme = {
			borderColor: (text: string) => theme.fg("borderMuted", text),
			selectList: {
				selectedPrefix: (text: string) => theme.bg("selectedBg", theme.fg("accent", text)),
				selectedText: (text: string) => theme.bg("selectedBg", theme.bold(text)),
				description: (text: string) => theme.fg("muted", text),
				scrollInfo: (text: string) => theme.fg("dim", text),
				noMatch: (text: string) => theme.fg("warning", text),
			},
		};
		this.typing = new Editor(tui, editorTheme);
		this.noteEditor = new Editor(tui, editorTheme);
		this.typing.disableSubmit = true;
		this.noteEditor.disableSubmit = true;
	}

	invalidate(): void {
		for (const previews of this.previews) previews.invalidate();
		this.typing.invalidate();
		this.noteEditor.invalidate();
	}

	handleInput(data: string): void {
		if (this.noting) this.handleNoteKey(data);
		else if (this.onReview()) this.handleReviewKey(data);
		else if (this.isTyping()) this.handleTypingKey(data);
		else this.handleOptionKey(data);
		this.tui.requestRender();
	}

	private question(): Question {
		return this.questions[this.tab]!;
	}

	private onReview(): boolean {
		return this.tabbed && this.tab === this.questions.length;
	}

	private isTyping(): boolean {
		return !this.onReview() && this.row === this.question().options.length;
	}

	private rowCount(): number {
		const question = this.question();
		return question.options.length + (question.multiSelect ? 2 : 1);
	}

	private confirms(data: string): boolean {
		return this.keys.matches(data, "tui.select.confirm") || this.keys.matches(data, "tui.input.submit");
	}

	private tabStep(data: string): number {
		if (!this.tabbed) return 0;
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) return 1;
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) return -1;
		return 0;
	}

	private rowStep(data: string): number {
		if (this.keys.matches(data, "tui.select.up")) return -1;
		if (this.keys.matches(data, "tui.select.down")) return 1;
		return 0;
	}

	private handleNoteKey(data: string): void {
		const newLine = this.keys.matches(data, "tui.input.newLine");
		if (this.keys.matches(data, "tui.select.cancel") || (!newLine && this.confirms(data))) this.closeNotes();
		else this.noteEditor.handleInput(data);
	}

	private handleReviewKey(data: string): void {
		const tabStep = this.tabStep(data);
		const rowStep = this.rowStep(data);
		if (this.keys.matches(data, "tui.select.cancel")) this.finish(true);
		else if (tabStep) this.switchTab(this.tab + tabStep);
		else if (rowStep) this.reviewChoice = (this.reviewChoice + rowStep + 2) % 2;
		else if (this.confirms(data)) this.finish(this.reviewChoice === 1);
		else if (matchesKey(data, NOTES_KEY)) this.openNotes();
	}

	private handleTypingKey(data: string): void {
		const cursor = this.typing.getCursor();
		const moveUp = this.keys.matches(data, "tui.editor.cursorUp") && cursor.line > 0;
		const moveDown =
			this.keys.matches(data, "tui.editor.cursorDown") && cursor.line < this.typing.getLines().length - 1;
		const rowStep = this.rowStep(data);

		if (this.keys.matches(data, "tui.input.newLine") || moveUp || moveDown) {
			this.typing.handleInput(data);
			return;
		}
		if (this.confirms(data)) {
			this.confirmTyped();
			return;
		}
		if (this.keys.matches(data, "tui.editor.deleteToLineStart")) {
			this.typing.setText("");
			return;
		}
		if (this.keys.matches(data, "tui.select.cancel")) {
			this.finish(true);
			return;
		}
		if (rowStep) {
			this.focusRow(this.row + rowStep);
			return;
		}
		this.typing.handleInput(data);
	}

	private handleOptionKey(data: string): void {
		const tabStep = this.tabStep(data);
		const rowStep = this.rowStep(data);
		if (tabStep) {
			this.switchTab(this.tab + tabStep);
			return;
		}
		if (matchesKey(data, NOTES_KEY)) {
			this.openNotes();
			return;
		}
		if (rowStep) {
			this.focusRow(this.row + rowStep);
			return;
		}
		if (this.keys.matches(data, "tui.select.cancel")) {
			this.finish(true);
			return;
		}

		const question = this.question();
		const digit = DIGITS.findIndex((key) => matchesKey(data, key));
		const digitOption = digit >= 0 && digit < question.options.length ? digit : undefined;
		if (digit === question.options.length) {
			this.focusRow(digit);
			return;
		}

		if (!question.multiSelect) {
			if (digitOption !== undefined) this.confirmOption(digitOption);
			else if (this.confirms(data)) this.confirmOption(this.row);
			return;
		}

		const onOption = this.row < question.options.length;
		if (digitOption !== undefined) this.toggle(digitOption);
		else if (onOption && (matchesKey(data, Key.space) || this.confirms(data))) this.toggle(this.row);
		else if (!onOption && this.confirms(data)) this.confirmMulti();
	}

	private focusRow(row: number): void {
		const wasTyping = this.isTyping();
		this.row = (row + this.rowCount()) % this.rowCount();
		if (wasTyping) {
			this.drafts.set(this.tab, this.typing.getExpandedText());
			if (this.question().multiSelect) this.saveChecked();
		}
		if (this.isTyping()) this.typing.setText(this.draftFor(this.tab));
	}

	private switchTab(tab: number): void {
		const tabs = this.questions.length + 1;
		this.tab = (tab + tabs) % tabs;
		this.row = this.answeredRow();
		this.noting = false;
		this.reviewChoice = 0;

		const question = this.questions[this.tab];
		const selected = this.answers.get(this.tab)?.selected ?? [];
		this.checked = new Set(
			question?.options.flatMap((option, index) => (selected.includes(option.label) ? [index] : [])),
		);

		this.noteEditor.focused = false;
		this.noteEditor.setText(this.noteFor(this.tab));
		this.typing.setText(this.draftFor(this.tab));
	}

	private answeredRow(): number {
		const question = this.questions[this.tab];
		const answer = this.answers.get(this.tab);
		if (!question || !answer) return 0;
		if (answer.kind === "multi") return question.options.length + 1;
		if (answer.kind === "custom") return 0;
		return Math.max(
			0,
			question.options.findIndex((option) => option.label === answer.answer),
		);
	}

	private draftFor(tab: number): string {
		const answer = this.answers.get(tab);
		const typed = answer?.kind === "custom" || answer?.kind === "multi" ? answer.answer : null;
		return this.drafts.get(tab) ?? typed ?? "";
	}

	private noteFor(tab: number): string {
		return this.notes.get(tab) ?? this.answers.get(tab)?.notes ?? "";
	}

	private toggle(index: number): void {
		if (this.checked.has(index)) this.checked.delete(index);
		else this.checked.add(index);
		this.saveChecked();
	}

	private checkedLabels(): string[] {
		return this.question().options.flatMap((option, index) => (this.checked.has(index) ? [option.label] : []));
	}

	private saveChecked(): void {
		const selected = this.checkedLabels();
		const typed = this.draftFor(this.tab);
		if (selected.length === 0 && !typed.trim()) {
			this.answers.delete(this.tab);
			return;
		}
		this.answers.set(this.tab, this.answer({ kind: "multi", answer: typed.trim() ? typed : null, selected }));
	}

	private answer(fields: Pick<Answer, "kind" | "answer" | "selected" | "preview">): Answer {
		const note = this.notes.get(this.tab);
		return {
			questionIndex: this.tab,
			question: this.question().question,
			...fields,
			...(note ? { notes: note } : {}),
		};
	}

	private confirmOption(index: number): void {
		const option = this.question().options[index]!;
		this.record(
			this.answer({ kind: "option", answer: option.label, ...(option.preview ? { preview: option.preview } : {}) }),
		);
	}

	private confirmTyped(): void {
		if (this.question().multiSelect) {
			this.confirmMulti();
			return;
		}
		const text = this.typing.getExpandedText();
		if (!text.trim()) return;
		this.drafts.delete(this.tab);
		this.record(this.answer({ kind: "custom", answer: text }));
	}

	private confirmMulti(): void {
		const text = this.typing.getExpandedText();
		this.drafts.delete(this.tab);
		this.record(this.answer({ kind: "multi", answer: text.trim() ? text : null, selected: this.checkedLabels() }));
	}

	private record(answer: Answer): void {
		this.answers.set(this.tab, answer);
		if (!this.tabbed) this.finish(false);
		else this.switchTab(this.tab < this.questions.length - 1 ? this.tab + 1 : this.questions.length);
	}

	private openNotes(): void {
		this.noting = true;
		this.noteEditor.setText(this.noteFor(this.tab));
		this.noteEditor.focused = true;
	}

	private closeNotes(): void {
		const note = this.noteEditor.getExpandedText().trim();
		const answer = this.answers.get(this.tab);
		if (note) {
			this.notes.set(this.tab, note);
			if (answer) this.answers.set(this.tab, { ...answer, notes: note });
		} else {
			this.notes.delete(this.tab);
			if (answer) {
				const { notes: _, ...rest } = answer;
				this.answers.set(this.tab, rest);
			}
		}
		this.noting = false;
		this.noteEditor.focused = false;
	}

	private finish(cancelled: boolean): void {
		const globalNote = this.notes.get(this.questions.length);
		this.done({
			answers: this.questions.flatMap((_, index) => this.answers.get(index) ?? []),
			cancelled,
			...(globalNote ? { globalNote } : {}),
		});
	}

	render(width: number): string[] {
		const terminalRows = this.tui.terminal.rows;
		const budget = Math.min(terminalRows, Math.max(12, Math.floor(terminalRows * 0.7)));
		const border = new DynamicBorder((text) => this.theme.fg("accent", text)).render(width);

		const top = [...border, ...(this.tabbed ? [this.tabBar(width), ""] : []), ""];
		const heading = this.heading(width);
		const notes = this.notesSection(width);
		const footer = this.onReview() ? this.reviewFooter(width) : this.questionFooter(width);
		const bottom = [...border, ...footer];

		const allowance = budget - top.length - heading.length - bottom.length - 1 - notes.length;
		const body = this.onReview()
			? { lines: this.reviewBody(width), focus: undefined }
			: this.body(this.tab, width, allowance >= MIN_SCROLL_ROWS ? allowance : undefined);
		const lines = [...top, ...heading, ...body.lines, "", ...notes, ...bottom];

		if (lines.length > budget) {
			const pinned = budget - top.length - heading.length - bottom.length >= MIN_SCROLL_ROWS;
			const fixed = [...top, ...(pinned ? heading : [])];
			const scrolling = lines.slice(fixed.length, lines.length - bottom.length);
			const rows = Math.min(Math.max(0, budget - fixed.length - bottom.length), scrolling.length);
			if (rows === 0) return [...fixed, ...bottom].slice(0, budget);

			const offset = pinned ? 0 : heading.length;
			const focus = this.noting
				? this.noteFocus(scrolling, notes.length, rows)
				: body.focus && ([body.focus[0] + offset, body.focus[1] + offset] as [number, number]);
			return [...fixed, ...scrollWindow(scrolling, rows, focus, this.theme).lines, ...bottom].slice(0, budget);
		}

		const steadyHeight =
			this.tallestBody(width, allowance) + (this.tabbed ? 5 : 2) + (this.noting ? notes.length : 0);
		const padding = Math.min(steadyHeight - body.lines.length - footer.length - notes.length, budget - lines.length);
		return [...lines, ...Array<string>(Math.max(0, padding)).fill("")];
	}

	private noteFocus(lines: string[], noteRows: number, rows: number): [number, number] {
		const start = lines.length - noteRows;
		if (noteRows <= rows) return [start, lines.length];
		const cursor = lines.findIndex((line, index) => index >= start && line.includes(CURSOR_MARKER));
		return cursor === -1 ? [start, lines.length] : [cursor, cursor + 1];
	}

	private padded(text: string, width: number): string[] {
		return new Text(text, 1, 0).render(width);
	}

	private oneLine(text: string, width: number): string {
		return ` ${truncateToWidth(text, Math.max(0, width - 1), "…", false)}`;
	}

	private tabLabel(index: number): string {
		return this.questions[index]!.header || `Q${index + 1}`;
	}

	private tabBar(width: number): string {
		const selected = (text: string) => this.theme.bg("selectedBg", this.theme.fg("text", text));
		const tabs = this.questions.map((_, index) => {
			const answered = this.answers.has(index);
			const text = ` ${answered ? "■" : "□"} ${this.tabLabel(index)} `;
			return index === this.tab ? selected(text) : this.theme.fg(answered ? "success" : "muted", text);
		});
		const allAnswered = this.answers.size === this.questions.length;
		const submit = this.onReview()
			? selected(" ✓ Submit ")
			: this.theme.fg(allAnswered ? "success" : "dim", " ✓ Submit ");
		return truncateToWidth(` ← ${tabs.map((tab) => `${tab} `).join("")}${submit} →`, width, "");
	}

	private heading(width: number): string[] {
		if (this.onReview()) {
			return [...this.padded(this.theme.bold(this.theme.fg("accent", "Review your answers")), width), ""];
		}
		const question = this.question();
		const chip =
			!this.tabbed && question.header
				? [...this.padded(this.theme.bg("selectedBg", ` ${question.header} `), width), ""]
				: [];
		return [...chip, ...this.padded(this.theme.bold(question.question), width), ""];
	}

	private confirmedRow(tab: number): RowsState["confirmed"] {
		const question = this.questions[tab]!;
		const answer = this.answers.get(tab);
		if (question.multiSelect || !answer) return undefined;
		if (answer.kind === "custom") return { row: question.options.length, label: answer.answer ?? "" };
		const row = question.options.findIndex((option) => option.label === answer.answer);
		return row >= 0 ? { row } : undefined;
	}

	private body(tab: number, width: number, allowance: number | undefined, previewOption?: number): RenderedRows {
		const question = this.questions[tab]!;
		const current = tab === this.tab;
		const answer = this.answers.get(tab);
		const typing = current && this.isTyping();
		const row = current ? this.row : 0;
		const confirmed = this.confirmedRow(tab);

		const rows = (columnWidth: number) =>
			renderRows(
				{
					question,
					row,
					focused: !this.noting,
					typing,
					draft: current ? this.typing.getText() : this.draftFor(tab),
					cursor: current ? this.cursorOffset() : 0,
					checked: current ? this.checked : new Set(),
					...(confirmed ? { confirmed } : {}),
					nextLabel: tab === this.questions.length - 1 ? "Submit" : NEXT_LABEL,
				},
				this.theme,
				columnWidth,
			);

		const previews = this.previews[tab]!;
		if (question.multiSelect || !previews.any || typing) return rows(width);

		const hint: NoteHint = this.noting ? "none" : this.notes.get(tab) || answer?.notes ? "edit" : "add";
		return previews.layout({
			rows,
			index: previewOption ?? row,
			width,
			mode: previewMode(this.tui.terminal.columns, width),
			leftWidth: leftColumnWidth(this.questions, width),
			hint,
			allowance,
		});
	}

	private tallestBody(width: number, allowance: number): number {
		const heights = this.questions.flatMap((question, tab) => {
			const rows = tab === this.tab && allowance >= MIN_SCROLL_ROWS ? allowance : undefined;
			const options = this.previews[tab]!.any ? question.options.map((_, index) => index) : [undefined];
			return options.map((option) => this.body(tab, width, rows, option).lines.length);
		});
		return Math.max(1, ...heights);
	}

	private cursorOffset(): number {
		const lines = this.typing.getLines();
		const cursor = this.typing.getCursor();
		return lines.slice(0, cursor.line).reduce((offset, line) => offset + line.length + 1, cursor.col);
	}

	private notesSection(width: number): string[] {
		if (this.noting) {
			const title = this.onReview() ? "Global note:" : "Notes:";
			return [...this.padded(this.theme.fg("muted", title), width), ...this.noteEditor.render(width), ""];
		}
		if (this.onReview()) return [];

		const note = this.notes.get(this.tab) || this.answers.get(this.tab)?.notes;
		if (!note) return [];
		const [first = "", ...rest] = note.split("\n");
		return [
			this.oneLine(this.theme.fg("dim", `Note for this answer: ${first}${rest.length > 0 ? " …" : ""}`), width),
		];
	}

	private reviewBody(width: number): string[] {
		const entry = (label: string, value: string) => [
			...this.padded(this.theme.fg("muted", ` ● ${label}`), width),
			...this.padded(`   ${this.theme.fg("muted", "→")} ${this.theme.fg("text", value)}`, width),
		];
		const lines = this.questions.flatMap((_, index) => {
			const answer = this.answers.get(index);
			if (!answer) return [];
			const note = answer.notes
				? this.padded(this.theme.fg("dim", `     Note for this answer: ${answer.notes}`), width)
				: [];
			return [...entry(this.tabLabel(index), formatAnswer(answer)), ...note];
		});
		const globalNote = this.notes.get(this.questions.length);
		return !this.noting && globalNote ? [...lines, ...entry("Note", globalNote)] : lines;
	}

	private questionFooter(width: number): string[] {
		const parts = [];
		if (this.question().multiSelect) parts.push("space to toggle");
		if (!this.noting && !this.isTyping()) parts.push(`${NOTES_KEY} to add notes`);
		if (this.tabbed) parts.push("tab to switch questions");
		parts.push("esc to cancel");
		if (this.noting || this.isTyping()) parts.push("shift+enter for newline");
		if (this.isTyping()) parts.push("ctrl+u to clear");
		return ["", this.oneLine(this.theme.fg("dim", parts.join(" · ")), width)];
	}

	private reviewFooter(width: number): string[] {
		const missing = this.questions.flatMap((_, index) => (this.answers.has(index) ? [] : [this.tabLabel(index)]));
		const prompt =
			missing.length === 0
				? this.theme.fg("muted", "Ready to submit your answers?")
				: this.theme.fg("warning", `⚠ Answer remaining questions before submitting: ${missing.join(", ")}`);
		const choices = ["Submit answers", "Cancel"].map((label, index) => {
			const active = !this.noting && index === this.reviewChoice;
			const text = active ? this.theme.fg("accent", this.theme.bold(label)) : this.theme.fg("text", label);
			return truncateToWidth(`${active ? "❯ " : "  "}${index + 1}. ${text}`, width, "");
		});
		const hints = [
			...(this.noting ? [] : [`${NOTES_KEY} to add a note`]),
			"esc to cancel",
			...(this.noting ? ["shift+enter for newline"] : []),
		];
		return [
			"",
			this.oneLine(prompt, width),
			...choices,
			this.oneLine(this.theme.fg("dim", hints.join(" · ")), width),
		];
	}
}
