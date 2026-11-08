import type { AssistantMessage, AssistantMessageEventStream, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { McpResult } from "./extract-tool-results.js";
import type { PromptStream } from "./prompt-stream.js";
import { LiveRecording } from "./session-sync.js";
import type { RateLimitInfo } from "./rate-limit.js";

export function newAssistantOutput(model: Model<any>, text: string, stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

interface PendingToolCall {
	toolName: string;
	resolve: (result: McpResult) => void;
}

export interface AssistantStep {
	content: AssistantMessage["content"];
	uuid?: string;
	seen: Set<string>;
	emitted?: { digest: string; index: number; template: AssistantMessage; ids: string[] };
}

export class QueryContext {
	activeQuery: unknown | null = null;
	currentPiStream: AssistantMessageEventStream | null = null;
	currentOnResponse: SimpleStreamOptions["onResponse"] | undefined;
	heldRateLimit: RateLimitInfo | undefined;
	recording = new LiveRecording();
	assistantSteps = new Map<string, AssistantStep>();
	lastAssistantMessageId: string | undefined;
	turnAssistantIds: string[] = [];
	commitRecording: ((dirty: boolean) => void) | null = null;
	stopProcess: (() => void) | null = null;
	discarded = false;
	sawResult = false;
	pendingToolCalls = new Map<string, PendingToolCall>();
	pendingResults = new Map<string, McpResult>();
	turnToolCallIds: string[] = [];
	promptStream: PromptStream | null = null;
	pendingSteerUuids = new Set<string>();
	turnOpener: string | undefined;
	bindRunSignal: ((signal: AbortSignal | undefined, runStream: AssistantMessageEventStream) => void) | null = null;
	rateLimitRejection: { rateLimitType?: string; resetsAt?: number } | null = null;
	lastRateLimitWarnStep: number | null = null;
	lastRateLimitWarnThreshold: number | undefined;
	piSessionId: string | null = null;
	historyStale = false;
	settled: Promise<unknown> = Promise.resolve();

	turnOutput: AssistantMessage | null = null;
	turnStarted = false;
	turnEmissionRecorded = false;
	turnSawStreamEvent = false;
	turnSawToolCall = false;
	turnStreamMessageId: string | undefined;
	turnStreamOpen = false;
	turnStreamBlockStart = 0;
	turnFallbackMessageId: string | undefined;

	get turnMessage(): AssistantMessage {
		if (!this.turnOutput) throw new Error("turn accessed before resetTurnState");
		return this.turnOutput;
	}

	get turnBlocks(): Array<any> {
		return this.turnMessage.content;
	}

	releasePendingToolCalls(reason: string): void {
		for (const pending of this.pendingToolCalls.values()) pending.resolve({ content: [{ type: "text", text: reason }] });
		this.pendingToolCalls.clear();
		this.pendingResults.clear();
	}

	resetTurnState(model: Model<any>): void {
		this.turnOutput = newAssistantOutput(model, "", "stop");
		this.lastAssistantMessageId = undefined;
		this.turnAssistantIds = [];
		this.turnStarted = false;
		this.turnEmissionRecorded = false;
		this.turnSawStreamEvent = false;
		this.turnSawToolCall = false;
		this.turnStreamMessageId = undefined;
		this.turnStreamOpen = false;
		this.turnStreamBlockStart = 0;
		this.turnFallbackMessageId = undefined;
	}
}

export const activeQueryContexts = new Set<QueryContext>();
