import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserQuestionTool } from "./ask-user-question.ts";
import { registerAskUserQuestionReconciler } from "./reconcile.ts";
import { I18N_NAMESPACE } from "./state/i18n-bridge.ts";

type I18nLoader = {
	registerLocalesFromDir: (namespace: string, packageUrl: string, options?: { label?: string }) => void;
};

try {
	const sdk = (await import("@juicesharp/rpiv-i18n/loader")) as I18nLoader;
	sdk.registerLocalesFromDir(I18N_NAMESPACE, import.meta.url, { label: "rpiv-ask-user-question" });
} catch {
}

export {
	ASK_USER_ANSWER_EVENT,
	ASK_USER_ANSWER_RESULT_EVENT,
	ASK_USER_BLOCKED_EVENT,
	ASK_USER_PROMPT_EVENT,
	type AskUserAnswerEntry,
	type AskUserAnswerEventPayload,
	type AskUserAnswerRejectCode,
	type AskUserAnswerResultEventPayload,
	type AskUserBlockedEventPayload,
	type AskUserPromptEventPayload,
	type AskUserPromptOption,
	type AskUserPromptQuestion,
} from "./events.ts";

export default function (pi: ExtensionAPI) {
	registerAskUserQuestionTool(pi);
	registerAskUserQuestionReconciler(pi);
}
