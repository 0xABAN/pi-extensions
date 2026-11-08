import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { QuestionData } from "../../../tool/types.ts";
import { windowLines } from "../../scroll-window.ts";
import type { StatefulView } from "../../stateful-view.ts";
import type { OptionListView } from "../option-list-view.ts";
import type { NotesAffordance, PreviewBlockRenderer } from "./preview-block-renderer.ts";
import {
	bodyWidths,
	columnWidths,
	decideLayout,
	PREVIEW_PADDING_LEFT,
	type PreviewLayoutMode,
	STACKED_GAP_ROWS,
} from "./preview-layout-decider.ts";

const MIN_BOX_ROWS = 3;

export {
	MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE,
	MAX_PREVIEW_HEIGHT_STACKED,
	NO_PREVIEW_TEXT,
	NOTES_AFFORDANCE_OVERHEAD,
} from "./markdown-content-cache.ts";
export { NOTES_AFFORDANCE_TEXT, NOTES_EDIT_AFFORDANCE_TEXT, PreviewBlockRenderer } from "./preview-block-renderer.ts";
export {
	BORDER_HORIZONTAL_OVERHEAD,
	BORDER_INNER_PADDING_HORIZONTAL,
	BORDER_VERTICAL_OVERHEAD,
	BOX_MIN_CONTENT_WIDTH,
	renderBorderedBox,
	stripFenceMarkers,
} from "./preview-box-renderer.ts";
export {
	PREVIEW_COLUMN_GAP,
	PREVIEW_MIN_WIDTH,
	PREVIEW_PADDING_LEFT,
	STACKED_GAP_ROWS,
} from "./preview-layout-decider.ts";

export interface PreviewPaneProps {
	notesVisible: boolean;
	hasNote: boolean;
	selectedIndex: number;
	focused: boolean;
	inputMode: boolean;
}

export interface PreviewPaneConfig {
	question: QuestionData;
	theme: Theme;
	getTerminalWidth: () => number;
	optionListView: OptionListView;
	previewBlock: PreviewBlockRenderer;
}

export class PreviewPane implements StatefulView<PreviewPaneProps>, Component {
	private readonly question: QuestionData;
	private readonly getTerminalWidth: () => number;
	private readonly optionListView: OptionListView;
	private readonly previewBlock: PreviewBlockRenderer;
	private readonly theme: Theme;
	private props: PreviewPaneProps;
	private rowAllowance: number | undefined;
	private globalLeftWidth: (paneWidth: number) => number = () => {
		throw new Error("PreviewPane.setGlobalLeftWidth must be called before render()");
	};

	constructor(config: PreviewPaneConfig) {
		this.question = config.question;
		this.getTerminalWidth = config.getTerminalWidth;
		this.optionListView = config.optionListView;
		this.previewBlock = config.previewBlock;
		this.theme = config.theme;
		this.props = { notesVisible: false, hasNote: false, selectedIndex: 0, focused: false, inputMode: false };
	}

	setGlobalLeftWidth(getter: (paneWidth: number) => number): void {
		this.globalLeftWidth = getter;
	}

	private getAdaptiveLeft(paneWidth: number): number {
		return this.globalLeftWidth(paneWidth);
	}

	setProps(props: PreviewPaneProps): void {
		this.props = props;
	}

	private notesAffordance(): NotesAffordance {
		const { focused, notesVisible, hasNote } = this.props;
		if (!focused || notesVisible) return "none";
		return hasNote ? "edit" : "add";
	}

	setRowAllowance(rows: number | undefined): void {
		this.rowAllowance = rows;
	}

	handleInput(_data: string): void {}

	invalidate(): void {
		this.previewBlock.invalidate();
		this.optionListView.invalidate();
	}

	render(width: number): string[] {
		if (this.question.multiSelect === true) return this.optionListView.render(width);
		if (!this.previewBlock.hasAnyPreview()) return this.optionListView.render(width);
		if (this.props.inputMode) return this.optionListView.render(width);

		return this.layout(width).lines;
	}

	private layout(width: number): { lines: string[]; focus: [number, number] | undefined } {
		const mode = decideLayout(this.getTerminalWidth(), width);
		return mode === "side-by-side" ? this.layoutSideBySide(width, mode) : this.layoutStacked(width, mode);
	}

	private layoutStacked(
		width: number,
		mode: PreviewLayoutMode,
	): { lines: string[]; focus: [number, number] | undefined } {
		const { selectedIndex } = this.props;
		const affordance = this.notesAffordance();
		const options = this.optionListView.render(width);
		const focus = this.optionListView.focusedItemRowRange(width);
		const gap = Array<string>(STACKED_GAP_ROWS).fill("");
		const allowance = this.rowAllowance;
		const fullBlock = this.previewBlock.blockHeight(width, selectedIndex, mode);
		if (allowance === undefined || options.length + STACKED_GAP_ROWS + fullBlock <= allowance) {
			return {
				lines: [...options, ...gap, ...this.previewBlock.renderBlock(width, selectedIndex, mode, affordance)],
				focus,
			};
		}
		const focusRows = focus ? focus[1] - focus[0] : 1;
		const previewRowsWith = (optionsFloor: number) =>
			Math.min(fullBlock, allowance - STACKED_GAP_ROWS - Math.min(options.length, optionsFloor));
		const roomy = previewRowsWith(focusRows + 2);
		const previewRows = roomy >= MIN_BOX_ROWS ? roomy : previewRowsWith(focusRows);
		const block = this.previewBlock.renderBlock(width, selectedIndex, mode, affordance, previewRows);
		const optionRows = allowance - (block.length > 0 ? STACKED_GAP_ROWS + block.length : 0);
		const windowed = windowLines(options, Math.max(1, optionRows), focus, this.theme);
		return {
			lines: block.length > 0 ? [...windowed.lines, ...gap, ...block] : windowed.lines,
			focus: windowed.focus,
		};
	}

	private layoutSideBySide(
		width: number,
		mode: PreviewLayoutMode,
	): { lines: string[]; focus: [number, number] | undefined } {
		const adaptiveLeft = this.getAdaptiveLeft(width);
		const { leftWidth, rightWidth, gap } = columnWidths(width, adaptiveLeft);
		const allowance = this.rowAllowance;
		const left =
			allowance === undefined
				? {
						lines: this.optionListView.render(leftWidth),
						focus: this.optionListView.focusedItemRowRange(leftWidth),
					}
				: windowLines(
						this.optionListView.render(leftWidth),
						allowance,
						this.optionListView.focusedItemRowRange(leftWidth),
						this.theme,
					);
		const rightLines = this.renderPaddedPreviewLines(rightWidth, mode, allowance);
		const rows = Math.max(left.lines.length, rightLines.length);
		const gapStr = " ".repeat(gap);
		const out: string[] = [];
		for (let i = 0; i < rows; i++) {
			const leftRaw = left.lines[i] ?? "";
			const rightRaw = rightLines[i] ?? "";
			const leftClamped = truncateToWidth(leftRaw, leftWidth, "");
			const leftPad = " ".repeat(Math.max(0, leftWidth - visibleWidth(leftClamped)));
			const joined = `${leftClamped}${leftPad}${gapStr}${rightRaw}`;
			out.push(truncateToWidth(joined, width, ""));
		}
		return { lines: out, focus: left.focus };
	}

	focusedItemRowRange(width: number): [number, number] {
		if (this.question.multiSelect === true) return this.optionListView.focusedItemRowRange(width);
		if (!this.previewBlock.hasAnyPreview()) return this.optionListView.focusedItemRowRange(width);
		if (this.props.inputMode) return this.optionListView.focusedItemRowRange(width);
		return this.layout(width).focus ?? [0, 1];
	}

	naturalHeight(width: number): number {
		if (this.question.multiSelect === true) return this.optionListView.render(width).length;
		if (!this.previewBlock.hasAnyPreview()) return this.optionListView.render(width).length;
		if (this.props.inputMode) return this.optionListView.render(width).length;
		if (this.rowAllowance !== undefined) return this.layout(width).lines.length;
		const mode = decideLayout(this.getTerminalWidth(), width);
		const adaptiveLeft = this.getAdaptiveLeft(width);
		const { optionsWidth, previewWidth } = bodyWidths(width, mode, adaptiveLeft);
		const optionsHeight = this.optionListView.render(optionsWidth).length;
		const previewBlockHeight = this.previewBlock.blockHeight(previewWidth, this.props.selectedIndex, mode);
		if (mode === "side-by-side") return Math.max(optionsHeight, previewBlockHeight);
		return optionsHeight + STACKED_GAP_ROWS + previewBlockHeight;
	}

	maxNaturalHeight(width: number): number {
		if (this.question.multiSelect === true) return this.optionListView.render(width).length;
		if (!this.previewBlock.hasAnyPreview()) return this.optionListView.render(width).length;
		if (this.props.inputMode) return this.optionListView.render(width).length;
		const mode = decideLayout(this.getTerminalWidth(), width);
		const adaptiveLeft = this.getAdaptiveLeft(width);
		const { optionsWidth, previewWidth } = bodyWidths(width, mode, adaptiveLeft);
		const optionsHeight = this.optionListView.render(optionsWidth).length;
		let maxPreviewBlock = 0;
		for (let i = 0; i < this.question.options.length; i++) {
			const h = this.previewBlock.blockHeight(previewWidth, i, mode);
			if (h > maxPreviewBlock) maxPreviewBlock = h;
		}
		const max =
			mode === "side-by-side"
				? Math.max(optionsHeight, maxPreviewBlock)
				: optionsHeight + STACKED_GAP_ROWS + maxPreviewBlock;
		return this.rowAllowance === undefined ? max : Math.min(max, this.rowAllowance);
	}

	private renderPaddedPreviewLines(colWidth: number, mode: PreviewLayoutMode, maxRows: number | undefined): string[] {
		const inner = Math.max(1, colWidth - PREVIEW_PADDING_LEFT);
		const contentLines = this.previewBlock.renderBlock(
			inner,
			this.props.selectedIndex,
			mode,
			this.notesAffordance(),
			maxRows,
		);
		const boxWidth = Math.max(1, visibleWidth(contentLines[0] ?? ""));
		const boxAlignedPad = Math.max(PREVIEW_PADDING_LEFT, colWidth - boxWidth);
		return contentLines.map((line) => {
			if (line === "") return "";
			const pad = Math.max(PREVIEW_PADDING_LEFT, Math.min(boxAlignedPad, colWidth - visibleWidth(line)));
			return `${" ".repeat(pad)}${truncateToWidth(line, colWidth - pad, "")}`;
		});
	}
}
