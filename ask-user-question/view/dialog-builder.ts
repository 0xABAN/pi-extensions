import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, CURSOR_MARKER, type Editor, Spacer } from "@earendil-works/pi-tui";
import type { QuestionnaireState } from "../state/state.ts";
import type { QuestionData } from "../tool/types.ts";
import type { PreviewPaneProps } from "./components/preview/preview-pane.ts";
import type { TabBar } from "./components/tab-bar.ts";
import { computeScrollStart, decorateOverflow } from "./scroll-window.ts";
import type { StatefulView } from "./stateful-view.ts";
import type { TabComponents } from "./tab-components.ts";
import { QuestionTabStrategy, SubmitTabStrategy, type TabContentStrategy } from "./tab-content-strategy.ts";

const MIN_SCROLL_ROWS_WITH_PINNED_HEADING = 3;

function renderFitsTerminal(natural: string[], spacerRows: number): string[] {
	return spacerRows > 0 ? [...natural, ...Array<string>(spacerRows).fill("")] : natural;
}

function renderChromeOnly(natural: string[], topFixed: number, bottomFixed: number, termRows: number): string[] {
	const chromeOnly = [...natural.slice(0, topFixed), ...natural.slice(natural.length - bottomFixed)];
	return chromeOnly.length > termRows ? chromeOnly.slice(0, termRows) : chromeOnly;
}

function offsetRange(range: [number, number] | undefined, delta: number): [number, number] | undefined {
	return range && [range[0] + delta, range[1] + delta];
}

export type DialogState = QuestionnaireState;

export interface DialogProps {
	state: DialogState;
	activePreviewPane: StatefulView<PreviewPaneProps>;
}

export interface DialogConfig {
	theme: Theme;
	questions: readonly QuestionData[];
	tabBar: TabBar | undefined;
	notesInput: Editor;
	isMulti: boolean;
	tabsByIndex: ReadonlyArray<TabComponents>;
	submitPicker?: Component;
	getBodyHeight: (width: number) => number;
	getCurrentBodyHeight: (width: number) => number;
	getTerminalRows: () => number;
}

export class DialogView implements StatefulView<DialogProps> {
	private liveProps: DialogProps;
	private readonly config: DialogConfig;
	private readonly questionStrategy: TabContentStrategy;
	private readonly submitStrategy: TabContentStrategy | undefined;
	private readonly maxFooterRowCount: number;

	constructor(config: DialogConfig, initialProps: DialogProps) {
		this.config = config;
		this.liveProps = initialProps;
		this.questionStrategy = new QuestionTabStrategy({
			theme: config.theme,
			questions: config.questions,
			getPreviewPane: () => this.liveProps.activePreviewPane,
			tabsByIndex: config.tabsByIndex,
			notesInput: config.notesInput,
			isMulti: config.isMulti,
			getCurrentBodyHeight: config.getCurrentBodyHeight,
		});
		this.submitStrategy = config.isMulti
			? new SubmitTabStrategy({
					theme: config.theme,
					questions: config.questions,
					submitPicker: config.submitPicker,
					notesInput: config.notesInput,
				})
			: undefined;
		this.maxFooterRowCount = Math.max(this.questionStrategy.footerRowCount, this.submitStrategy?.footerRowCount ?? 0);
	}

	setProps(props: DialogProps): void {
		this.liveProps = props;
	}

	handleInput(_data: string): void {}

	invalidate(): void {}

	render(width: number): string[] {
		const state = this.liveProps.state;
		const onSubmit = this.config.isMulti && state.currentTab === this.config.questions.length;
		const strategy = onSubmit && this.submitStrategy ? this.submitStrategy : this.questionStrategy;

		const headingRowCache = strategy.headingRows(state);
		const headingHeight = headingRowCache.reduce((rows, c) => rows + c.render(width).length, 0);

		const topFixed = 1 + (this.config.isMulti && this.config.tabBar ? 2 : 0) + 1;
		const bottomFixed = 1 + strategy.footerRowCount;
		const termRows = this.config.getTerminalRows();

		this.allotBodyRows(
			onSubmit,
			termRows - topFixed - headingHeight - bottomFixed - this.rowsAroundBody(strategy, width),
		);

		const natural = this.buildContainerFromStrategy(strategy, headingRowCache).render(width);

		const restingMidRows = state.notesVisible ? 0 : this.rowsAroundBody(strategy, width) - 1;
		const spacerRows = Math.max(
			0,
			this.config.getBodyHeight(width) +
				this.maxFooterRowCount -
				strategy.bodyHeight(width, state) -
				strategy.footerRowCount -
				restingMidRows,
		);

		if (natural.length <= termRows) {
			return renderFitsTerminal(natural, Math.min(spacerRows, termRows - natural.length));
		}

		const pinHeading = termRows - topFixed - headingHeight - bottomFixed >= MIN_SCROLL_ROWS_WITH_PINNED_HEADING;
		const top = pinHeading ? topFixed + headingHeight : topFixed;
		const middleRows = natural.length - top - bottomFixed;
		const availableMiddle = Math.max(0, termRows - top - bottomFixed);
		if (availableMiddle === 0) {
			return renderChromeOnly(natural, top, bottomFixed, termRows);
		}

		const windowRows = Math.min(availableMiddle, middleRows);
		const rowsBeforeBody = pinHeading ? 0 : headingHeight;
		const focusedRange = state.notesVisible
			? this.notesFocusRange(natural.slice(top, top + middleRows), strategy, width, windowRows)
			: offsetRange(strategy.focusedItemRowRange(width, state), rowsBeforeBody);
		const scrollStart = computeScrollStart(focusedRange, 0, windowRows, middleRows);
		const scrollableMiddle = natural.slice(top + scrollStart, top + scrollStart + windowRows);
		const focusedInWindow = offsetRange(focusedRange, -scrollStart);
		decorateOverflow(
			scrollableMiddle,
			scrollStart > 0,
			scrollStart + windowRows < middleRows,
			this.config.theme,
			focusedInWindow,
		);

		const result = [...natural.slice(0, top), ...scrollableMiddle, ...natural.slice(natural.length - bottomFixed)];
		return result.length > termRows ? result.slice(0, termRows) : result;
	}

	private rowsAroundBody(strategy: TabContentStrategy, width: number): number {
		return 1 + strategy.midRows(this.liveProps.state).reduce((rows, c) => rows + c.render(width).length, 0);
	}

	private notesFocusRange(
		middle: readonly string[],
		strategy: TabContentStrategy,
		width: number,
		windowRows: number,
	): [number, number] {
		const notesRows = this.rowsAroundBody(strategy, width) - 1;
		const notesStart = middle.length - notesRows;
		if (notesRows <= windowRows) return [notesStart, middle.length];
		const cursorRow = middle.findIndex((line, i) => i >= notesStart && line.includes(CURSOR_MARKER));
		return cursorRow === -1 ? [notesStart, middle.length] : [cursorRow, cursorRow + 1];
	}

	private allotBodyRows(onSubmit: boolean, bodyRows: number): void {
		const active =
			onSubmit || bodyRows < MIN_SCROLL_ROWS_WITH_PINNED_HEADING ? undefined : this.liveProps.activePreviewPane;
		for (const tab of this.config.tabsByIndex) {
			tab.preview?.setRowAllowance?.(tab.preview === active ? bodyRows : undefined);
		}
	}

	private buildContainerFromStrategy(strategy: TabContentStrategy, headingRowCache: Component[]): Container {
		const { theme, isMulti, tabBar } = this.config;
		const state = this.liveProps.state;
		const container = new Container();
		const border = () => new DynamicBorder((s) => theme.fg("accent", s));

		container.addChild(border());
		if (isMulti && tabBar) container.addChild(tabBar);
		container.addChild(new Spacer(1));

		for (const c of headingRowCache) container.addChild(c);
		container.addChild(strategy.bodyComponent(state));
		container.addChild(new Spacer(1));
		for (const c of strategy.midRows(state)) container.addChild(c);

		container.addChild(border());
		for (const c of strategy.footerRows(state)) container.addChild(c);

		return container;
	}
}
