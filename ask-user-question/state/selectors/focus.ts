import type { ActiveView } from "../../view/stateful-view.ts";

export function selectActiveView(
	state: { notesVisible: boolean; currentTab: number },
	totalQuestions: number,
): ActiveView {
	if (state.notesVisible) return "notes";
	if (state.currentTab === totalQuestions) return "submit";
	return "options";
}
