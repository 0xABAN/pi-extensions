import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export const PLAN_TOOL = "plan";

export const PLAN_MODE_PROMPT = readFileSync(new URL("./prompts/plan.md", import.meta.url), "utf8");

const APPROVED =
	"The user approved the plan. Plan mode has ended and the <plan_mode> rules no longer apply: you can now edit files and run commands. Implement the plan now, creating one todo per step first.";

const REVISE = "The user wants to revise the plan. Stop here and wait for their feedback.";

const QUESTION = "The plan is ready. Would you like to proceed?";
const CHOICES = ["Approve", "Revise"] as const;
type Choice = (typeof CHOICES)[number];

function approvalPicker(
	topic: string,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (choice: Choice) => void,
): Component {
	let selected = 0;

	return {
		render(width: number): string[] {
			const rule = theme.fg("accent", "─".repeat(width));
			const chip = ` ${theme.bg("selectedBg", ` ${topic} `)}`;
			const question = wrapTextWithAnsi(QUESTION, width - 2).map((line) => ` ${theme.bold(line)}`);
			const options = CHOICES.map((choice, index) => {
				if (index !== selected) return `  ${index + 1}. ${choice}`;
				return theme.fg("accent", theme.bold(`❯ ${index + 1}. ${choice}`));
			});
			const hint = ` ${theme.fg("dim", "press esc to revise the plan")}`;

			return [rule, "", chip, "", ...question, "", ...options, "", rule, "", hint];
		},

		handleInput(data: string): void {
			const picked = CHOICES[Number(data) - 1];
			if (picked) done(picked);
			else if (keybindings.matches(data, "tui.select.up")) selected = Math.max(0, selected - 1);
			else if (keybindings.matches(data, "tui.select.down")) selected = Math.min(CHOICES.length - 1, selected + 1);
			else if (keybindings.matches(data, "tui.select.confirm")) done(CHOICES[selected]!);
			else if (keybindings.matches(data, "tui.select.cancel")) done("Revise");
		},

		invalidate() {},
	};
}

export function registerPlanTool(pi: ExtensionAPI, approve: (ctx: ExtensionContext) => void): void {
	pi.registerTool({
		name: PLAN_TOOL,
		label: "Plan",
		description:
			"Ask the user to approve the plan you just wrote in your reply. Use it in plan mode when you propose a change to implement, after writing the full plan. Approve ends plan mode so you can implement the plan right away; Revise ends your turn so the user can give feedback.",
		promptSnippet: "Ask the user to approve the plan you just wrote",
		parameters: Type.Object({
			topic: Type.String({
				maxLength: 16,
				description:
					'MAX 16 CHARACTERS. Very short label for what the plan changes, shown above the approval question. Examples: "Auth flow", "Retry logic".',
			}),
		}),
		defaultActive: false,

		summarize: (args) => ({ label: "Plan", icon: "◇", target: args.topic }),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const choice = await ctx.ui.custom<Choice | undefined>(
				(_tui, theme, keybindings, done) => approvalPicker(params.topic, theme, keybindings, done),
				{ blocked: { kind: "permission", message: QUESTION } },
			);

			if (choice === "Approve") {
				approve(ctx);
				return { content: [{ type: "text", text: APPROVED }], details: {} };
			}

			return { content: [{ type: "text", text: REVISE }], details: {}, terminate: true };
		},
	});
}
