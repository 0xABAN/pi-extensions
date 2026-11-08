import { contentText, type SystemMessage } from "@earendil-works/pi-ai";
import { debugLogPath } from "./debug.js";
import { MCP_TOOL_PREFIX } from "./mcp-server.js";

const BUILT_IN_SECTIONS = new Set([
	"preamble",
	"tools",
	"rules",
	"docs",
	"addendum",
	"project_context",
	"skills",
	"cwd",
]);
const DEFAULT_PROMPT_SECTIONS = ["tools", "rules", "docs"];
const FORWARDED_SECTIONS = ["addendum", "project_context", "skills"];

const PI_PREAMBLE = "You are a coding assistant running inside pi";
const THIRD_PARTY_TRIGGERS = ["docs/custom-provider.md", "docs/packages.md"];

interface PromptPart {
	label: string;
	text: string;
}

function pointSkillsAtMcpTools(skills: string): string {
	return skills
		.replace(
			"Use the read tool to load a skill's file",
			`Use the read tool (${MCP_TOOL_PREFIX}read) to load a skill's file`,
		)
		.replace("Use bash to load a skill's file", `Use bash (${MCP_TOOL_PREFIX}bash) to load a skill's file`);
}

function preambleAtLineStart(text: string): number {
	for (
		let offset = text.indexOf(PI_PREAMBLE);
		offset !== -1;
		offset = text.indexOf(PI_PREAMBLE, offset + PI_PREAMBLE.length)
	) {
		if (offset === 0 || text[offset - 1] === "\n") return offset;
	}
	return -1;
}

function assertSendable(parts: PromptPart[]): void {
	const findings: string[] = [];
	for (const { label, text } of parts) {
		const offset = preambleAtLineStart(text);
		if (offset !== -1) {
			findings.push(`pi's preamble ("${PI_PREAMBLE}") in ${label}, at offset ${offset}`);
		}
		if (THIRD_PARTY_TRIGGERS.every((trigger) => text.includes(trigger))) {
			findings.push(`${THIRD_PARTY_TRIGGERS.join(" and ")} in ${label}`);
		}
	}
	if (findings.length === 0) {
		return;
	}

	throw new Error(
		[
			"claude-bridge: refusing to send this prompt. Claude Code's Anthropic path reads a request carrying",
			"  pi's harness, or the phrase pair its subscription gate rejects, as a third-party app: it fails",
			"  with 400 or is billed as extra usage.",
			...findings.map((finding) => `  Found: ${finding}.`),
			`  Reword or remove that text. CLAUDE_BRIDGE_DEBUG=1 writes the full prompt to ${debugLogPath()}.`,
		].join("\n"),
	);
}

export function claudeCodeAppend(system: SystemMessage | undefined): string | undefined {
	if (!system) {
		return undefined;
	}

	const sections = system.sections ?? {};
	const parts: PromptPart[] = [];

	const content = contentText(system.content);
	if (content) {
		parts.push({ label: "the forced system prompt", text: content });
	}

	const customPreamble = !DEFAULT_PROMPT_SECTIONS.some((name) => sections[name]);
	if (customPreamble && sections.preamble) {
		parts.push({ label: "the custom system prompt", text: sections.preamble });
	}

	for (const name of FORWARDED_SECTIONS) {
		const text = sections[name];
		if (text) {
			parts.push({ label: `the ${name} section`, text: name === "skills" ? pointSkillsAtMcpTools(text) : text });
		}
	}

	for (const [name, text] of Object.entries(sections)) {
		if (text && !BUILT_IN_SECTIONS.has(name)) {
			parts.push({ label: `the ${name} section`, text });
		}
	}

	assertSendable(parts);
	return parts.length > 0 ? parts.map((part) => part.text).join("\n\n") : undefined;
}
