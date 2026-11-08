import { type ExtensionUIContext, type Theme, transcriptBodyPadding } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { displayText, openTasks, type Task, type TaskState, type TaskStatus, visibleTasks } from "./tasks.ts";
import { statusLabel } from "./tool.ts";

const WIDGET = "todos";
const MAX_ROWS = 14;

const GLYPHS: Record<TaskStatus, string> = { pending: "◇", in_progress: "◈", completed: "✓", deleted: "⊘" };

function taskLine(task: Task, theme: Theme, showId: boolean): string {
	const glyph = theme.fg(task.status === "in_progress" ? "accent" : "muted", GLYPHS[task.status]);
	const id = showId ? `${theme.fg("dim", `#${task.id}`)} ` : "";
	const done = task.status === "completed" || task.status === "deleted";
	const subject = theme.fg(done ? "muted" : "text", displayText(task.subject));
	const form =
		task.status === "in_progress" && task.activeForm ? ` ${theme.fg("muted", `(${displayText(task.activeForm)})`)}` : "";
	return `${glyph} ${id}${done ? theme.strikethrough(subject) : subject}${form}`;
}

function fitTasks(tasks: Task[], rows: number): { shown: Task[]; hidden: Record<"completed" | "open", number> } {
	if (tasks.length <= rows) return { shown: tasks, hidden: { completed: 0, open: 0 } };

	const room = rows - 1;
	const open = tasks.filter((task) => task.status !== "completed");
	if (open.length >= room) {
		return { shown: open.slice(0, room), hidden: { completed: tasks.length - open.length, open: open.length - room } };
	}

	const keptCompleted = new Set(tasks.filter((task) => task.status === "completed").slice(0, room - open.length));
	const shown = tasks.filter((task) => task.status !== "completed" || keptCompleted.has(task));
	return { shown, hidden: { completed: tasks.length - shown.length, open: 0 } };
}

export function renderTodoPanel(state: TaskState, theme: Theme, width: number, expanded: boolean): string[] {
	const tasks = visibleTasks(state);
	if (tasks.length === 0) return [];

	const gutter = transcriptBodyPadding(1, width);
	const line = (text: string) => " ".repeat(gutter) + truncateToWidth(text, width - 2 * gutter, "…");
	const branch = (text: string, last: boolean) => line(`${theme.fg("dim", last ? "╰─" : "├─")} ${text}`);

	const active = openTasks(state).length > 0;
	const done = tasks.filter((task) => task.status === "completed").length;
	const heading = `${theme.fg(active ? "accent" : "muted", active ? "◈" : "◇")} ${theme.fg("muted", `Todos (${done}/${tasks.length})`)}`;

	const { shown, hidden } = fitTasks(tasks, expanded ? tasks.length : MAX_ROWS - 1);
	const more = hidden.completed + hidden.open;
	const rows = shown.map((task, index) => branch(taskLine(task, theme, false), more === 0 && index === shown.length - 1));
	if (more > 0) {
		const parts = [
			hidden.completed > 0 ? `${hidden.completed} completed` : "",
			hidden.open > 0 ? `${hidden.open} open` : "",
		].filter(Boolean);
		rows.push(branch(theme.fg("dim", `+${more} more (${parts.join(", ")})`), true));
	}
	return [line(heading), ...rows, ""];
}

export function notice(text: string, theme: Theme): string {
	return `${theme.fg("accent", "◇")} ${theme.fg("muted", text)}`;
}

export function formatTodoList(state: TaskState, theme: Theme): string {
	const tasks = visibleTasks(state);
	if (tasks.length === 0) return notice("No todos yet. Ask the agent to add some!", theme);

	const groups = (["pending", "in_progress", "completed"] as const).map((status) => ({
		status,
		tasks: tasks.filter((task) => task.status === status),
	}));
	const counts = [
		groups[2]!.tasks.length > 0 ? `${groups[2]!.tasks.length}/${tasks.length} completed` : "",
		groups[1]!.tasks.length > 0 ? `${groups[1]!.tasks.length} in progress` : "",
		groups[0]!.tasks.length > 0 ? `${groups[0]!.tasks.length} pending` : "",
	].filter(Boolean);

	const lines = [notice(counts.join(" · "), theme)];
	for (const group of groups) {
		if (group.tasks.length === 0) continue;
		const title = statusLabel(group.status);
		lines.push(notice(title[0]!.toUpperCase() + title.slice(1), theme));
		group.tasks.forEach((task, index) => {
			const last = index === group.tasks.length - 1;
			lines.push(`${theme.fg("dim", last ? "╰─" : "├─")} ${taskLine(task, theme, true)}`);
		});
	}
	return lines.join("\n");
}

export class TodoWidget {
	private readonly getState: () => TaskState;
	private ui: ExtensionUIContext | undefined;
	private tui: TUI | undefined;
	private shown = false;

	constructor(getState: () => TaskState) {
		this.getState = getState;
	}

	attach(ui: ExtensionUIContext): void {
		this.ui = ui;
		this.tui = undefined;
		this.shown = false;
		this.update();
	}

	detach(): void {
		this.ui = undefined;
		this.tui = undefined;
		this.shown = false;
	}

	update(): void {
		const ui = this.ui;
		if (!ui) return;

		const hasTasks = visibleTasks(this.getState()).length > 0;
		if (!hasTasks) {
			if (this.shown) ui.setWidget(WIDGET, undefined);
			this.shown = false;
			return;
		}
		if (this.shown) {
			this.tui?.requestRender();
			return;
		}

		ui.setWidget(
			WIDGET,
			(tui) => {
				this.tui = tui;
				return {
					render: (width: number) => renderTodoPanel(this.getState(), ui.theme, width, ui.getToolsExpanded()),
					invalidate() {},
				};
			},
			{ placement: "aboveEditor" },
		);
		this.shown = true;
	}
}
