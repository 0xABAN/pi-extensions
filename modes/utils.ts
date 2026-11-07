/**
 * Pure utility functions for agent modes.
 */

export type AgentMode = "build" | "plan" | "learn";

export const READ_ONLY_TOOLS = new Set([
	"read", "grep", "find", "ls", "bash",
	"codemode",
	"web_search", "fetch_content", "get_search_content",
	"ask_user_question", "intercom",
]);

// Destructive commands blocked in plan and learn mode
const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

// Safe read-only commands allowed in plan and learn mode
const SAFE_PATTERNS = [
	/^\s*cd\b/,
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

const SUBSTITUTION = /\$\(|`|[<>]\(/;
const HARMLESS_REDIRECT = /(^|\s)2>(\/dev\/null|&1)(?=[\s;&|]|$)/g;

function splitCommand(command: string): string[] | undefined {
	const parts = [""];
	let quote = "";

	for (let i = 0; i < command.length; i++) {
		let char = command[i]!;

		if (char === "\\" && quote !== "'") {
			char += command[++i] ?? "";
		} else if (quote) {
			if (char === quote) quote = "";
		} else if (char === "'" || char === '"') {
			quote = char;
		} else if (/[;&|\n]/.test(char)) {
			parts.push("");
			continue;
		}

		parts[parts.length - 1] += char;
	}

	if (quote) return undefined;
	return parts.filter((part) => part.trim());
}

function isSafePart(part: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(part));
	const isSafe = SAFE_PATTERNS.some((p) => p.test(part));
	return !isDestructive && isSafe;
}

export function isSafeCommand(command: string): boolean {
	if (SUBSTITUTION.test(command)) return false;

	const parts = splitCommand(command.replace(HARMLESS_REDIRECT, "$1"));
	if (!parts?.length) return false;

	return parts.every(isSafePart);
}

/** Numbered steps under a "Plan:" header — handed to rpiv-todo on execute. */
export function extractPlanSteps(message: string): string[] {
	const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return [];

	const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
	const steps: string[] = [];
	const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;

	for (const match of planSection.matchAll(numberedPattern)) {
		const text = match[2]
			.replace(/`([^`]+)`/g, "$1")
			.replace(/\s+/g, " ")
			.trim();
		if (text.length > 5 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-")) {
			steps.push(text.charAt(0).toUpperCase() + text.slice(1));
		}
	}
	return steps;
}
