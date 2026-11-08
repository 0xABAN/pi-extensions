import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { StatefulView } from "../stateful-view.ts";

export interface TabBarProps {
	tabs: ReadonlyArray<{ label: string; answered: boolean; active: boolean }>;
	submit: { active: boolean; allAnswered: boolean };
}

export class TabBar implements StatefulView<TabBarProps> {
	private readonly theme: Theme;
	private props: TabBarProps;

	constructor(theme: Theme) {
		this.theme = theme;
		this.props = { tabs: [], submit: { active: false, allAnswered: false } };
	}

	setProps(props: TabBarProps): void {
		this.props = props;
	}

	handleInput(_data: string): void {}

	invalidate(): void {}

	render(width: number): string[] {
		const pieces: string[] = [" ← "];

		for (const tab of this.props.tabs) {
			const box = tab.answered ? "■" : "□";
			const rawSeg = ` ${box} ${tab.label} `;
			const styled = tab.active
				? this.theme.bg("selectedBg", this.theme.fg("text", rawSeg))
				: this.theme.fg(tab.answered ? "success" : "muted", rawSeg);
			pieces.push(styled);
			pieces.push(" ");
		}

		const submitText = " ✓ Submit ";
		const submitStyled = this.props.submit.active
			? this.theme.bg("selectedBg", this.theme.fg("text", submitText))
			: this.theme.fg(this.props.submit.allAnswered ? "success" : "dim", submitText);
		pieces.push(submitStyled);
		pieces.push(" →");

		const tabLine = truncateToWidth(pieces.join(""), width, "");
		return [tabLine, ""];
	}
}
