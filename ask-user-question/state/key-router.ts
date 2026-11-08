import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { QuestionAnswer } from "../tool/types.ts";
import { ROW_INTENT_META } from "./row-intent.ts";
import type { QuestionnaireRuntime, QuestionnaireState } from "./state.ts";

const KEYBIND_UP = "tui.select.up";
const KEYBIND_DOWN = "tui.select.down";
const KEYBIND_CONFIRM = "tui.select.confirm";
const KEYBIND_SUBMIT = "tui.input.submit";
const KEYBIND_CANCEL = "tui.select.cancel";
const KEYBIND_NEW_LINE = "tui.input.newLine";
const KEYBIND_EDITOR_UP = "tui.editor.cursorUp";
const KEYBIND_EDITOR_DOWN = "tui.editor.cursorDown";
const KEYBIND_CLEAR = "tui.editor.deleteToLineStart";

export const NOTES_KEY = "n";

export type QuestionnaireAction =
	| { kind: "nav"; nextIndex: number; inputValue: string }
	| { kind: "input_clear" }
	| { kind: "tab_switch"; nextTab: number }
	| { kind: "confirm"; answer: QuestionAnswer; autoAdvanceTab?: number }
	| { kind: "toggle"; index: number }
	| { kind: "multi_confirm"; selected: string[]; answer: string | null; autoAdvanceTab?: number }
	| { kind: "cancel" }
	| { kind: "notes_enter" }
	| { kind: "notes_exit" }
	| { kind: "submit" }
	| { kind: "submit_nav"; nextIndex: 0 | 1 }
	| { kind: "notes_forward"; data: string }
	| { kind: "ignore" };

export interface QuestionnaireKeybindings {
	matches(data: string, name: string): boolean;
}

function isConfirm(kb: QuestionnaireKeybindings, data: string): boolean {
	return kb.matches(data, KEYBIND_CONFIRM) || kb.matches(data, KEYBIND_SUBMIT);
}

export function wrapTab(index: number, total: number): number {
	if (total <= 0) return 0;
	return ((index % total) + total) % total;
}

export function allAnswered(state: QuestionnaireState, runtime: QuestionnaireRuntime): boolean {
	if (runtime.questions.length === 0) return false;
	for (let i = 0; i < runtime.questions.length; i++) {
		if (!state.answers.has(i)) return false;
	}
	return true;
}

function totalTabs(runtime: QuestionnaireRuntime): number {
	return runtime.isMulti ? runtime.questions.length + 1 : 1;
}

function computeAutoAdvanceTab(state: QuestionnaireState, runtime: QuestionnaireRuntime): number | undefined {
	if (!runtime.isMulti) return undefined;
	if (state.currentTab < runtime.questions.length - 1) return state.currentTab + 1;
	return runtime.questions.length;
}

function buildSingleSelectAnswer(state: QuestionnaireState, runtime: QuestionnaireRuntime): QuestionAnswer | null {
	const q = runtime.questions[state.currentTab];
	if (!q) return null;

	const item = runtime.currentItem;

	if (state.inputMode) {
		const label = runtime.inputBuffer;
		if (label.trim().length === 0) return null;
		return {
			questionIndex: state.currentTab,
			question: q.question,
			kind: "custom",
			answer: label,
		};
	}
	if (!item) return null;
	if (item.kind === "other") {
		return null;
	}
	if (item.kind === "next") {
		return null;
	}
	return {
		questionIndex: state.currentTab,
		question: q.question,
		kind: "option",
		answer: item.label,
	};
}

function buildMultiSelected(state: QuestionnaireState, runtime: QuestionnaireRuntime): string[] {
	const q = runtime.questions[state.currentTab];
	if (!q) return [];
	const out: string[] = [];
	for (let i = 0; i < q.options.length; i++) {
		if (state.multiSelectChecked.has(i)) {
			const label = q.options[i]?.label;
			if (typeof label === "string") out.push(label);
		}
	}
	return out;
}

function buildMultiConfirmAction(state: QuestionnaireState, runtime: QuestionnaireRuntime): QuestionnaireAction {
	return {
		kind: "multi_confirm",
		selected: buildMultiSelected(state, runtime),
		answer: runtime.inputBuffer.trim().length > 0 ? runtime.inputBuffer : null,
		autoAdvanceTab: computeAutoAdvanceTab(state, runtime),
	};
}

function tabSwitchAction(
	data: string,
	state: QuestionnaireState,
	runtime: QuestionnaireRuntime,
): QuestionnaireAction | null {
	if (!runtime.isMulti) return null;
	const total = totalTabs(runtime);
	if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
		return { kind: "tab_switch", nextTab: wrapTab(state.currentTab + 1, total) };
	}
	if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
		return { kind: "tab_switch", nextTab: wrapTab(state.currentTab - 1, total) };
	}
	return null;
}

function nextNavOnDown(state: QuestionnaireState, runtime: QuestionnaireRuntime): QuestionnaireAction {
	return {
		kind: "nav",
		nextIndex: wrapTab(state.optionIndex + 1, Math.max(1, runtime.items.length)),
		inputValue: runtime.inputBuffer,
	};
}

function prevNavOnUp(state: QuestionnaireState, runtime: QuestionnaireRuntime): QuestionnaireAction {
	return {
		kind: "nav",
		nextIndex: wrapTab(state.optionIndex - 1, Math.max(1, runtime.items.length)),
		inputValue: runtime.inputBuffer,
	};
}

function routeNotesMode(kb: QuestionnaireKeybindings, data: string): QuestionnaireAction {
	if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "notes_exit" };
	if (kb.matches(data, KEYBIND_NEW_LINE)) return { kind: "notes_forward", data };
	if (isConfirm(kb, data)) return { kind: "notes_exit" };
	return { kind: "notes_forward", data };
}

function routeInputMode(
	kb: QuestionnaireKeybindings,
	data: string,
	state: QuestionnaireState,
	runtime: QuestionnaireRuntime,
): QuestionnaireAction {
	if (kb.matches(data, KEYBIND_NEW_LINE)) return { kind: "ignore" };
	if (isConfirm(kb, data)) {
		const q = runtime.questions[state.currentTab];
		if (q?.multiSelect) return buildMultiConfirmAction(state, runtime);
		const answer = buildSingleSelectAnswer(state, runtime);
		if (!answer) return { kind: "ignore" };
		return { kind: "confirm", answer, autoAdvanceTab: computeAutoAdvanceTab(state, runtime) };
	}
	if (kb.matches(data, KEYBIND_CLEAR)) return { kind: "input_clear" };
	if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
	if (kb.matches(data, KEYBIND_EDITOR_UP) && runtime.canMoveInputUp) return { kind: "ignore" };
	if (kb.matches(data, KEYBIND_EDITOR_DOWN) && runtime.canMoveInputDown) return { kind: "ignore" };
	if (kb.matches(data, KEYBIND_UP)) return prevNavOnUp(state, runtime);
	if (kb.matches(data, KEYBIND_DOWN)) return nextNavOnDown(state, runtime);
	return { kind: "ignore" };
}

function routeSubmitTab(
	kb: QuestionnaireKeybindings,
	data: string,
	state: QuestionnaireState,
	runtime: QuestionnaireRuntime,
): QuestionnaireAction {
	if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
	const tab = tabSwitchAction(data, state, runtime);
	if (tab) return tab;
	if (kb.matches(data, KEYBIND_UP) || kb.matches(data, KEYBIND_DOWN)) {
		const delta = kb.matches(data, KEYBIND_DOWN) ? 1 : -1;
		const next = wrapTab(state.submitChoiceIndex + delta, 2);
		return { kind: "submit_nav", nextIndex: (next === 1 ? 1 : 0) as 0 | 1 };
	}
	if (isConfirm(kb, data)) {
		return state.submitChoiceIndex === 1 ? { kind: "cancel" } : { kind: "submit" };
	}
	if (matchesKey(data, NOTES_KEY)) {
		return { kind: "notes_enter" };
	}
	return { kind: "ignore" };
}

const DIGIT_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

function digitRow(
	data: string,
	runtime: QuestionnaireRuntime,
): { index: number; activatesInputMode: boolean } | undefined {
	const index = DIGIT_KEYS.findIndex((digit) => matchesKey(data, digit));
	const item = runtime.items[index];
	if (!item || !ROW_INTENT_META[item.kind].numbered) return undefined;
	return { index, activatesInputMode: ROW_INTENT_META[item.kind].activatesInputMode };
}

function routeMultiSelectTab(
	kb: QuestionnaireKeybindings,
	data: string,
	state: QuestionnaireState,
	runtime: QuestionnaireRuntime,
): QuestionnaireAction {
	const focusedKind = runtime.currentItem?.kind;
	const focusedMeta = focusedKind ? ROW_INTENT_META[focusedKind] : undefined;
	if (matchesKey(data, Key.space)) {
		if (focusedMeta?.blocksMultiToggle) return { kind: "ignore" };
		if (focusedMeta?.activatesInputMode) return { kind: "ignore" };
		return { kind: "toggle", index: state.optionIndex };
	}
	if (isConfirm(kb, data)) {
		if (focusedMeta?.activatesInputMode) return { kind: "ignore" };
		if (!focusedMeta?.autoSubmitsInMulti) return { kind: "toggle", index: state.optionIndex };
		return buildMultiConfirmAction(state, runtime);
	}
	if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
	const row = digitRow(data, runtime);
	if (!row) return { kind: "ignore" };
	if (row.activatesInputMode) return { kind: "nav", nextIndex: row.index, inputValue: runtime.inputBuffer };
	return { kind: "toggle", index: row.index };
}

function routeSingleSelectTab(
	kb: QuestionnaireKeybindings,
	data: string,
	state: QuestionnaireState,
	runtime: QuestionnaireRuntime,
): QuestionnaireAction {
	if (isConfirm(kb, data)) {
		const answer = buildSingleSelectAnswer(state, runtime);
		if (!answer) return { kind: "ignore" };
		return { kind: "confirm", answer, autoAdvanceTab: computeAutoAdvanceTab(state, runtime) };
	}
	if (kb.matches(data, KEYBIND_CANCEL)) return { kind: "cancel" };
	const row = digitRow(data, runtime);
	if (!row) return { kind: "ignore" };
	if (row.activatesInputMode) return { kind: "nav", nextIndex: row.index, inputValue: runtime.inputBuffer };
	const answer = buildSingleSelectAnswer(
		{ ...state, optionIndex: row.index },
		{ ...runtime, currentItem: runtime.items[row.index] },
	);
	if (!answer) return { kind: "ignore" };
	return { kind: "confirm", answer, autoAdvanceTab: computeAutoAdvanceTab(state, runtime) };
}

export function routeKey(data: string, state: QuestionnaireState, runtime: QuestionnaireRuntime): QuestionnaireAction {
	const kb = runtime.keybindings;

	if (state.notesVisible) return routeNotesMode(kb, data);
	if (state.inputMode) return routeInputMode(kb, data, state, runtime);
	if (runtime.isMulti && state.currentTab === runtime.questions.length) {
		return routeSubmitTab(kb, data, state, runtime);
	}

	const tab = tabSwitchAction(data, state, runtime);
	if (tab) return tab;

	const q = runtime.questions[state.currentTab];
	if (!q) return { kind: "ignore" };

	if (matchesKey(data, NOTES_KEY)) {
		return { kind: "notes_enter" };
	}

	if (kb.matches(data, KEYBIND_UP)) {
		return prevNavOnUp(state, runtime);
	}
	if (kb.matches(data, KEYBIND_DOWN)) {
		return nextNavOnDown(state, runtime);
	}

	if (q.multiSelect) return routeMultiSelectTab(kb, data, state, runtime);
	return routeSingleSelectTab(kb, data, state, runtime);
}
