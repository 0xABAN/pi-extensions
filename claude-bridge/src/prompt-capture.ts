import type { Skill } from "@earendil-works/pi-coding-agent";
import { formatProjectContext } from "./agents-md.js";
import { debugLogPath } from "./log-paths.js";
import { renderSkillsBlock } from "./skills.js";

type PromptCaptureInput = {
	custom?: string;
	append?: string;
	contextFiles: { path: string; content: string }[];
	skills: Skill[];
	sections?: Record<string, string>;
};

type InheritedPrompt = {
	start: number;
	end: number;
	parent: PromptCapture;
};

export type PromptCapture = PromptCaptureInput & {
	assembledPrompt: string;
	source?: string;
	inherited: InheritedPrompt[];
};

type PromptCaptureDiagnostic = {
	systemPrompt: string;
	matches: { key: string; firstDivergent: number; source?: string }[];
};

export class PromptCaptures {
	private readonly captures = new Map<string, PromptCapture>();
	private readonly onDiagnose: (diagnostic: PromptCaptureDiagnostic) => void;

	constructor(private readonly limit = 256, onDiagnose?: (diagnostic: PromptCaptureDiagnostic) => void) {
		this.onDiagnose = onDiagnose ?? (() => {});
	}

	record(systemPrompt: string, input: PromptCaptureInput, source?: string): void {
		const existing = this.captures.get(systemPrompt);
		const customChanged = existing?.custom !== input.custom;
		const capture = existing ?? {
			...input,
			assembledPrompt: systemPrompt,
			contextFiles: [],
			skills: [],
			inherited: [],
		};

		capture.custom = input.custom;
		capture.append = input.append;
		capture.contextFiles = input.contextFiles.map((file) => ({ ...file }));
		capture.skills = [...input.skills];
		capture.sections = { ...input.sections };
		capture.source = source;
		if (!existing || customChanged) {
			capture.inherited = this.findInheritedPrompts(systemPrompt, input.custom);
		}

		this.touch(systemPrompt, capture);
	}

	resolve(systemPrompt?: string): PromptCapture | undefined {
		if (!systemPrompt) return undefined;
		const capture = this.captures.get(systemPrompt);
		if (capture) this.touch(systemPrompt, capture);
		return capture;
	}

	private touch(systemPrompt: string, capture: PromptCapture): void {
		this.captures.delete(systemPrompt);
		this.captures.set(systemPrompt, capture);
		for (const key of this.captures.keys()) {
			if (this.captures.size <= this.limit) break;
			this.captures.delete(key);
		}
	}

	resolveOrDerive(systemPrompt?: string): PromptCapture | undefined {
		if (!systemPrompt) return undefined;
		const exact = this.captures.get(systemPrompt);
		if (exact) {
			this.touch(systemPrompt, exact);
			return exact;
		}

		const revived = this.reachableCaptures().find((node) => node.assembledPrompt === systemPrompt);
		if (revived) {
			this.touch(systemPrompt, revived);
			return revived;
		}

		const embedded = this.findInheritedPrompts(systemPrompt, systemPrompt);
		if (embedded.length === 0) {
			const matches = this.closestKnown(systemPrompt);
			this.onDiagnose({ systemPrompt, matches });
			const truncated = matches.find(
				(m) => m.firstDivergent === systemPrompt.length && m.key.length > systemPrompt.length,
			);
			if (truncated) {
				throw new Error(
					`prompt-capture: this ${systemPrompt.length}-char prompt is the ${truncated.key.length}-char capture recorded at `
					+ `${truncated.source ?? "an unknown boundary"} with its final ${truncated.key.length - systemPrompt.length} chars missing. `
					+ `That shape matches pi#5581: an extension-triggered idle turn (sendMessage with triggerTurn) skips before_agent_start, `
					+ `so the prompt lacks that turn's extension additions. The turn fails; the next user-typed turn resolves normally. `
					+ `Workaround: when idle, send a user message instead of triggerTurn.`,
				);
			}
			throw new Error(
				`prompt-capture: no capture for this ${systemPrompt.length}-char system prompt, and it embeds none of the ${this.captures.size} known. `
				+ `Closest known match diverges at offset ${matches[0]?.firstDivergent ?? "?"} `
				+ `(${matches.length ? matches[0].key.length : 0}-char key${matches[0]?.source ? `, last recorded at ${matches[0].source}` : ""}). `
				+ `Claude Code would receive none of this turn's context files, skills or custom instructions. `
				+ `When the divergence sits at a section's opening tag, the capture and this prompt disagree about that section — `
				+ `pi's mcp_servers since pi 0.99.2, or one an extension added. `
				+ `Otherwise an extension loaded after claude-bridge rewrote the system prompt from before_agent_start — `
				+ `one that wraps it is fine, one that rebuilds or strips it leaves nothing to match — `
				+ `or pi rebuilt the prompt outside before_agent_start (a late-registered tool or fresh resource discovery).`,
			);
		}

		return { assembledPrompt: systemPrompt, custom: systemPrompt, contextFiles: [], skills: [], inherited: embedded };
	}

	get size(): number {
		return this.captures.size;
	}

	private closestKnown(systemPrompt: string): { key: string; firstDivergent: number; source?: string }[] {
		let shared = 0;
		const matches: { key: string; firstDivergent: number; source?: string }[] = [];
		for (const [key, capture] of this.captures.entries()) {
			const limit = Math.min(key.length, systemPrompt.length);
			let i = 0;
			while (i < limit && key.charCodeAt(i) === systemPrompt.charCodeAt(i)) i++;
			if (i >= shared) {
				if (i > shared) {
					shared = i;
					matches.length = 0;
				}
				matches.push({ key, firstDivergent: i, source: capture.source });
			}
		}
		return matches;
	}

	private findInheritedPrompts(systemPrompt: string, custom?: string): InheritedPrompt[] {
		if (!custom) return [];

		const candidates: Array<InheritedPrompt & { length: number }> = [];
		for (const parent of this.reachableCaptures()) {
			const key = parent.assembledPrompt;
			if (key === systemPrompt || key.length === 0) continue;
			for (let start = custom.indexOf(key); start !== -1; start = custom.indexOf(key, start + key.length)) {
				candidates.push({ start, end: start + key.length, length: key.length, parent });
			}
		}

		candidates.sort((a, b) => b.length - a.length || a.start - b.start);
		const selected: InheritedPrompt[] = [];
		for (const candidate of candidates) {
			if (selected.some((edge) => candidate.start < edge.end && candidate.end > edge.start)) continue;
			selected.push({ start: candidate.start, end: candidate.end, parent: candidate.parent });
		}
		return selected.sort((a, b) => a.start - b.start);
	}

	private reachableCaptures(): PromptCapture[] {
		const result: PromptCapture[] = [];
		const seen = new Set<PromptCapture>();
		const visit = (capture: PromptCapture): void => {
			if (seen.has(capture)) return;
			seen.add(capture);
			result.push(capture);
			for (const edge of capture.inherited) visit(edge.parent);
		};
		for (const capture of this.captures.values()) visit(capture);
		return result;
	}
}

export const PI_PREAMBLE = "You are an expert coding assistant operating inside pi";

const ANTHROPIC_THIRD_PARTY_TRIGGERS = ["docs/custom-provider.md", "docs/packages.md"];

type PromptPart = { label: string; text: string };

const SHARED_CAPTURES_KEY = Symbol.for("claude-bridge:promptCaptures");

export function sharedPromptCaptures(onDiagnose?: (diagnostic: PromptCaptureDiagnostic) => void): PromptCaptures {
	const globals = globalThis as Record<symbol, PromptCaptures | undefined>;
	return (globals[SHARED_CAPTURES_KEY] ??= new PromptCaptures(256, onDiagnose));
}

export function projectPromptCapture(
	capture: PromptCapture,
	options: { hasReadTool: boolean },
): string | undefined {
	return projectCapture(capture, options, new Set());
}

function inheritedSkillPaths(capture: PromptCapture): Set<string> {
	const paths = new Set<string>();
	const visited = new Set<PromptCapture>();
	const visiting = new Set<PromptCapture>();

	const visit = (node: PromptCapture): void => {
		if (visited.has(node)) return;
		if (visiting.has(node)) throw new Error("Cyclic prompt inheritance");
		visiting.add(node);
		for (const edge of node.inherited) visit(edge.parent);
		for (const skill of node.skills) if (!skill.disableModelInvocation) paths.add(skill.filePath);
		visiting.delete(node);
		visited.add(node);
	};

	for (const edge of capture.inherited) visit(edge.parent);
	return paths;
}

function projectCapture(
	capture: PromptCapture,
	options: { hasReadTool: boolean },
	visiting: Set<PromptCapture>,
): string | undefined {
	if (visiting.has(capture)) throw new Error("Cyclic prompt inheritance");
	visiting.add(capture);
	try {
		const seenSkillPaths = inheritedSkillPaths(capture);
		const ownSkills = capture.skills.filter((skill) => {
			if (skill.disableModelInvocation || seenSkillPaths.has(skill.filePath)) return false;
			seenSkillPaths.add(skill.filePath);
			return true;
		});

		const custom = projectCustom(capture, options, visiting);
		const parts: PromptPart[] = [];
		const context = formatProjectContext(capture.contextFiles);
		if (context) parts.push({ label: "the project context block", text: context });
		const skills = renderSkillsBlock(ownSkills, options.hasReadTool);
		if (skills) parts.push({ label: "the skills block", text: skills });
		if (custom) parts.push({ label: "the custom prompt", text: custom });
		if (capture.append) parts.push({ label: "the appended instructions", text: capture.append });
		for (const [name, content] of Object.entries(capture.sections ?? {})) {
			if (!content) continue;
			parts.push({ label: `the ${name} section`, text: `<${name}>\n${content}\n</${name}>` });
		}
		assertSendablePrompt(parts, capture);
		return parts.length > 0 ? parts.map((part) => part.text).join("\n\n") : undefined;
	} finally {
		visiting.delete(capture);
	}
}

function assertSendablePrompt(parts: readonly PromptPart[], capture: PromptCapture): void {
	const findings: string[] = [];
	for (const { label, text } of parts) {
		const offset = preambleAtLineStart(text);
		if (offset !== -1) {
			findings.push(`pi's preamble ("${PI_PREAMBLE}") in ${label}, at offset ${offset} of ${text.length} chars`);
		}
		if (ANTHROPIC_THIRD_PARTY_TRIGGERS.every((trigger) => text.includes(trigger))) {
			findings.push(`${ANTHROPIC_THIRD_PARTY_TRIGGERS.join(" and ")} in ${label}`);
		}
	}
	if (findings.length === 0) return;

	throw new Error([
		"prompt-capture: refusing to send this prompt. Claude Code's Anthropic path reads a request",
		"  carrying pi's harness, or the phrase pair its subscription gate rejects, as a third-party",
		"  app: it fails with 400 or is billed as extra usage.",
		...findings.map((finding) => `  Found: ${finding}.`),
		`  Capture: ${capture.source ?? "unknown"}, ${capture.inherited.length} inherited capture(s) substituted.`,
		"  If this came from an inherited pi prompt, see README \"Compatibility with other extensions\".",
		"  If it is your own text, reword or remove it. CLAUDE_BRIDGE_DEBUG=1 writes the full prompt to",
		`  ${debugLogPath()}.`,
	].join("\n"));
}

function preambleAtLineStart(text: string): number {
	for (let offset = text.indexOf(PI_PREAMBLE); offset !== -1; offset = text.indexOf(PI_PREAMBLE, offset + PI_PREAMBLE.length)) {
		if (offset === 0 || text[offset - 1] === "\n") return offset;
	}
	return -1;
}

function projectCustom(
	capture: PromptCapture,
	options: { hasReadTool: boolean },
	visiting: Set<PromptCapture>,
): string | undefined {
	if (!capture.custom || capture.inherited.length === 0) return capture.custom;

	let result = "";
	let cursor = 0;
	for (const edge of capture.inherited) {
		result += capture.custom.slice(cursor, edge.start);
		result += projectCapture(edge.parent, options, visiting) ?? "";
		cursor = edge.end;
	}
	return result + capture.custom.slice(cursor);
}
