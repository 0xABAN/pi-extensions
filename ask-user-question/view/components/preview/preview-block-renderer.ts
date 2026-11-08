import type { Theme } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { NOTES_KEY } from "../../../state/key-router.ts";
import type { QuestionData } from "../../../tool/types.ts";
import {
	MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE,
	MAX_PREVIEW_HEIGHT_STACKED,
	MarkdownContentCache,
	NOTES_AFFORDANCE_OVERHEAD,
} from "./markdown-content-cache.ts";
import {
	BORDER_HORIZONTAL_OVERHEAD,
	BORDER_INNER_PADDING_HORIZONTAL,
	BORDER_VERTICAL_OVERHEAD,
	computeBoxDimensions,
	renderBorderedBox,
} from "./preview-box-renderer.ts";
import type { PreviewLayoutMode } from "./preview-layout-decider.ts";

export const NOTES_AFFORDANCE_TEXT = `Notes: press ${NOTES_KEY} to add notes`;
export const NOTES_EDIT_AFFORDANCE_TEXT = `Note saved: press ${NOTES_KEY} to edit`;

export type NotesAffordance = "add" | "edit" | "none";

function contentBudgetFor(mode: PreviewLayoutMode): number {
	const cap = mode === "side-by-side" ? MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE : MAX_PREVIEW_HEIGHT_STACKED;
	return Math.max(1, cap - BORDER_VERTICAL_OVERHEAD - NOTES_AFFORDANCE_OVERHEAD);
}

function fitBlock(
	rawRows: number,
	mode: PreviewLayoutMode,
	maxRows: number | undefined,
): { contentRows: number; affordance: boolean } | undefined {
	const contentRows = Math.min(rawRows, contentBudgetFor(mode));
	if (maxRows === undefined || BORDER_VERTICAL_OVERHEAD + contentRows + NOTES_AFFORDANCE_OVERHEAD <= maxRows) {
		return { contentRows, affordance: true };
	}
	const fitted = Math.min(contentRows, maxRows - BORDER_VERTICAL_OVERHEAD);
	return fitted >= 1 ? { contentRows: fitted, affordance: false } : undefined;
}

function innerWidthFor(width: number): number {
	return Math.max(1, width - BORDER_HORIZONTAL_OVERHEAD - 2 * BORDER_INNER_PADDING_HORIZONTAL);
}

export interface PreviewBlockRendererConfig {
	question: QuestionData;
	theme: Theme;
	markdownTheme: MarkdownTheme;
}

export class PreviewBlockRenderer {
	private readonly theme: Theme;
	private readonly cache: MarkdownContentCache;

	constructor(config: PreviewBlockRendererConfig) {
		this.theme = config.theme;
		this.cache = new MarkdownContentCache(config.question, config.theme, config.markdownTheme);
	}

	hasAnyPreview(): boolean {
		return this.cache.hasAnyPreview();
	}

	has(optionIndex: number): boolean {
		return this.cache.has(optionIndex);
	}

	invalidate(): void {
		this.cache.invalidate();
	}

	blockHeight(width: number, optionIndex: number, mode: PreviewLayoutMode, maxRows?: number): number {
		const rawRows = this.cache.bodyFor(optionIndex, innerWidthFor(width)).length;
		const fit = fitBlock(rawRows, mode, maxRows);
		return fit ? BORDER_VERTICAL_OVERHEAD + fit.contentRows + (fit.affordance ? NOTES_AFFORDANCE_OVERHEAD : 0) : 0;
	}

	renderBlock(
		width: number,
		optionIndex: number,
		mode: PreviewLayoutMode,
		affordance: NotesAffordance,
		maxRows?: number,
	): string[] {
		const maxInnerWidth = innerWidthFor(width);
		const raw = this.cache.bodyFor(optionIndex, maxInnerWidth);
		const fit = fitBlock(raw.length, mode, maxRows);
		if (!fit) return [];
		const hidden = raw.length - fit.contentRows;
		const contentLines = hidden > 0 ? raw.slice(0, fit.contentRows) : raw;

		const { boxWidth } = computeBoxDimensions(contentLines, maxInnerWidth);
		const colorFn = (s: string) => this.theme.fg("accent", s);
		const boxedLines = renderBorderedBox(contentLines, boxWidth, colorFn, hidden);
		if (!fit.affordance) return boxedLines;

		const text =
			affordance !== "none" && this.cache.has(optionIndex)
				? affordance === "edit"
					? NOTES_EDIT_AFFORDANCE_TEXT
					: NOTES_AFFORDANCE_TEXT
				: "";
		return [...boxedLines, "", text ? this.theme.fg("muted", text) : ""];
	}
}
