import type { QuestionnaireResult } from "./tool/types.ts";

export const INLINE_ROW_RATIO = 0.7;
export const INLINE_MIN_ROWS = 12;

export type RowBudget = (terminalRows: number) => number;

export const fullRowBudget: RowBudget = (terminalRows) => terminalRows;

export const HOST_ALLOCATED_ROWS = Symbol.for("rpiv-ask-user-question:host-allocated-rows");

function hostAllocatesRows(terminal: object): boolean {
	return (terminal as Record<symbol, unknown>)[HOST_ALLOCATED_ROWS] === true;
}

export function rowBudgetForHost(terminal: object, budget: RowBudget): RowBudget {
	return hostAllocatesRows(terminal) ? fullRowBudget : budget;
}

export const YIELD_TO_OVERLAY: QuestionnaireResult = Object.freeze({
	answers: [],
	cancelled: true,
}) as QuestionnaireResult;

export function mustYieldInlineSlot(tui: { terminal: object; hasOverlay?: () => boolean }): boolean {
	if (hostAllocatesRows(tui.terminal)) return false;
	const { getTopmostVisibleOverlay } = tui as { getTopmostVisibleOverlay?: () => unknown };
	if (typeof getTopmostVisibleOverlay === "function") return getTopmostVisibleOverlay.call(tui) !== undefined;
	return typeof tui.hasOverlay === "function" && tui.hasOverlay();
}

export const inlineRowBudget: RowBudget = (terminalRows) =>
	Math.min(terminalRows, Math.max(INLINE_MIN_ROWS, Math.floor(terminalRows * INLINE_ROW_RATIO)));

export interface Presentation {
	overlay: boolean;
	hideOnCollapse?: boolean;
	rowBudget: RowBudget;
	release?: () => void;
}

let inlineSlotHeld = false;

function claimInlineSlot(): (() => void) | undefined {
	if (inlineSlotHeld) return undefined;
	inlineSlotHeld = true;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		inlineSlotHeld = false;
	};
}

export const OVERLAY_PRESENTATION: Presentation = Object.freeze({
	overlay: true,
	rowBudget: fullRowBudget,
	hideOnCollapse: true,
});

export const STACKED_OVERLAY_PRESENTATION: Presentation = Object.freeze({
	overlay: true,
	rowBudget: fullRowBudget,
	hideOnCollapse: false,
});

export function resolvePresentation(): Presentation {
	const release = claimInlineSlot();
	return release ? { overlay: false, rowBudget: inlineRowBudget, release } : OVERLAY_PRESENTATION;
}
