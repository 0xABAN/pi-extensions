import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { StatefulView } from "../stateful-view.ts";

const ACTIVE_POINTER = "❯ ";
const INACTIVE_POINTER = "  ";
const NUMBER_SEPARATOR = ". ";

export const SUBMIT_LABEL = "Submit answers";
export const CANCEL_LABEL = "Cancel";

export interface SubmitPickerProps {
	rows: ReadonlyArray<{ active: boolean }>;
}

export class SubmitPicker implements StatefulView<SubmitPickerProps> {
	private props: SubmitPickerProps;

	constructor(private readonly theme: Theme) {
		this.props = { rows: [{ active: false }, { active: false }] };
	}

	setProps(props: SubmitPickerProps): void {
		this.props = props;
	}

	handleInput(_data: string): void {}

	invalidate(): void {}

	naturalHeight(_width: number): number {
		return 2;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (let i = 0; i < 2; i++) {
			const text = i === 0 ? SUBMIT_LABEL : CANCEL_LABEL;
			const active = this.props.rows[i]?.active ?? false;
			const pointer = active ? ACTIVE_POINTER : INACTIVE_POINTER;
			const number = `${i + 1}${NUMBER_SEPARATOR}`;
			const label = active ? this.theme.fg("accent", this.theme.bold(text)) : this.theme.fg("text", text);
			lines.push(truncateToWidth(`${pointer}${number}${label}`, width, ""));
		}
		return lines;
	}
}
