export const ASK_USER_PROMPT_EVENT = "rpiv:ask-user:prompt" as const;

export interface AskUserPromptEventPayload {
	questions: ReadonlyArray<AskUserPromptQuestion>;
	toolCallId?: string;
}

export const ASK_USER_BLOCKED_EVENT = "rpiv:ask-user:blocked" as const;

export interface AskUserBlockedEventPayload {
	active: boolean;
	toolCallId?: string;
}

export interface AskUserPromptQuestion {
	question: string;
	header: string;
	multiSelect: boolean;
	options: ReadonlyArray<AskUserPromptOption>;
}

export interface AskUserPromptOption {
	label: string;
	description: string;
	hasPreview: boolean;
}

export const ASK_USER_ANSWER_EVENT = "rpiv:ask-user:answer" as const;

export interface AskUserAnswerEventPayload {
	toolCallId: string;
	requestId?: string;
	answers?: ReadonlyArray<AskUserAnswerEntry>;
	globalNote?: string;
	cancel?: boolean;
}

export interface AskUserAnswerEntry {
	questionIndex: number;
	optionIndexes?: readonly number[];
	text?: string;
	notes?: string;
}

export const ASK_USER_ANSWER_RESULT_EVENT = "rpiv:ask-user:answer-result" as const;

export type AskUserAnswerRejectCode = "not_found" | "invalid_payload" | "invalid_answer" | "unsupported_host";

export interface AskUserAnswerResultEventPayload {
	ok: boolean;
	code?: AskUserAnswerRejectCode;
	reason?: string;
	requestId?: string;
	toolCallId?: string;
}
