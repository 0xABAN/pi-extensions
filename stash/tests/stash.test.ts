import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { showStashBadge, toggleStash } from "../index.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
	const directory = mkdtempSync(join(tmpdir(), "pi-stash-"));
	directories.push(directory);
	const path = join(directory, "agent", "stash.txt");
	const notices: string[] = [];
	const statuses = new Map<string, string | undefined>();
	let editor = "";
	const ctx = {
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			getEditorText: () => editor,
			setEditorText: (text: string) => {
				editor = text;
			},
			notify: (message: string) => notices.push(message),
			setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
		},
	};
	return {
		path,
		notices,
		statuses,
		ctx: ctx as never,
		get editor() {
			return editor;
		},
		set editor(text: string) {
			editor = text;
		},
	};
}

test("stashes the draft, then restores it into an empty editor", () => {
	const app = setup();
	app.editor = "half-written prompt\nsecond line";

	toggleStash(app.ctx, app.path);
	expect(app.editor).toBe("");
	expect(existsSync(app.path)).toBe(true);
	expect(app.statuses.get("stash")).toBe("stash");

	toggleStash(app.ctx, app.path);
	expect(app.editor).toBe("half-written prompt\nsecond line");
	expect(existsSync(app.path)).toBe(false);
	expect(app.statuses.get("stash")).toBeUndefined();
	expect(app.notices).toEqual(["Text stashed", "Stash restored"]);
});

test("replaces an existing stash and reports an empty editor with nothing stashed", () => {
	const app = setup();

	app.editor = "   ";
	toggleStash(app.ctx, app.path);
	app.editor = "first";
	toggleStash(app.ctx, app.path);
	app.editor = "second";
	toggleStash(app.ctx, app.path);
	toggleStash(app.ctx, app.path);

	expect(app.editor).toBe("second");
	expect(app.notices).toEqual(["Nothing to stash", "Text stashed", "Stash updated", "Stash restored"]);
});

test("shows the badge for a stash left by an earlier session", () => {
	const app = setup();
	app.editor = "kept";
	toggleStash(app.ctx, app.path);
	app.statuses.clear();

	showStashBadge(app.ctx, app.path);

	expect(app.statuses.get("stash")).toBe("stash");
});
