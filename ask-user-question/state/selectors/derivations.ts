import type { QuestionAnswer, QuestionData } from "../../tool/types.ts";
import type { WrappingSelectItem } from "../../view/components/wrapping-select.ts";

export function selectConfirmedIndicator(
	questions: readonly QuestionData[],
	currentTab: number,
	answers: ReadonlyMap<number, QuestionAnswer>,
	items: readonly WrappingSelectItem[],
): { index: number; labelOverride?: string } | undefined {
	const q = questions[currentTab];
	if (!q || q.multiSelect === true) return undefined;
	const prior = answers.get(currentTab);
	if (!prior) return undefined;
	if (prior.kind === "custom") {
		const otherIndex = items.findIndex((it) => it.kind === "other");
		if (otherIndex < 0) return undefined;
		return { index: otherIndex, labelOverride: prior.answer ?? "" };
	}
	if (prior.kind !== "option" || typeof prior.answer !== "string") return undefined;
	const index = items.findIndex((it) => it.kind === "option" && it.label === prior.answer);
	if (index < 0) return undefined;
	return { index };
}

export function selectActivePreviewPaneIndex(currentTab: number, totalQuestions: number): number {
	if (totalQuestions <= 0) return 0;
	return Math.min(currentTab, totalQuestions - 1);
}

export function selectSavedNote(
	notesByTab: ReadonlyMap<number, string>,
	answers: ReadonlyMap<number, QuestionAnswer>,
	tab: number,
): string | undefined {
	const note = notesByTab.get(tab) ?? answers.get(tab)?.notes;
	return note && note.length > 0 ? note : undefined;
}
