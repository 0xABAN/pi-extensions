import type { StatefulView } from "../stateful-view.ts";
import { WrappingSelect, type WrappingSelectItem, type WrappingSelectTheme } from "./wrapping-select.ts";

export const MAX_VISIBLE_OPTIONS = 10;

export interface OptionListViewConfig {
	items: readonly WrappingSelectItem[];
	theme: WrappingSelectTheme;
}

export interface OptionListViewProps {
	selectedIndex: number;
	focused: boolean;
	inputBuffer: string;
	inputCursorOffset?: number;
	confirmed?: { index: number; labelOverride?: string };
}

export class OptionListView implements StatefulView<OptionListViewProps> {
	private readonly select: WrappingSelect;

	constructor(config: OptionListViewConfig) {
		this.select = new WrappingSelect(config.items, Math.min(config.items.length, MAX_VISIBLE_OPTIONS), config.theme, {
			numberStartOffset: 0,
			totalItemsForNumbering: config.items.length,
		});
	}

	setProps(props: OptionListViewProps): void {
		this.select.setSelectedIndex(props.selectedIndex);
		this.select.setFocused(props.focused);
		this.select.setConfirmedIndex(props.confirmed?.index, props.confirmed?.labelOverride);
		this.select.setInputBuffer(props.inputBuffer);
		this.select.setInputCursorOffset(props.inputCursorOffset);
	}

	handleInput(_data: string): void {}

	invalidate(): void {
		this.select.invalidate();
	}

	render(width: number): string[] {
		return this.select.render(width);
	}

	focusedItemRowRange(width: number): [number, number] {
		return this.select.focusedItemRowRange(width);
	}
}
