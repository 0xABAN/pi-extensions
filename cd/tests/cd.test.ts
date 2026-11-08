import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getCdArgumentCompletions, resolveCdTarget, runCdCommand } from "../index.ts";

const directories: string[] = [];

function tempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-cd-"));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("resolves relative, home and escaped paths, and rejects missing directories and files", () => {
	const root = tempDir();
	const home = tempDir();
	mkdirSync(join(root, "child"));
	mkdirSync(join(root, "My Folder"));
	mkdirSync(join(home, "project"));
	writeFileSync(join(root, "file.txt"), "");

	expect(resolveCdTarget("", root, home)).toBeNull();
	expect(resolveCdTarget("child", root, home)).toEqual({ path: join(root, "child") });
	expect(resolveCdTarget("My\\ Folder", root, home)).toEqual({ path: join(root, "My Folder") });
	expect(resolveCdTarget("'My Folder'", root, home)).toEqual({ path: join(root, "My Folder") });
	expect(resolveCdTarget("~/project", root, home)).toEqual({ path: join(home, "project") });
	expect(resolveCdTarget("missing", root, home)).toEqual({ error: `Directory does not exist: ${join(root, "missing")}` });
	expect(resolveCdTarget("file.txt", root, home)).toEqual({ error: `Not a directory: ${join(root, "file.txt")}` });
});

test("completes directories with escaped values and offers the parent and home", () => {
	const root = tempDir();
	const home = tempDir();
	mkdirSync(join(root, "child"));
	mkdirSync(join(root, "My Folder"));
	mkdirSync(join(home, "project"));
	writeFileSync(join(root, "file.txt"), "");

	const values = getCdArgumentCompletions("", root, home).map((item) => [item.value, item.label]);

	expect(values).toContainEqual(["../", "../"]);
	expect(values).toContainEqual(["~/", "~/"]);
	expect(values).toContainEqual(["child/", "child/"]);
	expect(values).toContainEqual(["My\\ Folder/", "My Folder/"]);
	expect(values.map(([, label]) => label)).not.toContain("file.txt/");
	expect(getCdArgumentCompletions("~/p", root, home).map((item) => item.value)).toEqual(["~/project/"]);
	expect(getCdArgumentCompletions("nowhere/x", root, home)).toEqual([]);
});

test("removes the forked session when the switch is cancelled", async () => {
	const root = tempDir();
	const agentDir = tempDir();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	mkdirSync(join(root, "target"));
	const session = SessionManager.create(root, join(root, "sessions"));
	session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });

	let switchedTo: string | undefined;
	const notices: string[] = [];
	const ctx = {
		cwd: root,
		sessionManager: session,
		ui: { notify: (message: string) => notices.push(message) },
		waitForIdle: async () => {},
		switchSession: async (path: string) => {
			switchedTo = path;
			return { cancelled: true };
		},
	};

	try {
		await runCdCommand("target", ctx as never);
	} finally {
		process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}

	expect(switchedTo).toStartWith(agentDir);
	expect(existsSync(switchedTo!)).toBe(false);
	expect(notices).toEqual(["Directory change cancelled"]);
});
