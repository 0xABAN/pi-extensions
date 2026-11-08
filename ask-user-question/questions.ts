import { type Static, Type } from "typebox";

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
const MAX_HEADER_LENGTH = 16;
const MAX_LABEL_LENGTH = 60;

export const OTHER_LABEL = "Type something.";
export const NEXT_LABEL = "Next";
const RESERVED_LABELS = ["Other", OTHER_LABEL, NEXT_LABEL];

export const NO_INPUT = "(no input)";
const DECLINED = "User declined to answer questions";

const OptionSchema = Type.Object({
	label: Type.String({
		maxLength: MAX_LABEL_LENGTH,
		description: `MAX ${MAX_LABEL_LENGTH} CHARACTERS — hard limit, requests over the limit are rejected. The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.`,
	}),
	description: Type.String({
		description:
			"Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
	}),
	preview: Type.Optional(
		Type.String({
			description:
				"Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.",
		}),
	),
});

const QuestionSchema = Type.Object({
	question: Type.String({
		description:
			'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
	}),
	header: Type.String({
		maxLength: MAX_HEADER_LENGTH,
		description: `MAX ${MAX_HEADER_LENGTH} CHARACTERS — hard limit, requests over the limit are rejected. Very short chip/tag shown next to the question. Examples: "Auth method", "Library", "Approach".`,
	}),
	options: Type.Array(OptionSchema, {
		minItems: MIN_OPTIONS,
		maxItems: MAX_OPTIONS,
		description:
			"The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). The 'Type something.' row is appended automatically — do NOT author it.",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({
			default: false,
			description:
				"Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
		}),
	),
});

export const QuestionParamsSchema = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: MAX_QUESTIONS,
		description: "Questions to ask the user (1-4 questions)",
	}),
});

export type Question = Static<typeof QuestionSchema>;
export type QuestionParams = Static<typeof QuestionParamsSchema>;

export interface Answer {
	questionIndex: number;
	question: string;
	kind: "option" | "custom" | "multi";
	answer: string | null;
	selected?: string[];
	notes?: string;
	preview?: string;
}

type QuestionnaireError =
	| "no_ui"
	| "no_questions"
	| "empty_options"
	| "too_many_questions"
	| "duplicate_question"
	| "duplicate_option_label"
	| "reserved_label";

export interface QuestionnaireResult {
	answers: Answer[];
	cancelled: boolean;
	globalNote?: string;
	unanswered?: number[];
	error?: QuestionnaireError;
}

export function isQuestionnaireResult(value: unknown): value is QuestionnaireResult {
	if (!value || typeof value !== "object") return false;
	const result = value as Record<string, unknown>;
	return Array.isArray(result.answers) && typeof result.cancelled === "boolean";
}

function withoutCarriageReturns(text: string): string;
function withoutCarriageReturns(text: string | undefined): string | undefined;
function withoutCarriageReturns(text: string | undefined): string | undefined {
	return text?.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

export function normalizeQuestions(params: QuestionParams): Question[] {
	return params.questions.map((question) => ({
		...question,
		question: withoutCarriageReturns(question.question),
		header: withoutCarriageReturns(question.header),
		options: question.options.map((option) => ({
			...option,
			label: withoutCarriageReturns(option.label),
			description: withoutCarriageReturns(option.description),
			...(option.preview === undefined ? {} : { preview: withoutCarriageReturns(option.preview) }),
		})),
	}));
}

export function validateQuestions(questions: Question[]): { error: QuestionnaireError; message: string } | undefined {
	if (questions.length === 0) {
		return { error: "no_questions", message: "Error: At least one question is required" };
	}
	if (questions.length > MAX_QUESTIONS) {
		return {
			error: "too_many_questions",
			message: `Error: At most ${MAX_QUESTIONS} questions are allowed per invocation`,
		};
	}
	if (new Set(questions.map((question) => question.question)).size !== questions.length) {
		return { error: "duplicate_question", message: "Error: Question text must be unique within an invocation" };
	}

	for (const question of questions) {
		if (question.options.length < MIN_OPTIONS) {
			return { error: "empty_options", message: `Error: Each question requires at least ${MIN_OPTIONS} options` };
		}
		const labels = question.options.map((option) => option.label);
		if (labels.some((label) => RESERVED_LABELS.includes(label))) {
			return { error: "reserved_label", message: `Error: Option label is reserved (${RESERVED_LABELS.join(", ")})` };
		}
		if (new Set(labels).size !== labels.length) {
			return { error: "duplicate_option_label", message: "Error: Option labels must be unique within a question" };
		}
	}
	return undefined;
}

export function formatAnswer(answer: Answer): string {
	if (answer.kind === "multi") {
		const values = [...(answer.selected ?? []), ...(answer.answer ? [answer.answer] : [])];
		return values.length > 0 ? values.join(", ") : NO_INPUT;
	}
	return answer.answer || NO_INPUT;
}

export function toolResult(text: string, details: QuestionnaireResult) {
	return { content: [{ type: "text" as const, text }], details };
}

function answerSegment(answer: Answer): string {
	const parts = [`"${answer.question}"="${formatAnswer(answer)}"`];
	if (answer.preview) parts.push(`selected preview: ${answer.preview}`);
	if (answer.notes) parts.push(`user notes: ${answer.notes}`);
	return `${parts.join(". ")}.`;
}

export function questionnaireResponse(result: QuestionnaireResult, questions: Question[]) {
	if (result.cancelled) {
		return toolResult(DECLINED, {
			answers: result.answers,
			cancelled: true,
			...(result.globalNote ? { globalNote: result.globalNote } : {}),
		});
	}

	const segments: string[] = [];
	const unanswered: number[] = [];
	questions.forEach((_, index) => {
		const answer = result.answers.find((candidate) => candidate.questionIndex === index);
		if (answer) segments.push(answerSegment(answer));
		else unanswered.push(index);
	});
	if (segments.length === 0 && !result.globalNote) {
		return toolResult(DECLINED, { answers: result.answers, cancelled: true });
	}

	if (unanswered.length > 0) {
		segments.push(`unanswered: ${unanswered.map((index) => `"${questions[index]!.question}"`).join(", ")}.`);
	}
	if (result.globalNote) segments.push(`global note: ${result.globalNote}.`);
	return toolResult(
		`User has answered your questions: ${segments.join(" ")} You can now continue with the user's answers in mind.`,
		unanswered.length > 0 ? { ...result, unanswered } : result,
	);
}
