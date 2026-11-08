import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ASK_USER_ANSWER_EVENT,
	ASK_USER_ANSWER_RESULT_EVENT,
	type AskUserAnswerRejectCode,
	type AskUserAnswerResultEventPayload,
} from "./events.ts";
import { resolveExternalAnswer } from "./tool/external-answer.ts";
import type { QuestionData, QuestionnaireResult } from "./tool/types.ts";

export type AnswerHost = "tui" | "rpc";

export class OpenQuestionnaire {
	private result: QuestionnaireResult | undefined;
	private deliver: ((result: QuestionnaireResult) => void) | undefined;
	private resolveEarly!: (result: QuestionnaireResult) => void;
	readonly answeredEarly = new Promise<QuestionnaireResult>((resolve) => {
		this.resolveEarly = resolve;
	});

	constructor(
		readonly toolCallId: string,
		readonly questions: readonly QuestionData[],
		public host: AnswerHost,
	) {}

	get settled(): QuestionnaireResult | undefined {
		return this.result;
	}

	attach(done: (result: QuestionnaireResult) => void): void {
		this.deliver = done;
	}

	settle(result: QuestionnaireResult): boolean {
		if (this.result) return false;
		this.result = result;
		if (this.deliver) this.deliver(result);
		else this.resolveEarly(result);
		return true;
	}
}

export interface AnswerChannel {
	open(toolCallId: string, questions: readonly QuestionData[], host: AnswerHost): OpenQuestionnaire;
	close(questionnaire: OpenQuestionnaire): void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function registerAnswerChannel(pi: ExtensionAPI): AnswerChannel {
	const open = new Map<string, OpenQuestionnaire>();

	pi.events.on(ASK_USER_ANSWER_EVENT, (data: unknown) => {
		const payload = isRecord(data) ? data : {};
		const requestId = typeof payload.requestId === "string" ? payload.requestId : undefined;
		const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
		const reply = (code?: AskUserAnswerRejectCode, reason?: string) => {
			const verdict: AskUserAnswerResultEventPayload = {
				ok: code === undefined,
				...(code ? { code, reason } : {}),
				...(requestId !== undefined ? { requestId } : {}),
				...(toolCallId !== undefined ? { toolCallId } : {}),
			};
			pi.events.emit(ASK_USER_ANSWER_RESULT_EVENT, verdict);
		};

		if (!isRecord(data)) return reply("invalid_payload", "payload must be an object");
		if (payload.requestId !== undefined && requestId === undefined) {
			return reply("invalid_payload", "requestId must be a string");
		}
		if (toolCallId === undefined) return reply("invalid_payload", "toolCallId must be a string");
		const target = open.get(toolCallId);
		if (!target || target.settled) return reply("not_found", `no open questionnaire for tool call ${toolCallId}`);
		if (target.host === "rpc") return reply("unsupported_host", "this host shows the questions in its own dialogs");

		const outcome = resolveExternalAnswer(target.questions, payload);
		if (!outcome.ok) return reply(outcome.code, outcome.reason);
		if (!target.settle(outcome.result)) return reply("not_found", `tool call ${toolCallId} is already answered`);
		reply();
	});

	return {
		open(toolCallId, questions, host) {
			const questionnaire = new OpenQuestionnaire(toolCallId, questions, host);
			open.set(toolCallId, questionnaire);
			return questionnaire;
		},
		close(questionnaire) {
			if (open.get(questionnaire.toolCallId) === questionnaire) open.delete(questionnaire.toolCallId);
		},
	};
}
