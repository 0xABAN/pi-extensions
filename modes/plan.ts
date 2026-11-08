import type { ExtensionAPI, ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export const PLAN_TOOL = "plan";

export const PLAN_MODE_PROMPT = `Plan mode is active until the user approves a plan through the plan tool.
Until then, do not change anything: no edits, commits, or commands that write.
Your tools: read, grep, find, ls, read-only bash (commands like cat, grep, and
git log; others are blocked), codemode, web search and fetch, ask_user_question,
and intercom.

Answer questions normally. To propose a change, explore first and ask about real
ambiguities, then write the plan as your reply and call the plan tool to request
approval. Never ask "should I proceed?" in text; the plan tool does that.

Plan format, in Markdown:
- Context: why the change is needed and the intended outcome, in one or two sentences.
- Steps: a numbered list in order, each naming the files and functions it changes
  and existing code to reuse.
- Verification: how to check that it works end to end.
Recommend one approach only. Keep the plan short enough to scan and specific
enough to execute.`;

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

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const choice = await ctx.ui.custom<Choice | undefined>((_tui, theme, keybindings, done) =>
				approvalPicker(params.topic, theme, keybindings, done),
			);

			if (choice === "Approve") {
				approve(ctx);
				return { content: [{ type: "text", text: APPROVED }], details: {} };
			}

			return { content: [{ type: "text", text: REVISE }], details: {}, terminate: true };
		},
	});
}
