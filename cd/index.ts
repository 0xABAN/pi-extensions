import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

function unescapePath(value: string): string {
	const trimmed = value.trim();
	const quoted = trimmed.length >= 2 && /^(["']).*\1$/.test(trimmed);
	return (quoted ? trimmed.slice(1, -1) : trimmed).replace(/\\(.)/g, "$1");
}

function expandHome(value: string, home: string): string {
	if (value === "~") return home;
	return value.startsWith("~/") ? join(home, value.slice(2)) : value;
}

function escapeCompletion(value: string): string {
	return value.replace(/([\\\s"'`$&|;<>()[\]{}?!*])/g, "\\$1");
}

function isDirectory(path: string): boolean {
	return existsSync(path) && statSync(path).isDirectory();
}

export function resolveCdTarget(
	args: string,
	cwd: string,
	home = homedir(),
): { path: string } | { error: string } | null {
	const input = unescapePath(args);
	if (!input) return null;

	const target = resolve(cwd, expandHome(input, home));
	if (!existsSync(target)) return { error: `Directory does not exist: ${target}` };
	if (!statSync(target).isDirectory()) return { error: `Not a directory: ${target}` };
	return { path: target };
}

export function getCdArgumentCompletions(prefix: string, cwd: string, home = homedir()): AutocompleteItem[] {
	const typed = prefix.trimStart();
	const quickPicks = [
		{ value: "../", label: "../", description: "Parent directory" },
		{ value: "~/", label: "~/", description: "Home directory" },
	].filter((item) => item.value.startsWith(typed));

	const unescaped = unescapePath(typed);
	const expanded = expandHome(unescaped, home);
	const endsWithSlash = expanded.endsWith("/");
	const base = !expanded.includes("/") ? cwd : resolve(cwd, endsWithSlash ? expanded : dirname(expanded));
	const namePrefix = endsWithSlash ? "" : basename(expanded);
	const shownPrefix = unescaped.slice(0, unescaped.length - namePrefix.length);
	if (!isDirectory(base)) return quickPicks;

	const directories = readdirSync(base)
		.filter((name) => name.startsWith(namePrefix) && isDirectory(join(base, name)))
		.slice(0, 50)
		.map((name) => {
			const label = `${shownPrefix}${name}/`;
			return { value: escapeCompletion(label), label };
		});
	return [...quickPicks, ...directories];
}

export async function runCdCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const target = resolveCdTarget(args, ctx.cwd);
	if (target === null) {
		ctx.ui.notify(ctx.cwd, "info");
		return;
	}
	if ("error" in target) {
		ctx.ui.notify(target.error, "error");
		return;
	}
	if (target.path === ctx.cwd) {
		ctx.ui.notify(`Already in ${ctx.cwd}`, "info");
		return;
	}

	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) {
		ctx.ui.notify("/cd requires a saved session", "error");
		return;
	}

	await ctx.waitForIdle();
	const nextSessionFile = SessionManager.forkFrom(sessionFile, target.path).getSessionFile()!;
	const result = await ctx.switchSession(nextSessionFile, {
		withSession: async (nextCtx) => {
			process.chdir(nextCtx.cwd);
			nextCtx.ui.notify(`Changed directory to ${nextCtx.cwd}`, "info");
		},
	});

	if (result.cancelled) {
		unlinkSync(nextSessionFile);
		ctx.ui.notify("Directory change cancelled", "warning");
	}
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("cd", {
		description: "Switch the Pi session working directory",
		getArgumentCompletions: (prefix) => getCdArgumentCompletions(prefix, process.cwd()),
		handler: runCdCommand,
	});
}
