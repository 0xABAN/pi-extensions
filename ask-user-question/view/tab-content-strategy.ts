import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, type Editor, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { selectSavedNote } from "../state/selectors/derivations.ts";
import { formatAnswerScalar } from "../tool/format-answer.ts";
import type { QuestionData } from "../tool/types.ts";
import type { PreviewPane, PreviewPaneProps } from "./components/preview/preview-pane.ts";
import type { DialogState } from "./dialog-builder.ts";
import {
	HINT_PART_CANCEL,
	HINT_PART_CLEAR,
	HINT_PART_COLLAPSE,
	HINT_PART_NEW_LINE,
	HINT_PART_NOTES,
	HINT_PART_REVIEW_NOTE,
	HINT_PART_TAB,
	HINT_PART_TOGGLE,
	INCOMPLETE_WARNING_PREFIX,
	READY_PROMPT,
	REVIEW_HEADING,
} from "./dialog-copy.ts";
import type { StatefulView } from "./stateful-view.ts";
import type { TabComponents } from "./tab-components.ts";

const NOTES_HEADER = "Notes:";
const GLOBAL_NOTES_HEADER = "Global note:";
const REVIEW_NOTE_LABEL = "Note";
const SAVED_NOTE_LABEL = "Note for this answer:";

class OneLineClippedText implements Component {
	constructor(
		private readonly text: string,
		private readonly paddingLeft: number = 0,
	) {}

	render(width: number): string[] {
		const pad = " ".repeat(this.paddingLeft);
		const avail = Math.max(0, width - this.paddingLeft);
		return [pad + truncateToWidth(this.text, avail, "…", false)];
	}

	invalidate(): void {}

	handleInput(_data: string): void {}
}

export interface TabContentStrategy {
	readonly footerRowCount: number;

	headingRows(state: DialogState): Component[];

	bodyComponent(state: DialogState): Component;

	bodyHeight(width: number, state: DialogState): number;

	midRows(state: DialogState): Component[];

	footerRows(state: DialogState): Component[];

	focusedItemRowRange(width: number, state: DialogState): [number, number] | undefined;
}

export interface QuestionTabStrategyConfig {
	theme: Theme;
	questions: readonly QuestionData[];
	getPreviewPane: () => StatefulView<PreviewPaneProps>;
	tabsByIndex: ReadonlyArray<TabComponents>;
	notesInput: Editor;
	isMulti: boolean;
	getCurrentBodyHeight: (width: number) => number;
}

export class QuestionTabStrategy implements TabContentStrategy {
	readonly footerRowCount = 2;

	constructor(private readonly config: QuestionTabStrategyConfig) {}

	headingRows(state: DialogState): Component[] {
		const out: Component[] = [];
		const question = this.config.questions[state.currentTab];
		if (!this.config.isMulti && question?.header && question.header.length > 0) {
			out.push(new Text(this.config.theme.bg("selectedBg", ` ${question.header} `), 1, 0));
			out.push(new Spacer(1));
		}
		if (question) {
			out.push(new Text(this.config.theme.bold(question.question), 1, 0));
			out.push(new Spacer(1));
		}
		return out;
	}

	bodyComponent(state: DialogState): Component {
		const question = this.config.questions[state.currentTab];
		const mso = this.config.tabsByIndex[state.currentTab]?.multiSelect;
		if (question?.multiSelect === true && mso) return mso;
		return this.config.getPreviewPane();
	}

	bodyHeight(width: number, _state: DialogState): number {
		return this.config.getCurrentBodyHeight(width);
	}

	midRows(state: DialogState): Component[] {
		if (state.notesVisible) {
			return [
				new Text(this.config.theme.fg("muted", NOTES_HEADER), 1, 0),
				this.config.notesInput,
				new Spacer(1),
			];
		}
		const note = selectSavedNote(state.notesByTab, state.answers, state.currentTab);
		if (note === undefined) return [];
		const [firstLine = "", ...rest] = note.split("\n");
		const text = `${SAVED_NOTE_LABEL} ${firstLine}${rest.length > 0 ? " …" : ""}`;
		return [new OneLineClippedText(this.config.theme.fg("dim", text), 1)];
	}

	footerRows(state: DialogState): Component[] {
		const question = this.config.questions[state.currentTab];
		return [
			new Spacer(1),
			new OneLineClippedText(
				this.config.theme.fg(
					"dim",
					buildHintText(question, this.config.isMulti, state),
				),
				1,
			),
		];
	}

	focusedItemRowRange(width: number, state: DialogState): [number, number] | undefined {
		const question = this.config.questions[state.currentTab];
		const mso = this.config.tabsByIndex[state.currentTab]?.multiSelect;
		if (question?.multiSelect === true && mso) return mso.focusedItemRowRange(width);
		return (this.config.getPreviewPane() as unknown as PreviewPane).focusedItemRowRange(width);
	}
}

export interface SubmitTabStrategyConfig {
	theme: Theme;
	questions: readonly QuestionData[];
	submitPicker: Component | undefined;
	notesInput: Editor;
}

export class SubmitTabStrategy implements TabContentStrategy {
	readonly footerRowCount = 5;

	constructor(private readonly config: SubmitTabStrategyConfig) {}

	headingRows(_state: DialogState): Component[] {
		return [
			new Text(this.config.theme.bold(this.config.theme.fg("accent", REVIEW_HEADING)), 1, 0),
			new Spacer(1),
		];
	}

	bodyComponent(state: DialogState): Component {
		const c = new Container();
		for (let i = 0; i < this.config.questions.length; i++) {
			const q = this.config.questions[i];
			const a = state.answers.get(i);
			if (!a) continue;
			const label = q.header && q.header.length > 0 ? q.header : `Q${i + 1}`;
			const answerText = formatAnswerScalar(a);
			c.addChild(new Text(this.config.theme.fg("muted", ` ● ${label}`), 1, 0));
			c.addChild(
				new Text(`   ${this.config.theme.fg("muted", "→")} ${this.config.theme.fg("text", answerText)}`, 1, 0),
			);
			if (a.notes && a.notes.length > 0) {
				c.addChild(
					new Text(
						this.config.theme.fg("dim", `     ${SAVED_NOTE_LABEL} ${a.notes}`),
						1,
						0,
					),
				);
			}
		}
		const globalNote = state.notesByTab.get(this.config.questions.length);
		if (!state.notesVisible && globalNote && globalNote.length > 0) {
			c.addChild(new Text(this.config.theme.fg("muted", ` ● ${REVIEW_NOTE_LABEL}`), 1, 0));
			c.addChild(
				new Text(`   ${this.config.theme.fg("muted", "→")} ${this.config.theme.fg("text", globalNote)}`, 1, 0),
			);
		}
		return c;
	}

	bodyHeight(width: number, state: DialogState): number {
		return this.bodyComponent(state).render(width).length;
	}

	midRows(state: DialogState): Component[] {
		if (!state.notesVisible) return [];
		return [
			new Text(this.config.theme.fg("muted", GLOBAL_NOTES_HEADER), 1, 0),
			this.config.notesInput,
			new Spacer(1),
		];
	}

	footerRows(state: DialogState): Component[] {
		const missing: string[] = [];
		for (let i = 0; i < this.config.questions.length; i++) {
			const q = this.config.questions[i];
			if (!state.answers.has(i)) {
				missing.push(q.header && q.header.length > 0 ? q.header : `Q${i + 1}`);
			}
		}
		const promptText =
			missing.length === 0
				? this.config.theme.fg("muted", READY_PROMPT)
				: this.config.theme.fg(
						"warning",
						`${INCOMPLETE_WARNING_PREFIX} ${missing.join(", ")}`,
					);
		const out: Component[] = [new Spacer(1), new OneLineClippedText(promptText, 1)];
		if (this.config.submitPicker) {
			out.push(this.config.submitPicker);
		} else {
			out.push(new Spacer(1));
			out.push(new Spacer(1));
		}
		out.push(
			new OneLineClippedText(this.config.theme.fg("dim", buildSubmitHintText(state)), 1),
		);
		return out;
	}

	focusedItemRowRange(_width: number, _state: DialogState): [number, number] | undefined {
		return undefined;
	}
}

export function buildHintText(
	question: QuestionData | undefined,
	isMulti: boolean,
	state: DialogState,
): string {
	const parts: string[] = [];
	if (question?.multiSelect === true) parts.push(HINT_PART_TOGGLE);
	if (question && !state.notesVisible && !state.inputMode)
		parts.push(HINT_PART_NOTES);
	if (isMulti) parts.push(HINT_PART_TAB);
	parts.push(HINT_PART_CANCEL);
	parts.push(HINT_PART_COLLAPSE);
	if (state.notesVisible || state.inputMode) parts.push(HINT_PART_NEW_LINE);
	if (state.inputMode) parts.push(HINT_PART_CLEAR);
	return parts.join(" · ");
}

export function buildSubmitHintText(state: DialogState): string {
	const parts: string[] = [];
	if (!state.notesVisible) parts.push(HINT_PART_REVIEW_NOTE);
	parts.push(HINT_PART_CANCEL);
	if (state.notesVisible) parts.push(HINT_PART_NEW_LINE);
	return parts.join(" · ");
}
