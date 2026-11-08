import type { Message as PiMessage } from "@earendil-works/pi-ai";
import type { Message as SessionMessage, ToolResultBlock } from "cc-session-io";
import { MCP_TOOL_PREFIX } from "./mcp-server.js";

export const PROVIDER_ID = "claude-bridge";

export function sanitizeToolId(id: string, cache: Map<string, string>): string {
	const existing = cache.get(id);
	if (existing) return existing;
	const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	cache.set(id, clean);
	return clean;
}

function mapPiToolNameToSdk(name: string, customToolNameToSdk: ReadonlyMap<string, string> = new Map()): string {
	if (!name) return "";
	const normalized = name.toLowerCase();
	if (normalized.startsWith(MCP_TOOL_PREFIX)) {
		throw new Error(`mapPiToolNameToSdk: "${name}" is already an SDK tool name — pi history holds pi tool names`);
	}
	return customToolNameToSdk.get(name) ?? customToolNameToSdk.get(normalized) ?? `${MCP_TOOL_PREFIX}${name}`;
}

export function messageContentToText(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	let hasText = false;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			parts.push(block.text);
			hasText = true;
		} else if (block.type !== "text" && block.type !== "image") {
			parts.push(`[${block.type}]`);
		}
	}
	return hasText ? parts.join("\n") : "";
}

function toolResultContent(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string | Array<Record<string, unknown>> {
	if (typeof content === "string" || !Array.isArray(content)) return messageContentToText(content) || "";
	const images = content.filter((b) => b.type === "image" && b.data && b.mimeType);
	if (!images.length) return messageContentToText(content) || "";
	const blocks: Array<Record<string, unknown>> = [];
	for (const block of content) {
		if (block.type === "text" && block.text) blocks.push({ type: "text", text: block.text });
		else if (block.type === "image" && block.data && block.mimeType) {
			blocks.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
		} else if (block.type !== "text" && block.type !== "image") {
			blocks.push({ type: "text", text: `[${block.type}]` });
		}
	}
	return blocks;
}

function nonEmptyToolResultContent(
	msg: Extract<PiMessage, { role: "toolResult" }>,
	customToolNameToSdk: ReadonlyMap<string, string>,
): string | Array<Record<string, unknown>> {
	const content = toolResultContent(msg.content);
	if (typeof content !== "string" || content.trim()) return content;
	return msg.isError
		? "Command failed with no output"
		: `(${mapPiToolNameToSdk(msg.toolName, customToolNameToSdk)} completed with no output)`;
}

export function convertPiMessages(
	messages: PiMessage[],
	customToolNameToSdk: ReadonlyMap<string, string> = new Map(),
	recorded: ReadonlyMap<string, ToolResultBlock> = new Map(),
): { anthropicMessages: SessionMessage[]; sanitizedIds: Map<string, string>; origins: number[][] } {
	const anthropicMessages: SessionMessage[] = [];
	const sources = new Map<SessionMessage, number[]>();
	const append = (message: SessionMessage, index: number) => {
		anthropicMessages.push(message);
		sources.set(message, [index]);
	};
	const sanitizedIds = new Map();
	let turnResults: { role: "user"; content: Array<ToolResultBlock | Record<string, unknown>> } | null = null;
	let turnAssistantIdx: number | null = null;

	for (const [piIndex, msg] of messages.entries()) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				append({ role: "user", content: msg.content || "[empty]" }, piIndex);
			} else if (Array.isArray(msg.content)) {
				const parts = [];
				for (const block of msg.content) {
					if (block.type === "text" && block.text) parts.push({ type: "text", text: block.text });
					else if (block.type === "image" && block.data && block.mimeType) {
						parts.push({
							type: "image",
							source: { type: "base64", media_type: block.mimeType, data: block.data },
						});
					}
				}
				append({ role: "user", content: parts.length ? parts : "[image]" } as SessionMessage, piIndex);
			} else {
				append({ role: "user", content: "[empty]" }, piIndex);
			}
		} else if (msg.role === "assistant") {
			const content = Array.isArray(msg.content) ? msg.content : [];
			const blocks = [];
			for (const block of content) {
				if (block.type === "text" && block.text) {
					blocks.push({ type: "text", text: block.text });
				} else if (block.type === "thinking") {
					const sig = block.thinkingSignature;
					if (msg.provider === PROVIDER_ID && sig) {
						blocks.push({ type: "thinking", thinking: block.thinking ?? "", signature: sig });
					}
				} else if (block.type === "toolCall") {
					const toolName = mapPiToolNameToSdk(block.name, customToolNameToSdk);
					blocks.push({
						type: "tool_use",
						id: sanitizeToolId(block.id, sanitizedIds),
						name: toolName,
						input: block.arguments ?? {},
					});
				}
			}
			if (!content.length) continue;
			if (!blocks.length) blocks.push({ type: "text", text: "[incompatible content omitted]" });
			turnResults = null;
			turnAssistantIdx = anthropicMessages.length;
			append({ role: "assistant", content: blocks } as SessionMessage, piIndex);
		} else if (msg.role === "toolResult") {
			const id = sanitizeToolId(msg.toolCallId, sanitizedIds);
			const block = recorded.get(msg.toolCallId) ?? {
				type: "tool_result",
				tool_use_id: id,
				content: nonEmptyToolResultContent(msg, customToolNameToSdk),
				...(msg.isError ? { is_error: true } : {}),
			};
			if (turnResults) {
				turnResults.content.push(block);
				sources.get(turnResults as unknown as SessionMessage)!.push(piIndex);
			} else {
				turnResults = { role: "user", content: [block] };
				sources.set(turnResults as unknown as SessionMessage, [piIndex]);
				anthropicMessages.splice(
					turnAssistantIdx === null ? anthropicMessages.length : turnAssistantIdx + 1,
					0,
					turnResults as unknown as SessionMessage,
				);
			}
		}
	}

	return { anthropicMessages, sanitizedIds, origins: anthropicMessages.map((message) => sources.get(message)!) };
}
