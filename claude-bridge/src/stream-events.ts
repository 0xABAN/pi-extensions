import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { digestMessage } from "./message-digests.js";
import type { AssistantStep, QueryContext } from "./query-state.js";
import { type SdkUsage, updateUsage } from "./usage.js";

function piToolNameFor(name: string, customToolNameToPi: Map<string, string>): string | undefined {
	return customToolNameToPi.get(name) ?? customToolNameToPi.get(name.toLowerCase());
}

const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
	read: { file_path: "path" },
	write: { file_path: "path" },
	edit: { file_path: "path", old_string: "oldText", new_string: "newText", old_text: "oldText", new_text: "newText" },
};

function mapToolArgs(toolName: string, args: Record<string, unknown> | undefined): Record<string, unknown> {
	const input = args ?? {};
	const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		const piKey = renames?.[key] ?? key;
		if (!(piKey in result)) result[piKey] = value;
	}
	if (toolName.toLowerCase() === "edit") {
		const single = (value: unknown): boolean =>
			Boolean(
				value &&
					typeof value === "object" &&
					typeof (value as Record<string, unknown>).oldText === "string" &&
					typeof (value as Record<string, unknown>).newText === "string",
			);
		if (typeof result.edits === "string") {
			try {
				const parsed: unknown = JSON.parse(result.edits);
				if (Array.isArray(parsed)) result.edits = parsed;
				else if (single(parsed)) result.edits = [parsed];
			} catch {}
		} else if (single(result.edits)) result.edits = [result.edits];
	}
	return result;
}

function recordUsage(output: AssistantMessage, usage: SdkUsage, model: Model<any>): void {
	updateUsage(output, usage, model);
}

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use":
			return "toolUse";
		case "max_tokens":
			return "length";
		default:
			return "stop";
	}
}

function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input) return fallback;
	try {
		return JSON.parse(input);
	} catch {
		return fallback;
	}
}

export const completedStreams = new WeakSet<object>();

export function endStream(stream: AssistantMessageEventStream, event: AssistantMessageEvent): void {
	stream.push(event);
	completedStreams.add(stream);
	stream.end();
}

export function endCurrentPiStream(c: QueryContext, event: AssistantMessageEvent): void {
	endStream(c.currentPiStream!, event);
	c.currentPiStream = null;
}

function endToolUseTurn(c: QueryContext): void {
	c.turnOutput!.stopReason = "toolUse";
	recordAssistantEmission(c);
	endCurrentPiStream(c, { type: "done", reason: "toolUse", message: c.turnOutput! });
}

export function pushTextBlock(c: QueryContext, text: string): void {
	ensureTurnStarted(c);
	c.turnBlocks.push({ type: "text", text });
	const idx = c.turnBlocks.length - 1;
	c.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: c.turnMessage });
	c.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: text, partial: c.turnMessage });
	c.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: text, partial: c.turnMessage });
}

export function claimCurrentPiStream(
	stream: AssistantMessageEventStream,
	c: QueryContext,
	options: SimpleStreamOptions | undefined,
): void {
	c.currentPiStream = stream;
	c.currentOnResponse = options?.onResponse;
}

function ensureTurnStarted(c: QueryContext): void {
	if (!c.turnStarted && c.currentPiStream && c.turnOutput) {
		c.currentPiStream!.push({ type: "start", partial: c.turnMessage });
		c.turnStarted = true;
	}
}

export function recordAssistantEmission(c: QueryContext): void {
	const output = c.turnOutput;
	if (!output || output.stopReason === "error" || output.stopReason === "aborted" || c.turnEmissionRecorded) return;
	c.turnEmissionRecorded = true;
	const id = c.turnStreamMessageId ?? c.lastAssistantMessageId;
	if (!id) {
		c.recording.gap();
		return;
	}
	let step = c.assistantSteps.get(id);
	if (!step) {
		step = { content: [], seen: new Set() };
		c.assistantSteps.set(id, step);
	}
	if (!step.emitted) {
		const digest = digestMessage(output);
		const toolCalls = output.content.filter((b) => b.type === "toolCall").map((b) => b.id);
		const ids = c.turnAssistantIds.length ? [...c.turnAssistantIds] : [id];
		step.emitted = {
			digest,
			index: c.recording.assistant(digest, toolCalls, undefined, output.content.length > 0),
			template: { ...output, content: [] },
			ids,
		};
		for (const apiId of ids) {
			const part = c.assistantSteps.get(apiId);
			if (part) part.emitted = step.emitted;
		}
	}
	completeAssistantRecording(c, step);
}

function completeAssistantRecording(c: QueryContext, step: AssistantStep): void {
	if (!step.emitted) return;
	const parts = step.emitted.ids.map((id) => c.assistantSteps.get(id));
	const last = parts.at(-1);
	if (
		parts.every((part) => part?.uuid) &&
		last?.uuid &&
		digestMessage({ ...step.emitted.template, content: parts.flatMap((part) => part!.content) }) ===
			step.emitted.digest
	) {
		c.recording.completeAssistant(step.emitted.index, last.uuid);
	}
}

function incorporate(c: QueryContext, uuid: string): boolean {
	const recorded = c.recording.acknowledge(uuid);
	return c.pendingSteerUuids.delete(uuid) || recorded;
}

export function tapRecording(message: SDKMessage, names: Map<string, string>, c: QueryContext): void {
	if (
		(message.type === "assistant" &&
			message.parent_tool_use_id === null &&
			message.message.model !== "<synthetic>") ||
		(message.type === "stream_event" &&
			message.parent_tool_use_id === null &&
			["content_block_start", "content_block_delta"].includes(message.event.type))
	) {
		c.recording.assistantObserved();
		if (c.turnOpener) incorporate(c, c.turnOpener);
		c.turnOpener = undefined;
	}
	if (message.type === "result") c.turnOpener = c.pendingSteerUuids.values().next().value;
	if (message.type === "user" && message.parent_tool_use_id === null && message.uuid) {
		if ("isReplay" in message && message.isReplay === true) incorporate(c, message.uuid);
		if (Array.isArray(message.message.content))
			for (const block of message.message.content) {
				if (block.type === "tool_result") c.recording.result(block.tool_use_id, message.uuid);
			}
	}
	if (
		message.type !== "assistant" ||
		message.parent_tool_use_id !== null ||
		message.message.model === "<synthetic>" ||
		message.aborted
	)
		return;
	const id = message.message.id;
	let step = c.assistantSteps.get(id);
	if (!step) {
		step = { content: [], seen: new Set() };
		c.assistantSteps.set(id, step);
	}
	if (step.seen.has(message.uuid)) return;
	step.seen.add(message.uuid);
	if (!step.emitted) c.lastAssistantMessageId = id;
	for (const block of message.message.content) {
		if (block.type === "text" && block.text) step.content.push({ type: "text", text: block.text });
		else if (block.type === "thinking")
			step.content.push({ type: "thinking", thinking: block.thinking, thinkingSignature: block.signature });
		else if (block.type === "tool_use") {
			const name = piToolNameFor(block.name, names);
			if (name)
				step.content.push({
					type: "toolCall",
					id: block.id,
					name,
					arguments: mapToolArgs(name, block.input as Record<string, unknown>),
				} as AssistantMessage["content"][number]);
		}
	}
	step.uuid = message.uuid;
	completeAssistantRecording(c, step);
}

export function finalizeCurrentStream(c: QueryContext): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	if (!c.turnStarted) ensureTurnStarted(c);
	if (c.turnOutput.stopReason === "error") {
		endCurrentPiStream(c, { type: "error", reason: "error", error: c.turnOutput });
	} else {
		const reason = c.turnOutput.stopReason === "length" ? "length" : "stop";
		recordAssistantEmission(c);
		endCurrentPiStream(c, { type: "done", reason, message: c.turnOutput });
	}
}

export function processStreamEvent(
	message: SDKMessage,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	c: QueryContext,
): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	c.turnSawStreamEvent = true;
	const event = (message as SDKMessage & { event: any }).event;

	if (event?.type === "message_start") {
		if (c.turnStreamOpen) dropAbandonedStreamBlocks(c);
		c.turnToolCallIds = [];
		c.turnStreamMessageId = event.message?.id;
		if (c.turnStreamMessageId && !c.turnAssistantIds.includes(c.turnStreamMessageId))
			c.turnAssistantIds.push(c.turnStreamMessageId);
		c.turnStreamOpen = true;
		c.turnStreamBlockStart = c.turnBlocks.length;
		if (event.message?.usage) recordUsage(c.turnOutput, event.message.usage, model);
		return;
	}

	if (event?.type === "content_block_start") {
		ensureTurnStarted(c);
		if (event.content_block?.type === "text") {
			c.turnBlocks.push({ type: "text", text: "", index: event.index });
			c.currentPiStream!.push({ type: "text_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnMessage });
		} else if (event.content_block?.type === "thinking") {
			c.turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
			c.currentPiStream!.push({
				type: "thinking_start",
				contentIndex: c.turnBlocks.length - 1,
				partial: c.turnMessage,
			});
		} else if (event.content_block?.type === "tool_use") {
			const piName = piToolNameFor(event.content_block.name, customToolNameToPi);
			if (!piName) {
				return;
			}
			c.turnToolCallIds.push(event.content_block.id);
			c.turnBlocks.push({
				type: "toolCall",
				id: event.content_block.id,
				name: piName,
				arguments: (event.content_block.input as Record<string, unknown>) ?? {},
				partialJson: "",
				index: event.index,
			});
			c.currentPiStream!.push({
				type: "toolcall_start",
				contentIndex: c.turnBlocks.length - 1,
				partial: c.turnMessage,
			});
		}
		return;
	}

	if (event?.type === "content_block_delta") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		if (event.delta?.type === "text_delta" && block.type === "text") {
			block.text += event.delta.text;
			c.currentPiStream!.push({
				type: "text_delta",
				contentIndex: index,
				delta: event.delta.text,
				partial: c.turnMessage,
			});
		} else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
			block.thinking += event.delta.thinking;
			c.currentPiStream!.push({
				type: "thinking_delta",
				contentIndex: index,
				delta: event.delta.thinking,
				partial: c.turnMessage,
			});
		} else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
			block.partialJson += event.delta.partial_json;
			block.arguments = parsePartialJson(block.partialJson, block.arguments);
			c.currentPiStream!.push({
				type: "toolcall_delta",
				contentIndex: index,
				delta: event.delta.partial_json,
				partial: c.turnMessage,
			});
		} else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
			block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
		}
		return;
	}

	if (event?.type === "content_block_stop") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		delete block.index;
		if (block.type === "text") {
			c.currentPiStream!.push({
				type: "text_end",
				contentIndex: index,
				content: block.text,
				partial: c.turnMessage,
			});
		} else if (block.type === "thinking") {
			c.currentPiStream!.push({
				type: "thinking_end",
				contentIndex: index,
				content: block.thinking,
				partial: c.turnMessage,
			});
		} else if (block.type === "toolCall") {
			c.turnSawToolCall = true;
			const finished = c.assistantSteps
				.get(c.turnStreamMessageId!)
				?.content.find(
					(b): b is Extract<typeof b, { type: "toolCall" }> => b.type === "toolCall" && b.id === block.id,
				);
			if (finished) block.arguments = { ...finished.arguments };
			else {
				block.arguments = mapToolArgs(block.name, parsePartialJson(block.partialJson, block.arguments));
			}
			delete block.partialJson;
			c.currentPiStream!.push({
				type: "toolcall_end",
				contentIndex: index,
				toolCall: block,
				partial: c.turnMessage,
			});
		}
		return;
	}

	if (event?.type === "message_delta") {
		c.turnOutput.stopReason = mapStopReason(event.delta?.stop_reason);
		if (event.usage) recordUsage(c.turnOutput, event.usage, model);
		return;
	}

	if (event?.type === "message_stop") {
		dropUnfinishedStreamBlocks(c);
		c.turnStreamOpen = false;
	}

	if (event?.type === "message_stop" && c.turnSawToolCall) {
		endToolUseTurn(c);
		return;
	}
}

function dropUnfinishedStreamBlocks(c: QueryContext): void {
	let dropped = 0;
	for (let i = c.turnBlocks.length - 1; i >= c.turnStreamBlockStart; i--) {
		if (c.turnBlocks[i].index === undefined) continue;
		dropped++;
		c.turnBlocks.splice(i, 1);
	}
	if (!dropped) return;
	c.turnToolCallIds = c.turnBlocks.filter((b: any) => b.type === "toolCall").map((b: any) => b.id);
	c.turnSawToolCall = c.turnBlocks.some((b: any) => b.type === "toolCall");
}

function dropAbandonedStreamBlocks(c: QueryContext): void {
	c.turnBlocks.splice(c.turnStreamBlockStart);
	c.turnAssistantIds = c.turnAssistantIds.filter((id) => id !== c.turnStreamMessageId);
	c.turnToolCallIds = [];
	c.turnSawToolCall = c.turnBlocks.some((b: any) => b.type === "toolCall");
	c.turnStreamOpen = false;
}

export function processAssistantMessage(
	message: SDKMessage,
	model: Model<any>,
	customToolNameToPi: Map<string, string>,
	c: QueryContext,
): void {
	const assistantMsg = (message as any).message;
	if (!assistantMsg?.content) return;
	if (assistantMsg.model === "<synthetic>") {
		if (c.turnSawStreamEvent && c.turnStreamOpen) dropAbandonedStreamBlocks(c);
		for (const block of assistantMsg.content) {
			if (block.type === "text" && block.text) c.turnBlocks.push({ type: "text", text: block.text });
		}
		if (assistantMsg.usage && c.turnOutput) recordUsage(c.turnOutput, assistantMsg.usage, model);
		return;
	}
	const id = assistantMsg.id;
	if (c.turnSawStreamEvent && (!id || id !== c.turnFallbackMessageId)) {
		if (!id || !c.turnStreamMessageId || id === c.turnStreamMessageId) return;
		if (c.turnStreamOpen) dropAbandonedStreamBlocks(c);
		c.turnFallbackMessageId = id;
	}
	if (id !== c.turnStreamMessageId) {
		c.turnStreamMessageId = id;
		if (id && !c.turnAssistantIds.includes(id)) c.turnAssistantIds.push(id);
		c.turnToolCallIds = [];
	}
	for (const block of assistantMsg.content) {
		if (block.type === "text" && block.text) {
			pushTextBlock(c, block.text);
		} else if (block.type === "thinking") {
			ensureTurnStarted(c);
			c.turnBlocks.push({
				type: "thinking",
				thinking: block.thinking ?? "",
				thinkingSignature: block.signature ?? "",
			});
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "thinking_start", contentIndex: idx, partial: c.turnMessage });
			if (block.thinking)
				c.currentPiStream?.push({
					type: "thinking_delta",
					contentIndex: idx,
					delta: block.thinking,
					partial: c.turnMessage,
				});
			c.currentPiStream?.push({
				type: "thinking_end",
				contentIndex: idx,
				content: block.thinking ?? "",
				partial: c.turnMessage,
			});
		} else if (block.type === "tool_use") {
			const piName = piToolNameFor(block.name, customToolNameToPi);
			if (!piName) {
				continue;
			}
			ensureTurnStarted(c);
			c.turnSawToolCall = true;
			c.turnToolCallIds.push(block.id);
			c.turnBlocks.push({
				type: "toolCall",
				id: block.id,
				name: piName,
				arguments: mapToolArgs(piName, block.input),
			});
			const idx = c.turnBlocks.length - 1;
			const toolBlock = c.turnBlocks[idx];
			c.currentPiStream?.push({ type: "toolcall_start", contentIndex: idx, partial: c.turnMessage });
			c.currentPiStream?.push({
				type: "toolcall_end",
				contentIndex: idx,
				toolCall: toolBlock as any,
				partial: c.turnMessage,
			});
		}
	}
	if (assistantMsg.usage && c.turnOutput) recordUsage(c.turnOutput, assistantMsg.usage, model);

	if (c.turnSawToolCall && c.currentPiStream && c.turnOutput) endToolUseTurn(c);
}
