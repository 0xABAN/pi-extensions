import type { Editor } from "@earendil-works/pi-tui";
import type { BindingContext, PerTabBindingContext } from "../state/selectors/contract.ts";
import { selectActivePreviewPaneIndex } from "../state/selectors/derivations.ts";
import { selectActiveView } from "../state/selectors/focus.ts";
import type { QuestionnaireState } from "../state/state.ts";
import type { QuestionData } from "../tool/types.ts";
import type { BoundGlobalBinding, BoundPerTabBinding } from "./component-binding.ts";
import type { WrappingSelectItem } from "./components/wrapping-select.ts";
import type { TabComponents } from "./tab-components.ts";

interface Invalidatable {
	invalidate(): void;
}

function getInputCursorOffset(input: Editor): number {
	const lines = input.getLines();
	const cursor = input.getCursor();
	let offset = cursor.col;
	for (let i = 0; i < cursor.line; i++) offset += (lines[i]?.length ?? 0) + 1;
	return offset;
}

export interface QuestionnairePropsAdapterConfig {
	tui: { requestRender(): void };
	questions: readonly QuestionData[];
	itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
	tabsByIndex: ReadonlyArray<TabComponents>;
	inlineInput: Editor;
	globalBindings: ReadonlyArray<BoundGlobalBinding>;
	perTabBindings: ReadonlyArray<BoundPerTabBinding>;
	extraInvalidatables?: ReadonlyArray<Invalidatable>;
}

export class QuestionnairePropsAdapter {
	private readonly tui: QuestionnairePropsAdapterConfig["tui"];
	private readonly questions: readonly QuestionData[];
	private readonly itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
	private readonly tabsByIndex: ReadonlyArray<TabComponents>;
	private readonly inlineInput: Editor;
	private readonly globalBindings: ReadonlyArray<BoundGlobalBinding>;
	private readonly perTabBindings: ReadonlyArray<BoundPerTabBinding>;
	private readonly extraInvalidatables: ReadonlyArray<Invalidatable>;

	constructor(config: QuestionnairePropsAdapterConfig) {
		this.tui = config.tui;
		this.questions = config.questions;
		this.itemsByTab = config.itemsByTab;
		this.tabsByIndex = config.tabsByIndex;
		this.inlineInput = config.inlineInput;
		this.globalBindings = config.globalBindings;
		this.perTabBindings = config.perTabBindings;
		this.extraInvalidatables = config.extraInvalidatables ?? [];
	}

	apply(state: QuestionnaireState): void {
		const totalQuestions = this.questions.length;
		const activeView = selectActiveView(state, totalQuestions);
		const paneIndex = selectActivePreviewPaneIndex(state.currentTab, totalQuestions);
		const activePreviewPane = this.tabsByIndex[paneIndex]?.preview ?? this.tabsByIndex[0]!.preview;

		const ctx: BindingContext = {
			questions: this.questions,
			itemsByTab: this.itemsByTab,
			totalQuestions,
			activeView,
			inputBuffer: this.inlineInput.getText(),
			inputCursorOffset: getInputCursorOffset(this.inlineInput),
			activePreviewPane,
		};

		for (const binding of this.globalBindings) {
			binding.apply(state, ctx);
		}

		for (let i = 0; i < this.tabsByIndex.length; i++) {
			const tab = this.tabsByIndex[i]!;
			const tabCtx: PerTabBindingContext = { ...ctx, tab, i };
			for (const binding of this.perTabBindings) {
				binding.apply(state, tabCtx);
			}
		}

		this.tui.requestRender();
	}

	invalidate(): void {
		for (const b of this.globalBindings) b.invalidate();
		for (const tab of this.tabsByIndex) {
			tab.optionList.invalidate();
			tab.preview.invalidate();
			tab.multiSelect?.invalidate();
		}
		for (const x of this.extraInvalidatables) x.invalidate();
	}
}
