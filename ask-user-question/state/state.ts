import type { QuestionAnswer, QuestionData } from "../tool/types.ts";
import type { WrappingSelectItem } from "../view/components/wrapping-select.ts";

export interface QuestionnaireState {
	currentTab: number;
	optionIndex: number;
	inputMode: boolean;
	notesVisible: boolean;
	answers: ReadonlyMap<number, QuestionAnswer>;
	multiSelectChecked: ReadonlySet<number>;
	customDraftsByTab: ReadonlyMap<number, string>;
	notesByTab: ReadonlyMap<number, string>;
	submitChoiceIndex: number;
	notesDraft: string;
}

export interface QuestionnaireRuntime {
	keybindings: { matches(data: string, name: string): boolean };
	inputBuffer: string;
	canMoveInputUp: boolean;
	canMoveInputDown: boolean;
	questions: readonly QuestionData[];
	isMulti: boolean;
	currentItem: WrappingSelectItem | undefined;
	items: readonly WrappingSelectItem[];
}
