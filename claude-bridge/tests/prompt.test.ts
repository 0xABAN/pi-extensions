import { expect, test } from "bun:test";
import { buildSystemPromptSections } from "../../../pi/packages/coding-agent/src/core/system-prompt.ts";
import { claudeCodeAppend } from "../src/prompt.ts";

const skill = {
	name: "write",
	description: "Edit prose.",
	filePath: "/skills/write/SKILL.md",
	baseDir: "/skills/write",
	sourceInfo: { path: "/skills/write/SKILL.md", source: "user", scope: "user" },
	disableModelInvocation: false,
} as never;

function system(options: Parameters<typeof buildSystemPromptSections>[0]) {
	return { role: "system" as const, content: "", sections: buildSystemPromptSections(options), timestamp: 0 };
}

test("forwards the addendum, project context and skills but none of pi's own sections", () => {
	const append = claudeCodeAppend(
		system({
			cwd: "/work",
			selectedTools: ["read", "bash"],
			toolSnippets: { read: "Read files", bash: "Run commands" },
			appendSystemPrompt: "Commit when checks pass.",
			contextFiles: [{ path: "/work/AGENTS.md", content: "Use bun." }],
			skills: [skill],
		}),
	)!;

	expect(append.startsWith("<addendum>\nCommit when checks pass.\n</addendum>\n\n<project_context>")).toBe(true);
	expect(append).toContain('<project_instructions path="/work/AGENTS.md">\nUse bun.\n</project_instructions>');
	expect(append).toContain("Use the read tool (mcp__custom-tools__read) to load a skill's file");
	expect(append).toContain("<location>/skills/write/SKILL.md</location>");
	expect(append).not.toContain("running inside pi");
	expect(append).not.toContain("<tools>");
	expect(append).not.toContain("<rules>");
	expect(append).not.toContain("<docs>");
	expect(append).not.toContain("<cwd>");
});

test("points a bash-only skills hint at the served bash tool", () => {
	const append = claudeCodeAppend(system({ cwd: "/work", selectedTools: ["bash"], skills: [skill] }))!;

	expect(append).toContain("Use bash (mcp__custom-tools__bash) to load a skill's file");
});

test("forwards a custom prompt and custom sections", () => {
	const append = claudeCodeAppend(
		system({
			cwd: "/work",
			customPrompt: "You review pull requests.",
			sections: { mcp_servers: "github: connected" },
		}),
	);

	expect(append).toBe("You review pull requests.\n\n<mcp_servers>\ngithub: connected\n</mcp_servers>");
});

test("forwards a forced prompt as given", () => {
	expect(claudeCodeAppend({ role: "system", content: "Answer in French.", timestamp: 0 })).toBe("Answer in French.");
});

test("refuses to send pi's preamble or both harness doc paths", () => {
	expect(() =>
		claudeCodeAppend({
			role: "system",
			content: "You are a coding assistant running inside pi, a coding agent harness.",
			timestamp: 0,
		}),
	).toThrow("pi's preamble");

	expect(() =>
		claudeCodeAppend(
			system({
				cwd: "/work",
				appendSystemPrompt: "See docs/custom-provider.md and docs/packages.md.",
			}),
		),
	).toThrow("docs/custom-provider.md and docs/packages.md in the addendum section");
});

test("sends nothing without a system message", () => {
	expect(claudeCodeAppend(undefined)).toBeUndefined();
});
