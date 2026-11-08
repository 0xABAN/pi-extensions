import type { Component, TUI } from "@earendil-works/pi-tui";
import { Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { SessionInfo } from "../types.ts";
import { herdrLocationText, middleTruncate, shortSessionId } from "./session-list.ts";

const PICKER_WIDTH = 88;
const MAX_BODY_LINES = 24;
const CONTEXT_WARNING_PCT = 80;

export type HandoverPickerTarget =
  | { kind: "local"; session: SessionInfo }
  | { kind: "project" };

export interface HandoverPickerResult {
  target: HandoverPickerTarget;
  goal?: string;
}

export interface HandoverPickerOptions {
  currentSession: SessionInfo;
  sessions: SessionInfo[];
  preselectSessionId?: string;
}

type Item =
  | { kind: "local"; session: SessionInfo }
  | { kind: "project" };

export class HandoverPicker implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly done: (result: HandoverPickerResult | undefined) => void;
  private readonly localSessions: SessionInfo[];
  private selectedIndex = 0;
  private focus: "list" | "task" = "list";
  private readonly taskInput = new Input();

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    options: HandoverPickerOptions,
    done: (result: HandoverPickerResult | undefined) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    this.localSessions = options.sessions
      .filter((session) => session.id !== options.currentSession.id)
      .sort((a, b) => b.lastActivity - a.lastActivity);
    const preselected = this.localSessions.findIndex((session) => session.id === options.preselectSessionId);
    if (preselected >= 0) {
      this.selectedIndex = preselected;
      this.focus = "task";
    }
  }

  private items(): Item[] {
    const items: Item[] = this.localSessions.map((session) => ({ kind: "local", session }));
    items.push({ kind: "project" });
    return items;
  }

  private close(result: HandoverPickerResult | undefined): void {
    this.done(result);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close(undefined);
      return;
    }
    if (this.keybindings.matches(data, "tui.input.tab")) {
      this.focus = this.focus === "list" ? "task" : "list";
      this.tui.requestRender();
      return;
    }
    const items = this.items();
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.selectedIndex = this.selectedIndex === 0 ? items.length - 1 : this.selectedIndex - 1;
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.selectedIndex = this.selectedIndex >= items.length - 1 ? 0 : this.selectedIndex + 1;
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const item = items[this.selectedIndex];
      if (item) this.close({ target: item, goal: this.taskInput.getValue().trim() || undefined });
      return;
    }
    if (this.focus !== "task") return;
    this.taskInput.handleInput(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, Math.min(width, PICKER_WIDTH));
    if (innerWidth === 1) {
      return [this.theme.fg("accent", "│")];
    }

    const contentWidth = Math.max(0, innerWidth - 2);
    const border = (text: string) => this.theme.fg("accent", text);
    const separator = border(`├${"─".repeat(contentWidth)}┤`);
    const row = (text = "") => {
      const clipped = truncateToWidth(text, contentWidth, "", true);
      return `${border("│")}${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))}${border("│")}`;
    };
    const dim = (text: string) => this.theme.fg("dim", text);
    const pathWidth = Math.max(8, contentWidth - 4);

    const items = this.items();
    const itemIndex = new Map<Item, number>(items.map((item, index) => [item, index]));
    const body: string[] = [];
    let selectedStart = 0;
    let selectedEnd = 0;
    const pushItem = (item: Item, title: string, details: string[] = [], suffix = "") => {
      const selected = itemIndex.get(item) === this.selectedIndex;
      if (selected) selectedStart = body.length;
      const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
      body.push(row(`${prefix}${selected ? this.theme.fg("accent", title) : title}${suffix}`), ...details.map((line) => row(`  ${dim(line)}`)));
      if (selected) selectedEnd = body.length;
    };

    for (const item of items) {
      if (item.kind !== "local") continue;
      const session = item.session;
      const status = session.status
        ? ` · ${session.status.split(" · ")[0] === "idle" ? dim(session.status) : this.theme.fg("warning", session.status)}`
        : "";
      const pct = typeof session.contextPct === "number"
        ? ` · ${session.contextPct >= CONTEXT_WARNING_PCT ? this.theme.fg("warning", `${session.contextPct}% ctx`) : dim(`${session.contextPct}% ctx`)}`
        : "";
      const location = herdrLocationText(session);
      pushItem(
        item,
        `${session.name || "Unnamed session"} (${shortSessionId(session.id)})`,
        [`${middleTruncate(session.cwd, pathWidth)} • ${session.model}`, ...(location ? [location] : [])],
        `${status}${pct}`,
      );
    }
    pushItem(items.find((item) => item.kind === "project")!, "+ New session in a project path…");


    let visible = body;
    if (body.length > MAX_BODY_LINES) {
      const selectedLength = selectedEnd - selectedStart;
      const start = Math.max(0, Math.min(
        selectedStart - Math.floor((MAX_BODY_LINES - 1 - selectedLength) / 2),
        body.length - (MAX_BODY_LINES - 1),
      ));
      visible = [...body.slice(start, start + MAX_BODY_LINES - 1), row(dim(` ${this.selectedIndex + 1}/${items.length}`))];
    }

    const taskLabel = " Next task (optional): ";
    const taskLine = this.focus === "task"
      ? `${taskLabel}${this.taskInput.render(Math.max(1, contentWidth - visibleWidth(taskLabel)))[0] ?? ""}`
      : dim(`${taskLabel}${this.taskInput.getValue()}`);

    const keys = (id: string) => this.keybindings.getKeys(id as Parameters<KeybindingsManager["getKeys"]>[0]).join("/");
    const footer = `${keys("tui.select.confirm")}: Hand over • ${keys("tui.input.tab")}: ${this.focus === "list" ? "Next task" : "List"} • ${keys("tui.select.cancel")}: Close`;

    return [
      border(`╭${"─".repeat(contentWidth)}╮`),
      row(this.theme.bold(" Hand over to")),
      separator,
      ...visible,
      separator,
      row(taskLine),
      separator,
      row(dim(` ${footer}`)),
      border(`╰${"─".repeat(contentWidth)}╯`),
    ];
  }
}
