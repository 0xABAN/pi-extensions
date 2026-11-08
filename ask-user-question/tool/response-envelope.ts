import { formatAnswerScalar } from "./format-answer.ts";
import type { QuestionAnswer, QuestionnaireResult, QuestionParams } from "./types.ts";

export const DECLINE_MESSAGE = "User declined to answer questions";
export const ENVELOPE_PREFIX = "User has answered your questions:";
export const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";

export function buildQuestionnaireResponse(result: QuestionnaireResult | null | undefined, params: QuestionParams) {
	if (!result || result.cancelled) {
		return buildToolResult(DECLINE_MESSAGE, {
			answers: result?.answers ?? [],
			cancelled: true,
			...(result?.globalNote && result.globalNote.length > 0 ? { globalNote: result.globalNote } : {}),
		});
	}
	const segments: string[] = [];
	const unanswered: number[] = [];
	for (let i = 0; i < params.questions.length; i++) {
		const a = result.answers.find((x) => x.questionIndex === i);
		if (a) segments.push(buildAnswerSegment(a));
		else unanswered.push(i);
	}
	const hasGlobalNote = result.globalNote !== undefined && result.globalNote.length > 0;
	if (segments.length === 0 && !hasGlobalNote) {
		return buildToolResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true });
	}
	if (unanswered.length > 0) segments.push(buildUnansweredSegment(unanswered, params));
	if (hasGlobalNote) segments.push(`global note: ${result.globalNote}.`);
	const details = unanswered.length > 0 ? { ...result, unanswered } : result;
	return buildToolResult(`${ENVELOPE_PREFIX} ${segments.join(" ")} ${ENVELOPE_SUFFIX}`, details);
}

export function buildUnansweredSegment(indexes: readonly number[], params: QuestionParams): string {
	return `unanswered: ${indexes.map((i) => `"${params.questions[i]?.question}"`).join(", ")}.`;
}

export function buildAnswerSegment(a: QuestionAnswer): string {
	const parts: string[] = [`"${a.question}"="${formatAnswerScalar(a)}"`];
	if (a.preview && a.preview.length > 0) parts.push(`selected preview: ${a.preview}`);
	if (a.notes && a.notes.length > 0) parts.push(`user notes: ${a.notes}`);
	return `${parts.join(". ")}.`;
}

export function buildToolResult(text: string, details: QuestionnaireResult) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}
