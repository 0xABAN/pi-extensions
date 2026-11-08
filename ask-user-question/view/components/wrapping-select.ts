import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderInlineInputRow } from "./inline-input.ts";

export type WrappingSelectItem =
	| { kind: "option"; label: string; description?: string }
	| { kind: "other"; label: string; description?: string }
	| { kind: "next"; label: string; description?: string };

export interface WrappingSelectTheme {
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
}

export interface WrappingSelectOptions {
	numberStartOffset?: number;
	totalItemsForNumbering?: number;
}

export class WrappingSelect implements Component {
	private static readonly ACTIVE_POINTER = "❯ ";
	private static readonly INACTIVE_POINTER = "  ";
	private static readonly NUMBER_SEPARATOR = ". ";
	private static readonly CONFIRMED_MARK = " ✔";
	private static readonly MIN_CONTENT_WIDTH = 1;

	private readonly items: readonly WrappingSelectItem[];
	private readonly maxVisible: number;
	private readonly theme: WrappingSelectTheme;
	private numberStartOffset: number;
	private totalItemsForNumbering: number;

	private selectedIndex = 0;
	private focused = true;
	private inputBuffer = "";
	private inputCursorOffset: number | undefined = undefined;
	private confirmedIndex: number | undefined = undefined;
	private confirmedLabelOverride: string | undefined = undefined;

	constructor(
		items: readonly WrappingSelectItem[],
		maxVisible: number,
		theme: WrappingSelectTheme,
		options: WrappingSelectOptions = {},
	) {
		this.items = items;
		this.maxVisible = Math.max(1, maxVisible);
		this.theme = theme;
		this.numberStartOffset = options.numberStartOffset ?? 0;
		this.totalItemsForNumbering = options.totalItemsForNumbering ?? items.length;
	}

	setNumbering(numberStartOffset: number, totalItemsForNumbering: number): void {
		this.numberStartOffset = numberStartOffset;
		this.totalItemsForNumbering = Math.max(1, totalItemsForNumbering);
	}

	setSelectedIndex(index: number): void {
		this.selectedIndex = Math.max(0, Math.min(index, this.items.length - 1));
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
	}

	setConfirmedIndex(index: number | undefined, labelOverride?: string): void {
		if (index === undefined) {
			this.confirmedIndex = undefined;
			this.confirmedLabelOverride = undefined;
			return;
		}
		this.confirmedIndex = Math.max(0, Math.min(index, this.items.length - 1));
		this.confirmedLabelOverride = labelOverride;
	}

	setInputBuffer(text: string): void {
		this.inputBuffer = text;
	}

	setInputCursorOffset(offset: number | undefined): void {
		this.inputCursorOffset = offset;
	}

	handleInput(_data: string): void {}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.items.length === 0) return [];

		const { startIndex, endIndex } = this.computeVisibleWindow();
		const numberWidth = String(Math.max(1, this.totalItemsForNumbering)).length;
		const lines: string[] = [];

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.items[i];
			if (!item) continue;
			const isActive = i === this.selectedIndex && this.focused;
			lines.push(...this.renderItem(item, i, isActive, width, numberWidth));
		}

		if (this.hasItemsOutsideWindow(startIndex, endIndex)) {
			lines.push(this.theme.scrollInfo(`  (${this.selectedIndex + 1}/${this.items.length})`));
		}
		return lines;
	}

	focusedItemRowRange(width: number): [number, number] {
		if (this.items.length === 0) return [0, 0];
		const { startIndex, endIndex } = this.computeVisibleWindow();
		const numberWidth = String(Math.max(1, this.totalItemsForNumbering)).length;
		let row = 0;
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.items[i];
			if (!item) continue;
			const isActive = i === this.selectedIndex && this.focused;
			const itemRowCount = this.computeItemRowCount(item, i, isActive, width, numberWidth);
			if (i === this.selectedIndex) {
				return [row, row + itemRowCount];
			}
			row += itemRowCount;
		}
		return [0, 1];
	}

	private computeItemRowCount(
		item: WrappingSelectItem,
		index: number,
		isActive: boolean,
		width: number,
		numberWidth: number,
	): number {
		return this.renderItem(item, index, isActive, width, numberWidth).length;
	}

	private computeVisibleWindow(): { startIndex: number; endIndex: number } {
		const half = Math.floor(this.maxVisible / 2);
		const startIndex = Math.max(0, Math.min(this.selectedIndex - half, this.items.length - this.maxVisible));
		const endIndex = Math.min(startIndex + this.maxVisible, this.items.length);
		return { startIndex, endIndex };
	}

	private hasItemsOutsideWindow(startIndex: number, endIndex: number): boolean {
		return startIndex > 0 || endIndex < this.items.length;
	}

	private renderItem(
		item: WrappingSelectItem,
		index: number,
		isActive: boolean,
		width: number,
		numberWidth: number,
	): string[] {
		const rowPrefix = this.buildRowPrefix(index, isActive, numberWidth);
		const continuationPrefix = " ".repeat(visibleWidth(rowPrefix));
		const contentWidth = Math.max(WrappingSelect.MIN_CONTENT_WIDTH, width - visibleWidth(rowPrefix));

		if (this.shouldRenderAsInlineInput(item, isActive)) {
			return this.renderInlineInputRow(rowPrefix, continuationPrefix, contentWidth);
		}

		const { label, isConfirmed } = this.deriveConfirmedState(item, index);
		const applySelectedStyle = isActive || isConfirmed;

		return [
			...this.renderLabelBlock(label, rowPrefix, continuationPrefix, contentWidth, applySelectedStyle),
			...this.renderDescriptionBlock(item.description, continuationPrefix, contentWidth),
		];
	}

	private deriveConfirmedState(item: WrappingSelectItem, index: number): { label: string; isConfirmed: boolean } {
		const customDraft = item.kind === "other" ? this.inputBuffer : undefined;
		const customDraftDiffersFromConfirmed =
			item.kind === "other" &&
			customDraft !== "" &&
			index === this.confirmedIndex &&
			customDraft !== (this.confirmedLabelOverride ?? "");
		const isConfirmed = index === this.confirmedIndex && !customDraftDiffersFromConfirmed;
		const baseLabel = customDraft ? customDraft : item.label;
		const label = isConfirmed
			? `${this.confirmedLabelOverride ?? baseLabel}${WrappingSelect.CONFIRMED_MARK}`
			: baseLabel;
		return { label, isConfirmed };
	}

	private buildRowPrefix(index: number, isActive: boolean, numberWidth: number): string {
		const pointer = isActive ? WrappingSelect.ACTIVE_POINTER : WrappingSelect.INACTIVE_POINTER;
		const displayNumber = this.numberStartOffset + index + 1;
		const paddedNumber = String(displayNumber).padStart(numberWidth, " ");
		return `${pointer}${paddedNumber}${WrappingSelect.NUMBER_SEPARATOR}`;
	}

	private shouldRenderAsInlineInput(item: WrappingSelectItem, isActive: boolean): boolean {
		return item.kind === "other" && isActive;
	}

	private renderInlineInputRow(rowPrefix: string, continuationPrefix: string, contentWidth: number): string[] {
		return renderInlineInputRow({
			buffer: this.inputBuffer,
			cursorOffset: this.inputCursorOffset,
			rowPrefix,
			continuationPrefix,
			contentWidth,
			selectedText: this.theme.selectedText,
		});
	}

	private renderLabelBlock(
		label: string,
		rowPrefix: string,
		continuationPrefix: string,
		contentWidth: number,
		applySelectedStyle: boolean,
	): string[] {
		const wrapped = wrapTextWithAnsi(label, contentWidth);
		return wrapped.map((segment, index) => {
			const prefix = index === 0 ? rowPrefix : continuationPrefix;
			const line = `${prefix}${segment}`;
			return applySelectedStyle ? this.theme.selectedText(line) : line;
		});
	}

	private renderDescriptionBlock(
		description: string | undefined,
		continuationPrefix: string,
		contentWidth: number,
	): string[] {
		if (!description) return [];
		const wrapped = wrapTextWithAnsi(description, contentWidth);
		return wrapped.map((segment) => `${continuationPrefix}${this.theme.description(segment)}`);
	}
}
