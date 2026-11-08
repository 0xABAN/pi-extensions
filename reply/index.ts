import type { ExtensionAPI, ExtensionCommandContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	decodeKittyPrintable,
	fuzzyFilter,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

export interface QuoteCandidate {
	id: string;
	role: "assistant" | "user";
	text: string;
	timestamp: number;
	searchText: string;
}

const MAX_QUOTE_CHARS = 6_000;
const MAX_CANDIDATES = 200;
const MAX_VISIBLE_ITEMS = 8;

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n\n");
}

export function collectCandidates(branch: readonly SessionEntry[]): QuoteCandidate[] {
	const candidates: QuoteCandidate[] = [];
	for (let index = branch.length - 1; index >= 0 && candidates.length < MAX_CANDIDATES; index--) {
		const entry = branch[index]!;
		if (entry.type !== "message") continue;
		const { message } = entry;
		if (message.role !== "assistant" && message.role !== "user") continue;

		const text = contentText(message.content).trim();
		if (!text) continue;

		candidates.push({
			id: entry.id,
			role: message.role,
			text,
			timestamp: Date.parse(entry.timestamp),
			searchText: `${entry.id} ${message.role} ${text}`.slice(0, 1_000).toLowerCase(),
		});
	}
	return candidates;
}

export function formatQuote(candidate: QuoteCandidate): string {
	const truncated = candidate.text.length > MAX_QUOTE_CHARS;
	const quoted = (truncated ? candidate.text.slice(0, MAX_QUOTE_CHARS).trimEnd() : candidate.text)
		.split(/\r?\n/)
		.map((line) => (line ? `> ${line}` : ">"))
		.join("\n");
	const lines = [`Quoted previous ${candidate.role} message ${candidate.id} for reference only:`, "", quoted];
	if (truncated) lines.push("", `> [Quote truncated from ${candidate.text.length.toLocaleString()} characters.]`);
	lines.push("", "My reply:", "");
	return lines.join("\n");
}

function excerpt(text: string, maxChars: number): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length <= maxChars ? compact : `${compact.slice(0, maxChars - 1).trimEnd()}…`;
}

function formatTime(timestamp: number): string {
	const date = new Date(timestamp);
	const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString()} ${time}`;
}

function printable(data: string): string | undefined {
	const kitty = decodeKittyPrintable(data);
	if (kitty !== undefined) return kitty;
	return [...data].some((char) => {
		const code = char.charCodeAt(0);
		return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
	})
		? undefined
		: data;
}

export class QuotePicker implements Component {
	private query = "";
	private selected = 0;
	private readonly candidates: QuoteCandidate[];
	private readonly theme: Theme;
	private readonly done: (candidate: QuoteCandidate | undefined) => void;

	constructor(candidates: QuoteCandidate[], theme: Theme, done: (candidate: QuoteCandidate | undefined) => void) {
		this.candidates = candidates;
		this.theme = theme;
		this.done = done;
	}

	private filtered(): QuoteCandidate[] {
		const query = this.query.trim();
		return query ? fuzzyFilter(this.candidates, query, (candidate) => candidate.searchText) : this.candidates;
	}

	handleInput(data: string): void {
		const filtered = this.filtered();
		if (matchesKey(data, Key.up)) {
			this.selected = filtered.length === 0 ? 0 : (this.selected - 1 + filtered.length) % filtered.length;
		} else if (matchesKey(data, Key.down)) {
			this.selected = filtered.length === 0 ? 0 : (this.selected + 1) % filtered.length;
		} else if (matchesKey(data, Key.enter)) {
			const candidate = filtered[this.selected];
			if (candidate) this.done(candidate);
		} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done(undefined);
		} else if (matchesKey(data, Key.backspace)) {
			this.query = [...this.query].slice(0, -1).join("");
			this.selected = 0;
		} else if (matchesKey(data, Key.ctrl("u"))) {
			this.query = "";
			this.selected = 0;
		} else {
			const text = printable(data);
			if (!text) return;
			this.query += text;
			this.selected = 0;
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const inner = Math.max(0, width - 2);
		const filtered = this.filtered();
		this.selected = Math.min(this.selected, Math.max(0, filtered.length - 1));

		const lines = [this.top(inner), this.empty(inner), this.row(inner, this.searchLine()), this.empty(inner)];
		lines.push(this.divider(inner), this.empty(inner));
		if (filtered.length === 0) {
			lines.push(this.row(inner, this.theme.fg("warning", this.theme.italic("No matching messages"))));
		} else {
			const start = Math.max(
				0,
				Math.min(this.selected - Math.floor(MAX_VISIBLE_ITEMS / 2), filtered.length - MAX_VISIBLE_ITEMS),
			);
			filtered.slice(start, start + MAX_VISIBLE_ITEMS).forEach((candidate, offset) => {
				lines.push(this.row(inner, this.candidateLine(inner, candidate, start + offset === this.selected)));
			});
			if (filtered.length > MAX_VISIBLE_ITEMS) lines.push(this.empty(inner), this.row(inner, this.scrollLine(filtered.length)));
		}
		lines.push(this.empty(inner), this.divider(inner), this.empty(inner), this.row(inner, this.help()), this.bottom(inner));
		return lines;
	}

	private searchLine(): string {
		const cursor = this.theme.fg("accent", "│");
		const placeholder = this.theme.fg("dim", this.theme.italic("type to filter messages..."));
		return `${this.theme.fg("dim", "◎")}  ${this.query ? `${this.query}${cursor}` : `${cursor}${placeholder}`}`;
	}

	private candidateLine(inner: number, candidate: QuoteCandidate, selected: boolean): string {
		const marker = selected ? this.theme.fg("accent", "▸") : this.theme.fg("borderMuted", "·");
		const role = this.theme.fg(candidate.role === "assistant" ? "accent" : "success", candidate.role);
		const meta = this.theme.fg("dim", `${candidate.id}  ${formatTime(candidate.timestamp)}`);
		const head = `${marker} ${selected ? this.theme.bold(role) : role} ${meta}`;
		const room = inner - visibleWidth(head) - 8;
		const preview = room > 18 ? `  ${this.theme.fg("borderMuted", "—")}  ${this.theme.fg("muted", excerpt(candidate.text, room))}` : "";
		return selected ? this.theme.fg("accent", head + preview) : head + preview;
	}

	private scrollLine(total: number): string {
		const filled = Math.max(1, Math.round(((this.selected + 1) / total) * 10));
		const dots = Array.from({ length: 10 }, (_, index) =>
			index < filled ? this.theme.fg("accent", "●") : this.theme.fg("dim", "○"),
		).join(" ");
		return `${dots}  ${this.theme.fg("dim", `${this.selected + 1}/${total}`)}`;
	}

	private help(): string {
		const key = (text: string) => this.theme.italic(text);
		return this.theme.fg("dim", `${key("↑↓")} navigate  ${key("enter")} quote  ${key("esc")} cancel  ${key("⌫")} edit`);
	}

	private border(text: string): string {
		return this.theme.fg("borderMuted", text);
	}

	private top(inner: number): string {
		const title = " Reply ";
		const rule = Math.max(0, inner - visibleWidth(title));
		const left = Math.floor(rule / 2);
		return this.border(`╭${"─".repeat(left)}`) + this.theme.fg("dim", title) + this.border(`${"─".repeat(rule - left)}╮`);
	}

	private divider(inner: number): string {
		return this.border(`├${"─".repeat(inner)}┤`);
	}

	private bottom(inner: number): string {
		return this.border(`╰${"─".repeat(inner)}╯`);
	}

	private empty(inner: number): string {
		return this.border("│") + " ".repeat(inner) + this.border("│");
	}

	private row(inner: number, content: string): string {
		return this.border("│") + truncateToWidth(` ${content}`, inner, "…", true) + this.border("│");
	}
}

function insertQuote(ctx: ExtensionCommandContext, candidate: QuoteCandidate): void {
	ctx.ui.setEditorText(`${formatQuote(candidate)}${ctx.ui.getEditorText()}`);
	ctx.ui.notify(`Inserted quote from ${candidate.role} message ${candidate.id}.`, "info");
}

export async function reply(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const candidates = collectCandidates(ctx.sessionManager.getBranch());
	if (candidates.length === 0) {
		ctx.ui.notify("No user or assistant messages are available to quote.", "warning");
		return;
	}

	const query = args.trim().replace(/^#/, "").toLowerCase();
	if (query) {
		const matches = candidates.filter((candidate) => candidate.id.toLowerCase().startsWith(query));
		if (matches.length === 1) {
			insertQuote(ctx, matches[0]!);
			return;
		}
		ctx.ui.notify(
			matches.length > 1
				? `Message id "${query}" matches ${matches.length} messages. Type more of the id.`
				: `No quotable message matches id "${query}".`,
			"warning",
		);
		return;
	}

	const candidate = await ctx.ui.custom<QuoteCandidate | undefined>(
		(tui, theme, _keybindings, done) => {
			const picker = new QuotePicker(candidates, theme, done);
			return {
				render: (width) => picker.render(width),
				invalidate: () => picker.invalidate(),
				handleInput: (data) => {
					picker.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{ overlay: true, overlayOptions: { width: "85%", minWidth: 72, maxHeight: "80%" } },
	);
	if (candidate) insertQuote(ctx, candidate);
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("reply", {
		description: "Quote a previous user or assistant message into the editor",
		handler: reply,
	});
}
