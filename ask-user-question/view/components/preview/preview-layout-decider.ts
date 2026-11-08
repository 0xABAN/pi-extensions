import { visibleWidth } from "@earendil-works/pi-tui";
import type { QuestionData } from "../../../tool/types.ts";
import type { WrappingSelectItem } from "../wrapping-select.ts";
import { BORDER_HORIZONTAL_OVERHEAD, BORDER_INNER_PADDING_HORIZONTAL } from "./preview-box-renderer.ts";

export const PREVIEW_MIN_WIDTH = 100;
export const PREVIEW_COLUMN_GAP = 2;
export const PREVIEW_PADDING_LEFT = 1;
export const STACKED_GAP_ROWS = 1;

export const MIN_LEFT = 30;
export const MAX_LEFT_RATIO = 0.5;
export const MIN_PREVIEW_WIDTH = 45;
export const CONFIRMED_OVERHEAD = 2;

export type PreviewLayoutMode = "side-by-side" | "stacked";

export function decideLayout(terminalWidth: number, paneWidth: number): PreviewLayoutMode {
	return terminalWidth >= PREVIEW_MIN_WIDTH && paneWidth >= PREVIEW_MIN_WIDTH ? "side-by-side" : "stacked";
}

export function adaptiveLeftWidth(
	items: readonly WrappingSelectItem[],
	totalForNumbering: number,
	paneWidth: number,
): number {
	const prefixW = String(Math.max(1, totalForNumbering)).length + 4;
	const confirmedOverhead = CONFIRMED_OVERHEAD;
	let maxLabel = 0;
	for (const item of items) {
		const w = visibleWidth(item.label);
		if (w > maxLabel) maxLabel = w;
	}
	const desired = maxLabel + prefixW + confirmedOverhead;
	const ratioCapped = Math.min(desired, Math.floor(paneWidth * MAX_LEFT_RATIO));
	const available = paneWidth - PREVIEW_COLUMN_GAP - MIN_PREVIEW_WIDTH;
	return Math.max(MIN_LEFT, Math.min(ratioCapped, Math.max(1, available)));
}

export function crossTabMaxLeftWidth(
	tabs: ReadonlyArray<{ multiSelect?: boolean }>,
	itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>,
	paneWidth: number,
): number {
	let max = MIN_LEFT;
	for (let i = 0; i < tabs.length; i++) {
		const items = itemsByTab[i] ?? [];
		const totalForNumbering = items.length;
		const tabWidth = adaptiveLeftWidth(items, totalForNumbering, paneWidth);
		if (tabWidth > max) max = tabWidth;
	}
	return max;
}

export function previewSourceWidth(question: QuestionData): number {
	let max = 0;
	for (const option of question.options) {
		const text = option.preview;
		if (!text) continue;
		for (const line of text.split("\n")) {
			const w = visibleWidth(line);
			if (w > max) max = w;
		}
	}
	return max;
}

export function crossTabPreviewBudget(questions: readonly QuestionData[], paneWidth: number): number {
	let max = MIN_PREVIEW_WIDTH;
	for (const question of questions) {
		const rawWidth = previewSourceWidth(question);
		const capped = Math.min(rawWidth, paneWidth - PREVIEW_COLUMN_GAP - MIN_LEFT);
		const budget = capped + BORDER_HORIZONTAL_OVERHEAD + 2 * BORDER_INNER_PADDING_HORIZONTAL + PREVIEW_PADDING_LEFT;
		if (budget > max) max = budget;
	}
	return max;
}

export function crossTabLeftWidthWithDonation(
	tabs: ReadonlyArray<{ multiSelect?: boolean }>,
	itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>,
	questions: readonly QuestionData[],
	paneWidth: number,
): number {
	const labelDriven = crossTabMaxLeftWidth(tabs, itemsByTab, paneWidth);
	const previewBudget = crossTabPreviewBudget(questions, paneWidth);
	const slackDonation = paneWidth - PREVIEW_COLUMN_GAP - previewBudget;
	const previewSafetyCeiling = paneWidth - PREVIEW_COLUMN_GAP - MIN_PREVIEW_WIDTH;
	const ratioCeiling = Math.floor(paneWidth * MAX_LEFT_RATIO);
	const ceiling = Math.min(previewSafetyCeiling, ratioCeiling);
	return Math.min(Math.max(labelDriven, slackDonation), Math.max(1, ceiling));
}

export function columnWidths(
	paneWidth: number,
	adaptiveLeft: number,
): { leftWidth: number; rightWidth: number; gap: number } {
	const gap = PREVIEW_COLUMN_GAP;
	const leftWidth = Math.min(adaptiveLeft, Math.max(1, paneWidth - gap - 1));
	const rightWidth = Math.max(1, paneWidth - leftWidth - gap);
	return { leftWidth, rightWidth, gap };
}

export function bodyWidths(
	paneWidth: number,
	mode: PreviewLayoutMode,
	adaptiveLeft: number,
): { optionsWidth: number; previewWidth: number } {
	if (mode === "stacked") return { optionsWidth: paneWidth, previewWidth: paneWidth };
	const { leftWidth, rightWidth } = columnWidths(paneWidth, adaptiveLeft);
	return { optionsWidth: leftWidth, previewWidth: Math.max(1, rightWidth - PREVIEW_PADDING_LEFT) };
}
