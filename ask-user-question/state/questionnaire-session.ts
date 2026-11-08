import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Editor, TUI } from "@earendil-works/pi-tui";
import type { QuestionData, QuestionnaireResult, QuestionParams } from "../tool/types.ts";
import type { WrappingSelectItem } from "../view/components/wrapping-select.ts";
import type { QuestionnairePropsAdapter } from "../view/props-adapter.ts";
import { buildQuestionnaire, type QuestionnaireBuilt } from "./build-questionnaire.ts";
import { type QuestionnaireAction, routeKey } from "./key-router.ts";
import type { QuestionnaireRuntime, QuestionnaireState } from "./state.ts";
import { type ApplyContext, type Effect, reduce } from "./state-reducer.ts";

export interface QuestionnaireSessionConfig {
	tui: TUI;
	theme: Theme;
	params: QuestionParams;
	itemsByTab: WrappingSelectItem[][];
	done: (result: QuestionnaireResult) => void;
	keybindings: QuestionnaireRuntime["keybindings"];
}

export interface QuestionnaireSessionComponent {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
}

function initialState(): QuestionnaireState {
	return {
		currentTab: 0,
		optionIndex: 0,
		inputMode: false,
		notesVisible: false,
		answers: new Map(),
		multiSelectChecked: new Set(),
		customDraftsByTab: new Map(),
		notesByTab: new Map(),
		submitChoiceIndex: 0,
		notesDraft: "",
	};
}

export class QuestionnaireSession {
	private state: QuestionnaireState = initialState();

	private readonly questions: readonly QuestionData[];
	private readonly isMulti: boolean;
	private readonly itemsByTab: WrappingSelectItem[][];

	private readonly notesInput: Editor;
	private readonly inlineInput: Editor;
	private readonly viewAdapter: QuestionnairePropsAdapter;
	private readonly keybindings: QuestionnaireRuntime["keybindings"];

	private readonly tui: QuestionnaireSessionConfig["tui"];
	private readonly done: QuestionnaireSessionConfig["done"];
	readonly component: QuestionnaireSessionComponent;

	constructor(config: QuestionnaireSessionConfig) {
		this.tui = config.tui;
		this.done = config.done;
		this.questions = config.params.questions;
		this.isMulti = this.questions.length > 1;
		this.itemsByTab = config.itemsByTab;
		this.keybindings = config.keybindings;

		const built = buildQuestionnaire({
			tui: this.tui,
			theme: config.theme,
			questions: this.questions,
			itemsByTab: this.itemsByTab,
			isMulti: this.isMulti,
			initialState: this.state,
			getCurrentTab: () => this.state.currentTab,
		});

		this.notesInput = built.notesInput;
		this.inlineInput = built.inlineInput;
		this.viewAdapter = built.adapter;

		this.component = this.assembleComponent(built);
		this.viewAdapter.apply(this.state);
	}

	private assembleComponent(built: QuestionnaireBuilt): QuestionnaireSessionComponent {
		return {
			render: (width) => built.render(width),
			invalidate: built.invalidate,
			handleInput: (data) => this.dispatch(data),
		};
	}

	dispatch(data: string): void {
		const action = routeKey(data, this.state, this.runtime());
		if (action.kind === "ignore") {
			this.handleIgnoreInline(data);
			return;
		}
		this.commit(action);
	}

	private commit(action: QuestionnaireAction): void {
		const result = reduce(this.state, action, this.applyContext());
		this.state = result.state;
		for (const effect of result.effects) this.runEffect(effect);
		this.state = this.mirrorNotesDraft(this.state);
		this.viewAdapter.apply(this.state);
	}

	private mirrorNotesDraft(s: QuestionnaireState): QuestionnaireState {
		const draft = this.notesInput.getExpandedText?.() ?? this.notesInput.getText();
		return s.notesDraft === draft ? s : { ...s, notesDraft: draft };
	}

	private runEffect(effect: Effect): void {
		switch (effect.kind) {
			case "set_input_buffer":
				this.inlineInput.setText(effect.value);
				return;
			case "clear_input_buffer":
				this.inlineInput.setText("");
				return;
			case "set_notes_value":
				this.notesInput.setText(effect.value);
				return;
			case "set_notes_focused":
				this.notesInput.focused = effect.focused;
				return;
			case "forward_notes_keystroke":
				this.notesInput.handleInput(effect.data);
				return;
			case "done":
				this.done(effect.result);
				return;
		}
	}

	private handleIgnoreInline(data: string): void {
		if (!this.state.inputMode) return;
		this.inlineInput.handleInput(data);
		this.viewAdapter.apply(this.state);
	}

	private runtime(): QuestionnaireRuntime {
		const cursor = this.inlineInput.getCursor();
		const lastLine = this.inlineInput.getLines().length - 1;
		return {
			keybindings: this.keybindings,
			inputBuffer: this.inlineInput.getExpandedText?.() ?? this.inlineInput.getText(),
			canMoveInputUp: cursor.line > 0,
			canMoveInputDown: cursor.line < lastLine,
			questions: this.questions,
			isMulti: this.isMulti,
			currentItem: this.currentItem(),
			items: this.itemsByTab[this.state.currentTab] ?? [],
		};
	}

	private applyContext(): ApplyContext {
		return {
			questions: this.questions,
			itemsByTab: this.itemsByTab,
		};
	}

	private currentItem(): WrappingSelectItem | undefined {
		const arr = this.itemsByTab[this.state.currentTab] ?? [];
		return this.state.optionIndex < arr.length ? arr[this.state.optionIndex] : undefined;
	}
}
