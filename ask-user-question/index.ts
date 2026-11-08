import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { QuestionDialog } from "./dialog.ts";
import {
	MAX_OPTIONS,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	normalizeQuestions,
	type QuestionnaireResult,
	QuestionParamsSchema,
	questionnaireResponse,
	toolResult,
	validateQuestions,
} from "./questions.ts";
import { renderAskCall, renderAskResult, summarizeAsk } from "./transcript.ts";

const PROMPT_SNIPPET = `Ask the user up to ${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) when requirements are ambiguous`;
const PROMPT_GUIDELINES = [
	`Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to ${MAX_QUESTIONS} questions per invocation.`,
	`Each question MUST have ${MIN_OPTIONS}-${MAX_OPTIONS} options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs. The user can additionally type a custom answer via the automatically appended "Type something." row on every question, or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.`,
	`Set multiSelect: true when multiple answers are valid. Provide an options[].preview markdown string when an option benefits from richer side-by-side context (mockups, code snippets, diagrams, configs) — single-select only. The "Type something." row is appended to every question; in preview mode it expands to the full pane width while typing so the custom answer is not cramped into the narrow options column. If you recommend a specific option, make that the first option and append "(Recommended)" to its label.`,
	"Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.",
];

const DESCRIPTION = `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Users can type a custom answer via the automatically appended "Type something." row on every question or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.
- Use multiSelect: true when multiple answers are valid. The "Type something." row is available on every question, including when options carry a \`preview\`; in preview mode it expands to the full pane width while typing so the custom answer is not cramped into the narrow options column.
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).`;

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User Question",
		exposure: "model-only",
		description: DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: QuestionParamsSchema,
		summarize: (args) => summarizeAsk(args),
		renderCall: (args, theme) => renderAskCall(args, theme),
		renderResult: (result, { expanded }, theme, context) =>
			renderAskResult(result, context?.args, theme, { expanded, isError: context?.isError ?? false }),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const questions = normalizeQuestions(params);
			if (!ctx.hasUI) {
				return toolResult("Error: UI not available (running in non-interactive mode)", {
					answers: [],
					cancelled: true,
					error: "no_ui",
				});
			}

			const invalid = validateQuestions(questions);
			if (invalid) {
				return toolResult(invalid.message, { answers: [], cancelled: true, error: invalid.error });
			}

			const result = await ctx.ui.custom<QuestionnaireResult>(
				(tui, theme, keybindings, done) => new QuestionDialog(tui, theme, keybindings, questions, done),
				{ blocked: { kind: "question", message: questions[0]!.question } },
			);
			return questionnaireResponse(result, questions);
		},
	});
}
