import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

export function showStashBadge(ctx: ExtensionContext, path: string): void {
	ctx.ui.setStatus("stash", existsSync(path) ? ctx.ui.theme.fg("accent", "stash") : undefined);
}

export function toggleStash(ctx: ExtensionContext, path: string): void {
	const draft = ctx.ui.getEditorText();
	const stashed = existsSync(path);

	if (draft.trim()) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, draft);
		ctx.ui.setEditorText("");
		ctx.ui.notify(stashed ? "Stash updated" : "Text stashed", "info");
	} else if (stashed) {
		ctx.ui.setEditorText(readFileSync(path, "utf8"));
		rmSync(path);
		ctx.ui.notify("Stash restored", "info");
	} else {
		ctx.ui.notify("Nothing to stash", "info");
	}

	showStashBadge(ctx, path);
}

export default function (pi: ExtensionAPI): void {
	const path = join(getAgentDir(), "stash.txt");

	pi.on("session_start", async (_event, ctx) => showStashBadge(ctx, path));

	pi.registerShortcut("ctrl+s", {
		description: "Stash the editor text, or restore the stash into an empty editor",
		handler: async (ctx) => toggleStash(ctx, path),
	});
}
