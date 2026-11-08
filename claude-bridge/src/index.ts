import { createAssistantMessageEventStream, getCurrentSystemMessage, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, type Context, type ImageContent, type Model, type SimpleStreamOptions, type TextContent, type Tool, type UserMessage } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { isToolCallEventType, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { query, type EffortLevel, type SDKMessage, type SettingSource, type ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";
import type { Base64ImageSource, ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { createSession, deleteSession, getSessionPath } from "cc-session-io";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync } from "fs";
import { dirname } from "path";
import { PROVIDER_ID, messageContentToText } from "./convert.js";
import { QueryProcess } from "./query-process.js";
import { readTranscript, recordedToolResults, resolveRecordingCut, savePrefixSession } from "./session-transcript.js";
import { debugLogPath, diagLogPath } from "./log-paths.js";
import { buildModels, claudeCodeModelId } from "./models.js";
import { verifyWrittenSession as _verifyWrittenSession } from "./session-verify.js";
import { extractAllToolResults as _extractAllToolResults, type McpResult } from "./extract-tool-results.js";
import { digestMessage, digestMessages } from "./message-digests.js";
import { compareHistory, copyRecording, importHistory, LiveRecording, type Recording, type SessionState } from "./session-sync.js";
import { deleteSessionState, loadSessionState, saveSessionState } from "./session-store.js";
import { newAssistantOutput, QueryContext, type AssistantStep } from "./query-state.js";
import { makePromptStream, userMessage, type PromptStream } from "./prompt-stream.js";
import { claudeCodeAppend } from "./prompt.js";
import { collectCarriedAttachments } from "./attachments.js";
import { createToolServer, MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "./mcp-server.js";
import { nonSystemMessages, toBridgeContext } from "./transcript.js";
import { updateUsage, type SdkUsage } from "./usage.js";
import { rateLimitResponse } from "./rate-limit.js";
import { DEBUG, debug, makeCliDebugOptions, moduleInstanceId } from "./debug.js";
import { ccChildEnv, CLAUDE_MD_EXCLUDES, errorMessage, REASONING_TO_EFFORT, resultErrorText } from "./cc-child.js";

function diagDump(label: string, data: Record<string, unknown>) {
	const ts = new Date().toISOString();
	const entry = { ts, moduleInstanceId, label, ...data };
	const logPath = diagLogPath();
	mkdirSync(dirname(logPath), { recursive: true });
	appendFileSync(logPath, JSON.stringify(entry) + "\n");
	debug(`DIAG: ${label} (see ${logPath})`);
}

const MODELS = buildModels(getModels("anthropic"));

const sharedSessions = new Map<string, SessionState>();
const loadedSessionStates = new Set<string>();
const sessionWriters = new Map<string, Promise<void>>();

let sessionCwd: string | null = null;

function currentCwd(): string {
	if (!sessionCwd) throw new Error("claude-bridge: no pi session has started");
	return sessionCwd;
}

function sessionStateFor(piSessionId: string | null | undefined): SessionState | null {
	if (piSessionId == null) return null;
	if (!loadedSessionStates.has(piSessionId)) {
		const stored = loadSessionState(piSessionId, (message) => diagDump("session_state_rejected", { piSessionId, message }));
		loadedSessionStates.add(piSessionId);
		if (stored) sharedSessions.set(piSessionId, stored);
	}
	return sharedSessions.get(piSessionId) ?? null;
}

function inheritSessionState(parentFile: string, piSessionId: string): void {
	let text: string;
	try { text = readFileSync(parentFile, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const header = JSON.parse(text.split("\n", 1)[0]);
	if (header?.type !== "session" || typeof header.id !== "string") throw new Error(`no session header in ${parentFile}`);
	const parent = sessionStateFor(header.id);
	if (!parent) return;
	setSessionStateFor(piSessionId, { ...parent, ...copyRecording(parent), dirtyTail: true });
	debug(`session_start:fork: inherited ${parent.ccSessionId} from piSession=${header.id} ${sessionTag(piSessionId)}`);
}

function setSessionStateFor(piSessionId: string, state: SessionState | null): void {
	loadedSessionStates.add(piSessionId);
	if (state === null) sharedSessions.delete(piSessionId);
	else sharedSessions.set(piSessionId, state);
}

const historyRewrittenBySession = new Set<string>();

function markRebuildForSession(piSession: string | null, event: string): void {
	const state = piSession != null ? sharedSessions.get(piSession) : undefined;
	if (!state) {
		debug(`${event}: history rewritten, no session to mark yet ${sessionTag(piSession)}`);
	} else {
		state.dirtyTail = true;
		debug(`${event}: marking dirtyTail on session ${state.ccSessionId.slice(0, 8)} ${sessionTag(piSession)}`);
	}
	if (piSession) historyRewrittenBySession.add(piSession);
	armStaleContexts();
}

function armStaleContexts(): void {
	for (const c of activeQueryContexts) {
		if (c.piSessionId && historyRewrittenBySession.has(c.piSessionId)) c.historyStale = true;
	}
}

function extractAllToolResults(context: Context): McpResult[] {
	const results = _extractAllToolResults(context.messages as unknown as Array<{ role: string; [key: string]: unknown }>);
	if (DEBUG) {
		debug(`extractAllToolResults: ${results.length} results from ${context.messages.length} msgs`);
		debug(`extractAllToolResults: all msg roles:`, context.messages.map((m, i) => `[${i}]${m.role}`).join(" "));
		for (let r = 0; r < results.length; r++) {
			debug(`extractAllToolResults: result[${r}] id=${results[r].toolCallId}${results[r].isError ? " ERROR" : ""} preview:`, JSON.stringify(results[r].content).slice(0, 150));
		}
	}
	return results;
}

function turnStart(messages: Context["messages"]): number {
	let i = messages.length;
	while (i > 0 && messages[i - 1].role === "user") i--;
	return i;
}

function extractUserPrompt(messages: Context["messages"]): string | null {
	const turn = messages.slice(turnStart(messages)) as UserMessage[];
	if (turn.length === 0) return null;
	return turn
		.map((m) => (typeof m.content === "string" ? m.content : messageContentToText(m.content)))
		.filter((text) => text)
		.join("\n");
}

function extractUserPromptBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	const turn = messages.slice(turnStart(messages)) as UserMessage[];
	if (turn.length === 0) return null;

	let hasImage = false;
	const blocks: ContentBlockParam[] = [];
	for (const message of turn) {
		const content: (TextContent | ImageContent)[] = typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content;
		if (!Array.isArray(content)) {
			throw new Error(
				`extractUserPromptBlocks: user message content must be a string or block array, got ${typeof content} — likely a malformed message from another extension`,
			);
		}
		for (const block of content) {
			if (block.type === "text" && block.text) {
				blocks.push({ type: "text", text: block.text });
			} else if (block.type === "image") {
				if (!block.data || !block.mimeType) {
					debug(`image block missing data or mimeType, skipping: keys=${Object.keys(block).join(",")}`);
					continue;
				}
				debug(`image block: mimeType=${block.mimeType}, data length=${block.data.length}`);
				hasImage = true;
				blocks.push({
					type: "image",
					source: {
						type: "base64",
						media_type: block.mimeType as Base64ImageSource["media_type"],
						data: block.data,
					},
				});
			}
		}
	}
	debug(`extractUserPromptBlocks: ${turn.length} msgs in turn, ${blocks.length} blocks, types=${blocks.map((b) => b.type).join(",")}`);
	return hasImage ? blocks : null;
}

function describeRateLimitFailure(rejection: { rateLimitType?: string; resetsAt?: number }, failure: string): string {
	const kind = rejection.rateLimitType ? ` (${rejection.rateLimitType})` : "";
	const resets = rejection.resetsAt ? ` — resets ${new Date(rejection.resetsAt * 1000).toLocaleTimeString()}` : "";
	return `Claude quota exceeded — rate limit${kind}${resets}: ${failure}`;
}

async function reportHeldRateLimit(c: QueryContext, model: Model<any>): Promise<void> {
	const info = c.heldRateLimit;
	if (!info || !c.currentPiStream || !c.currentOnResponse) return;
	c.heldRateLimit = undefined;
	try {
		await c.currentOnResponse(rateLimitResponse(info), model);
	} catch (error) {
		debug("rate limit: onResponse failed", error);
	}
}

function isolatedStreamFn(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void runIsolatedSummary(model, context, options, stream);
	return stream;
}

async function runIsolatedSummary(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	let sdkQuery: ReturnType<typeof query> | undefined;
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		void sdkQuery?.interrupt().catch(() => {});
		try { sdkQuery?.close(); } catch {}
	};

	try {
		const promptText = extractUserPrompt(context.messages);
		if (!promptText) throw new Error("runIsolatedSummary: one-off summary without a user prompt (last message is not user?)");
		const cwd = currentCwd();
		const cliModel = claudeCodeModelId(model);
		const effort = effortForReasoning(model, options?.reasoning);
		const thinking = thinkingForReasoning(model, options?.reasoning);
		debug(`compact summary: spawn model=${cliModel} registeredModel=${model.id} effort=${effort ?? "default"}${thinking ? " thinking=disabled" : ""} promptLen=${promptText.length}`);

		sdkQuery = query({
			prompt: promptText,
			options: {
				cwd,
				env: ccChildEnv(options?.env),
				settings: { autoMemoryEnabled: false },
				tools: [],
				strictMcpConfig: true,
				settingSources: [] as SettingSource[],
				skills: [],
				persistSession: false,
				systemPrompt: context.systemPrompt,
				model: cliModel,
				maxTurns: 1,
				...(effort ? { effort } : {}),
				...(thinking ? { thinking } : {}),
				...makeCliDebugOptions("compact-summary"),
			},
		});

		if (options?.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		let assistantText = "";
		let finalText = "";
		let errorText: string | undefined;
		let firstEventLogged = false;

		for await (const message of sdkQuery) {
			if (!firstEventLogged) {
				debug(`compact summary: first event type=${message.type}`);
				firstEventLogged = true;
			}
			if (wasAborted) break;

			if (message.type === "assistant") {
				for (const block of (message as any).message?.content ?? []) {
					if (block.type === "text" && typeof block.text === "string") assistantText += block.text;
				}
			} else if (message.type === "result") {
				logServedContextWindow("compact summary", message, model);
				errorText = resultErrorText(message);
				if (!errorText && message.subtype === "success") finalText = message.result || assistantText;
			}
		}

		if (wasAborted) {
			const output = newAssistantOutput(model, "", "aborted", "Operation aborted");
			debug("compact summary: aborted");
			endStream(stream, { type: "error", reason: "aborted", error: output });
			return;
		}

		const text = finalText || assistantText;
		if (errorText || !text.trim()) {
			const msg = errorText ?? "Claude Code summary returned empty text";
			debug(`compact summary: error ${msg}`);
			endStream(stream, { type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
			return;
		}

		debug(`compact summary: done textLen=${text.length}`);
		endStream(stream, { type: "done", reason: "stop", message: newAssistantOutput(model, text, "stop") });
	} catch (err) {
		const msg = errorMessage(err);
		debug("runIsolatedSummary threw; pushing terminal error", err);
		endStream(stream, { type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
	} finally {
		options?.signal?.removeEventListener("abort", onAbort);
		try { sdkQuery?.close(); } catch {}
	}
}

interface SyncResult {
	sessionId: string | null;
	targetSessionId: string;
	created: boolean;
	forkAt?: string;
	recorded: Recording;
	state: SessionState | null;
}

async function waitForSessionWriter(sessionId: string | undefined, signal?: AbortSignal): Promise<void> {
	const exited = sessionId ? sessionWriters.get(sessionId) : undefined;
	if (!exited) return;
	signal?.throwIfAborted();
	if (!signal) return exited;
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		void exited.then(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		});
	});
}
function prefixRecording(recorded: Recording, count: number): Recording {
	return { digests: recorded.digests.slice(0, count), uuids: recorded.uuids.slice(0, count), cuttable: recorded.cuttable.slice(0, count) };
}

function verifyWrittenSession(
	jsonlPath: string,
	expectedSessionId: string,
	expectedRecordCount: number,
	cwd: string,
): void {
	const warnings = _verifyWrittenSession(jsonlPath, expectedSessionId, expectedRecordCount);
	for (const msg of warnings) {
		debug(`WARNING session verify: ${msg}`);
		piUI?.notify(
			`Session file issue: ${msg}\n` +
			`cwd=${cwd} realpath=${safeRealpath(cwd)} CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"}\n` +
			`Please copy and paste this message into a new issue at https://github.com/elidickinson/pi-claude-bridge/issues/new` +
			(DEBUG ? ` and attach ${debugLogPath()}` : ` (rerun with CLAUDE_BRIDGE_DEBUG=1 to capture a debug log)`),
			"warning",
		);
		diagDump("session_verify_fail", { msg, jsonlPath, cwd, realpath: safeRealpath(cwd), claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null });
	}
}

function safeRealpath(p: string): string {
	try { return realpathSync(p); } catch (e) { return `<failed: ${(e as Error).message}>`; }
}

function debugSessionPaths(label: string, cwd: string, jsonlPath: string): void {
	if (!DEBUG) return;
	const realCwd = safeRealpath(cwd);
	let fileSize: number | null = null;
	let fileExists = false;
	try {
		const st = statSync(jsonlPath);
		fileExists = true;
		fileSize = st.size;
	} catch {  }
	debug(`${label}: cwd=${cwd}`);
	if (realCwd !== cwd) debug(`${label}: realpath(cwd)=${realCwd} (DIFFERS — symlink-resolved path is what CC SDK uses)`);
	debug(`${label}: jsonlPath=${jsonlPath}`);
	debug(`${label}: fileExists=${fileExists}${fileSize != null ? ` size=${fileSize}` : ""}`);
	debug(`${label}: env.CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"} HOME=${process.env.HOME ?? "(unset)"}`);
}

function syncSharedSession(
	messages: Context["messages"],
	cwd: string,
	customToolNameToSdk: Map<string, string>,
	modelId: string,
	piSessionId: string | null,
	promptDigest: string,
): SyncResult {
	let state = sessionStateFor(piSessionId);
	const before = state;
	const history = nonSystemMessages(messages);
	const priors = history.slice(0, turnStart(history));
	const compared = state ? compareHistory(digestMessages(priors), state) : { commonPrefix: 0, cutCount: 0, equal: false };
	let missingFile = false;
	if (state) {
		try { statSync(getSessionPath(state.ccSessionId, state.cwd, process.env.CLAUDE_CONFIG_DIR)); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			missingFile = true;
			debug(`sync: missing transcript ${state.ccSessionId} in recorded cwd=${state.cwd}; importing pi history`);
			setSessionStateFor(piSessionId!, null);
			deleteSessionState(piSessionId!);
			state = null;
		}
	}
	const cwdChanged = Boolean(state && safeRealpath(state.cwd) !== safeRealpath(cwd));
	const promptChanged = Boolean(state && state.promptDigest !== promptDigest);
	if (promptChanged) debug(`sync: system prompt append changed; importing pi history ${sessionTag(piSessionId)}`);
	const row = piSessionId == null ? 0 : !state ? (priors.length ? 2 : 1) : state.model !== modelId || promptChanged ? 3
		: cwdChanged ? 5
		: compared.equal && !state.dirtyTail ? 4 : !compared.cutCount ? 5 : compared.cutCount === priors.length ? 6 : 7;
	const reason = piSessionId == null ? "unattributed-history" : missingFile ? "missing-transcript" : !state ? "no-state"
		: state.model !== modelId ? "model-changed" : promptChanged ? "prompt-changed" : cwdChanged ? "cwd-changed"
		: row === 4 ? "equal-digests" : state.dirtyTail && compared.equal ? "dirty-tail" : "history-difference";
	const decision = (path: string, after: string) => {
		debug(`syncResult: path=${path} sessionId=${after} from=${before?.ccSessionId ?? "none"} priors=${priors.length} commonPrefix=${compared.commonPrefix} cutCount=${compared.cutCount} row=${row} reason=${reason} ${sessionTag(piSessionId)}`);
	};
	if (row === 4) {
		decision("reuse", state!.ccSessionId);
		return { sessionId: state!.ccSessionId, targetSessionId: state!.ccSessionId, created: false, recorded: copyRecording(state!), state };
	}
	const session = createSession({ projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR, model: modelId });
	const targetSessionId = session.sessionId;
	let recorded: Recording;
	let records = 0;
	if (row === 6 || row === 7) {
		const transcript = readTranscript(state!);
		const cut = resolveRecordingCut(transcript, state!, compared.cutCount);
		recorded = prefixRecording(state!, compared.cutCount);
		if (row === 6) {
			decision("fork", targetSessionId);
			return { sessionId: state!.ccSessionId, targetSessionId, created: true, forkAt: cut.uuid, recorded, state };
		}
		const rest = priors.slice(compared.cutCount);
		const replaced = transcript.slice(cut.index + 1);
		const suffix = importHistory(session, rest, customToolNameToSdk, collectCarriedAttachments(replaced), recordedToolResults(replaced, state!.digests, rest));
		recorded = { digests: [...recorded.digests, ...suffix.digests], uuids: [...recorded.uuids, ...suffix.uuids], cuttable: [...recorded.cuttable, ...suffix.cuttable] };
		records = savePrefixSession(session, transcript.slice(0, cut.index + 1), cut.uuid);
	} else {
		const transcript = state ? readTranscript(state) : [];
		recorded = importHistory(session, priors, customToolNameToSdk, collectCarriedAttachments(transcript), recordedToolResults(transcript, state?.digests ?? [], priors));
		session.save();
		records = session.records.length;
	}
	if (records) verifyWrittenSession(session.jsonlPath, targetSessionId, records, cwd);
	decision(row === 7 ? "prefix-write" : records ? "rebuild" : "clean-start", targetSessionId);
	debugSessionPaths(targetSessionId.slice(0, 8), cwd, session.jsonlPath);
	return { sessionId: records ? targetSessionId : null, targetSessionId, created: true, recorded, state };
}



function piToolNameFor(name: string, customToolNameToPi: Map<string, string>): string | undefined {
	return customToolNameToPi.get(name) ?? customToolNameToPi.get(name.toLowerCase());
}

const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
	read:  { file_path: "path" },
	write: { file_path: "path" },
	edit:  { file_path: "path", old_string: "oldText", new_string: "newText", old_text: "oldText", new_text: "newText" },
};

function mapToolArgs(
	toolName: string, args: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const input = args ?? {};
	const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		const piKey = renames?.[key] ?? key;
		if (!(piKey in result)) result[piKey] = value;
	}
	if (toolName.toLowerCase() === "edit") {
		const single = (value: unknown): boolean => Boolean(value && typeof value === "object"
			&& typeof (value as Record<string, unknown>).oldText === "string" && typeof (value as Record<string, unknown>).newText === "string");
		if (typeof result.edits === "string") {
			try {
				const parsed: unknown = JSON.parse(result.edits);
				if (Array.isArray(parsed)) result.edits = parsed;
				else if (single(parsed)) result.edits = [parsed];
			} catch {  }
		} else if (single(result.edits)) result.edits = [result.edits];
	}
	return result;
}

let piUI: ExtensionUIContext | null = null;
const activeQueryContexts = new Set<QueryContext>();



async function closeSessionQueries(piSessionId: string): Promise<void> {
	const closing = [...activeQueryContexts].filter((c) => c.piSessionId === piSessionId);
	for (const c of closing) {
		debug(
			`${c.activeQuery ? "session_shutdown: closing parked query" : "WARNING: session_shutdown left a context with no query"} — `
			+ `pendingToolCalls=${c.pendingToolCalls.size} promptStream=${c.promptStream !== null}`,
		);
		discardRewrittenQuery(c);
	}
	await Promise.allSettled(closing.map((c) => c.settled));
}

function contextForToolResults(results: McpResult[], piSessionId: string | null): QueryContext | undefined {
	for (const result of results) {
		const id = result.toolCallId;
		if (!id) continue;
		for (const queryCtx of activeQueryContexts) {
			if (queryCtx.piSessionId !== piSessionId) continue;
			if (queryCtx.pendingToolCalls.has(id) || queryCtx.pendingResults.has(id) || queryCtx.turnToolCallIds.includes(id)) {
				return queryCtx;
			}
		}
	}
	return undefined;
}

function resolveMcpTools(context: Context): {
	mcpTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	const mcpTools = context.tools ?? [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();
	for (const tool of mcpTools) {
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		customToolNameToSdk.set(tool.name, sdkName);
		customToolNameToSdk.set(tool.name.toLowerCase(), sdkName);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}

	return { mcpTools, customToolNameToSdk, customToolNameToPi };
}

function buildMcpServers(tools: Tool[], queryCtx: QueryContext): Record<string, ReturnType<typeof createToolServer>> | undefined {
	if (!tools.length) return undefined;
	const mcpTools = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters,
		handler: async (toolCallId: string) => {
			if (queryCtx.pendingResults.has(toolCallId)) {
				const result = queryCtx.pendingResults.get(toolCallId)!;
				queryCtx.pendingResults.delete(toolCallId);
				debug(`mcp handler: ${tool.name} [${toolCallId}] → resolved from queue (${queryCtx.pendingResults.size} remaining)`);
				return result;
			}
			debug(`mcp handler: ${tool.name} [${toolCallId}] → waiting`);
			return new Promise<McpResult>((resolve) => {
				queryCtx.pendingToolCalls.set(toolCallId, { toolName: tool.name, resolve });
			});
		},
	}));
	return { [MCP_SERVER_NAME]: createToolServer(MCP_SERVER_NAME, mcpTools) };
}

function sessionTag(piSessionId: string | null | undefined): string {
	return `piSession=${piSessionId ?? "none"}`;
}

function recordUsage(output: AssistantMessage, usage: SdkUsage, model: Model<any>, piSessionId: string | null): void {
	const { cachePct, reasoning } = updateUsage(output, usage, model);
	const reasoningText = reasoning == null ? "" : ` reasoning=${reasoning}`;
	debug(`usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} total=${output.usage.totalTokens}${reasoningText} cachePct=${cachePct}% model=${model.id} ${sessionTag(piSessionId)}`);
}

function logServedContextWindow(label: string, message: SDKMessage, model: Model<any>): void {
	if (!DEBUG) return;
	const modelUsage = (message as any).modelUsage as Record<string, { contextWindow?: number; maxOutputTokens?: number }> | undefined;
	if (!modelUsage) return;
	for (const [k, v] of Object.entries(modelUsage)) {
		debug(`${label}: served contextWindow=${v.contextWindow ?? "?"} maxOutputTokens=${v.maxOutputTokens ?? "?"} servedModel=${k} registered=${model.contextWindow}`);
	}
}

const VALID_EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

function effortForReasoning(model: Model<any>, reasoning: string | undefined): EffortLevel | undefined {
	if (!reasoning) return undefined;
	const mapped = model.thinkingLevelMap?.[reasoning];
	if (mapped === undefined) return REASONING_TO_EFFORT[reasoning];
	return VALID_EFFORTS.has(mapped as EffortLevel) ? mapped as EffortLevel : undefined;
}

function thinkingForReasoning(model: Model<any>, reasoning: string | undefined): ThinkingConfig | undefined {
	if (reasoning || !model.reasoning || model.thinkingLevelMap?.off === null) return undefined;
	return { type: "disabled" };
}

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use": return "toolUse";
		case "max_tokens": return "length";
		case "end_turn": default: return "stop";
	}
}

function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input) return fallback;
	try { return JSON.parse(input); } catch { return fallback; }
}

const completedStreams = new WeakSet<object>();

function endStream(stream: AssistantMessageEventStream, event: AssistantMessageEvent): void {
	stream.push(event);
	completedStreams.add(stream);
	stream.end();
}

function endCurrentPiStream(c: QueryContext, event: AssistantMessageEvent): void {
	endStream(c.currentPiStream!, event);
	c.currentPiStream = null;
}

function endToolUseTurn(c: QueryContext): void {
	c.turnOutput!.stopReason = "toolUse";
	recordAssistantEmission(c);
	endCurrentPiStream(c, { type: "done", reason: "toolUse", message: c.turnOutput! });
}

function pushTextBlock(c: QueryContext, text: string): void {
	ensureTurnStarted(c);
	c.turnBlocks.push({ type: "text", text });
	const idx = c.turnBlocks.length - 1;
	c.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: c.turnOutput });
	c.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: text, partial: c.turnOutput });
	c.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: text, partial: c.turnOutput });
}

function claimCurrentPiStream(stream: AssistantMessageEventStream, label: string, c: QueryContext, options: SimpleStreamOptions | undefined): void {
	if (c.currentPiStream && !completedStreams.has(c.currentPiStream as object)) {
		debug(`WARNING: currentPiStream overwritten before terminal event (${label}); activeQuery=${Boolean(c.activeQuery)} pendingHandlers=${c.pendingToolCalls.size}`);
	}
	c.currentPiStream = stream;
	c.currentOnResponse = options?.onResponse;
}

function ensureTurnStarted(c: QueryContext): void {
	if (!c.turnStarted && c.currentPiStream && c.turnOutput) {
		c.currentPiStream!.push({ type: "start", partial: c.turnOutput });
		c.turnStarted = true;
	}
}

function recordAssistantEmission(c: QueryContext): void {
	const output = c.turnOutput;
	if (!output || output.stopReason === "error" || output.stopReason === "aborted" || c.turnEmissionRecorded) return;
	c.turnEmissionRecorded = true;
	const id = c.turnStreamMessageId ?? c.lastAssistantMessageId;
	if (!id) {
		c.recording.gap();
		debug("recording gap: emitted assistant has no completed SDK message id");
		return;
	}
	let step = c.assistantSteps.get(id);
	if (!step) c.assistantSteps.set(id, step = { content: [], seen: new Set() });
	if (!step.emitted) {
		const digest = digestMessage(output);
		const toolCalls = output.content.filter((b) => b.type === "toolCall").map((b) => b.id);
		const ids = c.turnAssistantIds.length ? [...c.turnAssistantIds] : [id];
		step.emitted = { digest, index: c.recording.assistant(digest, toolCalls, undefined, output.content.length > 0), template: { ...output, content: [] }, ids };
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
	if (parts.every((part) => part?.uuid) && last?.uuid
		&& digestMessage({ ...step.emitted.template, content: parts.flatMap((part) => part!.content) }) === step.emitted.digest) {
		c.recording.completeAssistant(step.emitted.index, last.uuid);
	} else debug(`recording gap: emitted assistant is not fully covered by completed SDK messages (${step.emitted.ids.join(",")})`);
}

function incorporate(c: QueryContext, uuid: string): boolean {
	const recorded = c.recording.acknowledge(uuid);
	return c.pendingSteerUuids.delete(uuid) || recorded;
}

function tapRecording(message: SDKMessage, names: Map<string, string>, c: QueryContext): void {
	if ((message.type === "assistant" && message.parent_tool_use_id === null && message.message.model !== "<synthetic>")
		|| (message.type === "stream_event" && message.parent_tool_use_id === null && ["content_block_start", "content_block_delta"].includes(message.event.type))) {
		c.recording.assistantObserved();
		if (c.turnOpener && incorporate(c, c.turnOpener)) debug(`recording: turn opener ${c.turnOpener} was never replayed; its first output acknowledges it`);
		c.turnOpener = undefined;
	}
	if (message.type === "result") c.turnOpener = c.pendingSteerUuids.values().next().value;
	if (message.type === "user" && message.parent_tool_use_id === null && message.uuid) {
		if ("isReplay" in message && message.isReplay === true) incorporate(c, message.uuid);
		if (Array.isArray(message.message.content)) for (const block of message.message.content) {
			if (block.type === "tool_result") c.recording.result(block.tool_use_id, message.uuid);
		}
	}
	if (message.type !== "assistant" || message.parent_tool_use_id !== null || message.message.model === "<synthetic>" || message.aborted) return;
	const id = message.message.id;
	let step = c.assistantSteps.get(id);
	if (!step) c.assistantSteps.set(id, step = { content: [], seen: new Set() });
	if (step.seen.has(message.uuid)) return;
	step.seen.add(message.uuid);
	if (!step.emitted) c.lastAssistantMessageId = id;
	for (const block of message.message.content) {
		if (block.type === "text" && block.text) step.content.push({ type: "text", text: block.text });
		else if (block.type === "thinking") step.content.push({ type: "thinking", thinking: block.thinking, thinkingSignature: block.signature });
		else if (block.type === "tool_use") {
			const name = piToolNameFor(block.name, names);
			if (name) step.content.push({ type: "toolCall", id: block.id, name, arguments: mapToolArgs(name, block.input as Record<string, unknown>) } as AssistantMessage["content"][number]);
		}
	}
	step.uuid = message.uuid;
	completeAssistantRecording(c, step);
}

function finalizeCurrentStream(c: QueryContext): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	debug(`provider: finalizeCurrentStream called, turnOutput=${JSON.stringify({stopReason: c.turnOutput!.stopReason, error: c.turnOutput!.errorMessage})}`);
	if (!c.turnStarted) ensureTurnStarted(c);
	if (c.turnOutput.stopReason === "error") {
		endCurrentPiStream(c, { type: "error", reason: "error", error: c.turnOutput });
	} else {
		const reason = c.turnOutput.stopReason === "length" ? "length" : "stop";
		recordAssistantEmission(c);
		endCurrentPiStream(c, { type: "done", reason, message: c.turnOutput });
	}
}

function processStreamEvent(
	message: SDKMessage,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	c: QueryContext,
): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	c.turnSawStreamEvent = true;
	const event = (message as SDKMessage & { event: any }).event;

	if (event?.type === "message_start") {
		if (c.turnStreamOpen) dropAbandonedStreamBlocks(c, `restreamed as ${event.message?.id}`);
		c.turnToolCallIds = [];
		c.turnStreamMessageId = event.message?.id;
		if (c.turnStreamMessageId && !c.turnAssistantIds.includes(c.turnStreamMessageId)) c.turnAssistantIds.push(c.turnStreamMessageId);
		c.turnStreamOpen = true;
		c.turnStreamBlockStart = c.turnBlocks.length;
		if (event.message?.usage) recordUsage(c.turnOutput, event.message.usage, model, c.piSessionId);
		return;
	}

	if (event?.type === "content_block_start") {
		ensureTurnStarted(c);
		if (event.content_block?.type === "text") {
			c.turnBlocks.push({ type: "text", text: "", index: event.index });
			c.currentPiStream!.push({ type: "text_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else if (event.content_block?.type === "thinking") {
			c.turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
			c.currentPiStream!.push({ type: "thinking_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else if (event.content_block?.type === "tool_use") {
			const piName = piToolNameFor(event.content_block.name, customToolNameToPi);
			if (!piName) {
				debug(`processStreamEvent: skipping tool_use for unserved tool ${event.content_block.name} [${event.content_block.id}] — CC rejects it and retries`);
				return;
			}
			c.turnToolCallIds.push(event.content_block.id);
			c.turnBlocks.push({
				type: "toolCall", id: event.content_block.id,
				name: piName,
				arguments: (event.content_block.input as Record<string, unknown>) ?? {},
				partialJson: "", index: event.index,
			});
			c.currentPiStream!.push({ type: "toolcall_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else {
			debug("processStreamEvent: unhandled content_block_start type", event.content_block?.type);
		}
		return;
	}

	if (event?.type === "content_block_delta") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		if (event.delta?.type === "text_delta" && block.type === "text") {
			block.text += event.delta.text;
			c.currentPiStream!.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: c.turnOutput });
		} else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
			block.thinking += event.delta.thinking;
			c.currentPiStream!.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: c.turnOutput });
		} else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
			block.partialJson += event.delta.partial_json;
			block.arguments = parsePartialJson(block.partialJson, block.arguments);
			c.currentPiStream!.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: c.turnOutput });
		} else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
			block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
		} else {
			debug("processStreamEvent: unhandled content_block_delta type", event.delta?.type);
		}
		return;
	}

	if (event?.type === "content_block_stop") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		delete block.index;
		if (block.type === "text") {
			c.currentPiStream!.push({ type: "text_end", contentIndex: index, content: block.text, partial: c.turnOutput });
		} else if (block.type === "thinking") {
			c.currentPiStream!.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: c.turnOutput });
		} else if (block.type === "toolCall") {
			c.turnSawToolCall = true;
			const finished = c.assistantSteps.get(c.turnStreamMessageId!)?.content
				.find((b): b is Extract<typeof b, { type: "toolCall" }> => b.type === "toolCall" && b.id === block.id);
			if (finished) block.arguments = { ...finished.arguments };
			else {
				debug(`WARNING: Claude Code's finished tool_use ${block.id} did not arrive before content_block_stop; keeping the streamed arguments`);
				block.arguments = mapToolArgs(block.name, parsePartialJson(block.partialJson, block.arguments));
			}
			delete block.partialJson;
			c.currentPiStream!.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: c.turnOutput });
		}
		return;
	}

	if (event?.type === "message_delta") {
		c.turnOutput.stopReason = mapStopReason(event.delta?.stop_reason);
		if (event.usage) recordUsage(c.turnOutput, event.usage, model, c.piSessionId);
		return;
	}

	if (event?.type === "message_stop") {
		dropUnfinishedStreamBlocks(c, `message_stop for ${c.turnStreamMessageId}`);
		c.turnStreamOpen = false;
	}

	if (event?.type === "message_stop" && c.turnSawToolCall) {
		endToolUseTurn(c);
		return;
	}

	if (event?.type !== "message_stop" && event?.type !== "ping") {
		debug("processStreamEvent: unhandled event type", event?.type);
	}
}

function dropUnfinishedStreamBlocks(c: QueryContext, why: string): void {
	const dropped: string[] = [];
	for (let i = c.turnBlocks.length - 1; i >= c.turnStreamBlockStart; i--) {
		if (c.turnBlocks[i].index === undefined) continue;
		dropped.push(`${c.turnBlocks[i].type}${c.turnBlocks[i].id ? `[${c.turnBlocks[i].id}]` : ""}`);
		c.turnBlocks.splice(i, 1);
	}
	if (!dropped.length) return;
	debug(`dropUnfinishedStreamBlocks: ${why}; dropped ${dropped.reverse().join(",")}`);
	c.turnToolCallIds = c.turnBlocks.filter((b: any) => b.type === "toolCall").map((b: any) => b.id);
	c.turnSawToolCall = c.turnBlocks.some((b: any) => b.type === "toolCall");
}

function dropAbandonedStreamBlocks(c: QueryContext, why: string): void {
	const dropped = c.turnBlocks.splice(c.turnStreamBlockStart);
	c.turnAssistantIds = c.turnAssistantIds.filter((id) => id !== c.turnStreamMessageId);
	debug(`dropAbandonedStreamBlocks: ${why}; dropped ${dropped.length} blocks from ${c.turnStreamMessageId} types=${dropped.map((b: any) => b.type).join(",")}`);
	c.turnToolCallIds = [];
	c.turnSawToolCall = c.turnBlocks.some((b: any) => b.type === "toolCall");
	c.turnStreamOpen = false;
}

function processAssistantMessage(message: SDKMessage, model: Model<any>, customToolNameToPi: Map<string, string>, c: QueryContext): void {
	const assistantMsg = (message as any).message;
	if (!assistantMsg?.content) return;
	if (assistantMsg.model === "<synthetic>") {
		if (c.turnSawStreamEvent && c.turnStreamOpen) dropAbandonedStreamBlocks(c, "synthetic failure report");
		debug(`processAssistantMessage: <synthetic> message, keeping ${assistantMsg.content.length} block(s) off the stream`);
		for (const block of assistantMsg.content) {
			if (block.type === "text" && block.text) c.turnBlocks.push({ type: "text", text: block.text });
			else debug("processAssistantMessage: unhandled <synthetic> block type", block.type);
		}
		if (assistantMsg.usage && c.turnOutput) recordUsage(c.turnOutput, assistantMsg.usage, model, c.piSessionId);
		return;
	}
	const id = assistantMsg.id;
	if (c.turnSawStreamEvent && (!id || id !== c.turnFallbackMessageId)) {
		if (!id || !c.turnStreamMessageId || id === c.turnStreamMessageId) return;
		if (c.turnStreamOpen) dropAbandonedStreamBlocks(c, `non-streaming fallback ${id}`);
		c.turnFallbackMessageId = id;
	}
	if (id !== c.turnStreamMessageId) {
		c.turnStreamMessageId = id;
		if (id && !c.turnAssistantIds.includes(id)) c.turnAssistantIds.push(id);
		c.turnToolCallIds = [];
	}
	debug(`processAssistantMessage fallback: ${assistantMsg.content.length} blocks, types=${assistantMsg.content.map((b: any) => b.type).join(",")}`);
	for (const block of assistantMsg.content) {
		if (block.type === "text" && block.text) {
			pushTextBlock(c, block.text);
		} else if (block.type === "thinking") {
			ensureTurnStarted(c);
			c.turnBlocks.push({ type: "thinking", thinking: block.thinking ?? "", thinkingSignature: block.signature ?? "" });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "thinking_start", contentIndex: idx, partial: c.turnOutput });
			if (block.thinking) c.currentPiStream?.push({ type: "thinking_delta", contentIndex: idx, delta: block.thinking, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "thinking_end", contentIndex: idx, content: block.thinking ?? "", partial: c.turnOutput });
		} else if (block.type === "tool_use") {
			const piName = piToolNameFor(block.name, customToolNameToPi);
			if (!piName) {
				debug(`processAssistantMessage: skipping tool_use for unserved tool ${block.name} [${block.id}] — CC rejects it and retries`);
				continue;
			}
			ensureTurnStarted(c);
			c.turnSawToolCall = true;
			c.turnToolCallIds.push(block.id);
			c.turnBlocks.push({
				type: "toolCall", id: block.id,
				name: piName,
				arguments: mapToolArgs(piName, block.input),
			});
			const idx = c.turnBlocks.length - 1;
			const toolBlock = c.turnBlocks[idx];
			c.currentPiStream?.push({ type: "toolcall_start", contentIndex: idx, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "toolcall_end", contentIndex: idx, toolCall: toolBlock as any, partial: c.turnOutput });
		} else {
			debug("processAssistantMessage: unhandled block type", block.type);
		}
	}
	if (assistantMsg.usage && c.turnOutput) recordUsage(c.turnOutput, assistantMsg.usage, model, c.piSessionId);

	if (c.turnSawToolCall && c.currentPiStream && c.turnOutput) endToolUseTurn(c);
}

async function consumeQuery(
	sdkQuery: ReturnType<typeof query>,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	wasAborted: () => boolean,
	queryCtx: QueryContext,
): Promise<{ capturedSessionId?: string; failure?: Error }> {
	let capturedSessionId: string | undefined;
	let failure: Error | undefined;

	for await (const message of sdkQuery) {
		if (wasAborted() || queryCtx.discarded) break;
		tapRecording(message, customToolNameToPi, queryCtx);
		await reportHeldRateLimit(queryCtx, model);
		if (wasAborted() || queryCtx.discarded) break;
		let resultError: string | undefined;
		if (message.type === "result") {
			queryCtx.sawResult = true;
			logServedContextWindow("result", message, model);
			resultError = resultErrorText(message);
			if (resultError !== undefined || queryCtx.pendingSteerUuids.size === 0) queryCtx.promptStream?.end();
			if (resultError !== undefined) {
				if (queryCtx.rateLimitRejection) {
					resultError = describeRateLimitFailure(queryCtx.rateLimitRejection, resultError);
					queryCtx.rateLimitRejection = null;
				}
				debug(`consumeQuery: error result, subtype=${message.subtype}, error=${resultError}`);
				if (queryCtx.turnOutput && queryCtx.currentPiStream) {
					queryCtx.turnOutput.stopReason = "error";
					queryCtx.turnOutput.errorMessage = resultError;
				}
				failure = new Error(resultError);
				break;
			}
		}
		if (message.type === "rate_limit_event") {
			const info = (message as any).rate_limit_info;
			debug("consumeQuery: rate_limit_event", JSON.stringify(info).slice(0, 300));
			if (info) queryCtx.heldRateLimit = info;
			await reportHeldRateLimit(queryCtx, model);
			if (wasAborted() || queryCtx.discarded) break;
			if (info?.status === "rejected") {
				queryCtx.rateLimitRejection = info;
				queryCtx.lastRateLimitWarnStep = null;
				queryCtx.lastRateLimitWarnThreshold = undefined;
				const resetsAt = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : undefined;
				piUI?.notify(info.isUsingOverage
					? `Claude subscription rate limit reached (${info.rateLimitType ?? "unknown"}) — requests are now billed to Extra Usage${resetsAt ? ` until ${resetsAt}` : ""}`
					: `Claude subscription rate limit reached (${info.rateLimitType ?? "unknown"}) — resets at ${resetsAt ?? "unknown"}`, "warning");
			} else if (info?.status === "allowed") {
				queryCtx.lastRateLimitWarnStep = null;
				queryCtx.lastRateLimitWarnThreshold = undefined;
			} else if (info?.status === "allowed_warning") {
				const percent = Math.round((info.utilization ?? 0) * 100);
				const step = Math.floor(percent / 5);
				const rose = queryCtx.lastRateLimitWarnStep === null || step > queryCtx.lastRateLimitWarnStep;
				if (rose || info.surpassedThreshold !== queryCtx.lastRateLimitWarnThreshold) {
					queryCtx.lastRateLimitWarnStep = step;
					queryCtx.lastRateLimitWarnThreshold = info.surpassedThreshold;
					piUI?.notify(`Claude rate limit warning: ${percent}% used (${info.rateLimitType ?? ""})`, "warning");
				}
			}
			continue;
		}
		if (message.type === "system" && message.subtype === "init") {
			capturedSessionId = message.session_id;
		}
		if (!queryCtx.currentPiStream || !queryCtx.turnOutput) continue;

		switch (message.type) {
			case "stream_event":
				processStreamEvent(message, customToolNameToPi, model, queryCtx);
				break;
			case "assistant":
				if (!queryCtx.assistantSteps.get(message.message.id)?.emitted) processAssistantMessage(message, model, customToolNameToPi, queryCtx);
				break;
			case "result": {
				if (resultError === undefined && !queryCtx.turnSawStreamEvent && !queryCtx.turnStarted && message.subtype === "success") {
					pushTextBlock(queryCtx, message.result || "");
				}
				break;
			}
			case "system":
				break;
			case "user":
				break;
			default:
				debug("consumeQuery: unhandled SDK message type", message.type);
				break;
		}
	}

	debug(`consumeQuery: for-await loop exited, wasAborted=${wasAborted()}, capturedSessionId=${capturedSessionId?.slice(0, 8) ?? "none"}`);

	return { capturedSessionId, failure };
}

function steerBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	const blocks = extractUserPromptBlocks(messages);
	if (blocks) return blocks;
	const text = extractUserPrompt(messages);
	return text ? [{ type: "text", text }] : null;
}

async function deliverToolResults(
	c: QueryContext,
	results: McpResult[],
	steer: ContentBlockParam[] | null,
	contextLength: number,
	messages?: Context["messages"],
): Promise<void> {
	if (messages) c.recording.results(messages);
	if (steer) {
		const text = steer.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n");
		if (!c.promptStream) {
			debug(`WARNING: steer with no prompt stream, dropping: ${text.slice(0, 60)}`);
		} else {
			const uuid = randomUUID();
			c.pendingSteerUuids.add(uuid);
			if (messages) c.recording.users(messages, turnStart(messages), uuid, false);
			try {
				await c.promptStream.push({ ...userMessage(steer, "next"), uuid });
				debug(`provider: steer written to CC stdin before tool result: ${text.slice(0, 60)}`);
			} catch (error) {
				c.pendingSteerUuids.delete(uuid);
				debug(`provider: steer push rejected, delivering tool result anyway:`, error);
			}
		}
	}

	debug(`provider: tool results, ${results.length} results, ${c.pendingToolCalls.size} waiting handlers, ctx.msgs=${contextLength}`);
	for (const result of results) {
		const id = result.toolCallId;
		if (id && c.pendingToolCalls.has(id)) {
			const pending = c.pendingToolCalls.get(id)!;
			c.pendingToolCalls.delete(id);
			if (DEBUG) debug(`provider: resolving ${pending.toolName} [${id}]${result.isError ? " (error)" : ""}`, JSON.stringify(result.content).slice(0, 200));
			pending.resolve(result);
		} else if (id) {
			c.pendingResults.set(id, result);
			debug(`provider: queued result [${id}] (${c.pendingResults.size} pending)`);
		} else {
			debug(`WARNING: tool result without toolCallId, cannot match`);
		}
		if (c.pendingToolCalls.size > 0 && c.pendingResults.size > 0) {
			debug(`BUG: both maps non-empty! handlers=${c.pendingToolCalls.size} results=${c.pendingResults.size}`);
		}
	}
	if (c.pendingToolCalls.size > 0) {
		debug(`WARNING: ${c.pendingToolCalls.size} MCP handlers still waiting after delivering ${results.length} results`);
		piUI?.notify(`Claude bridge: ${c.pendingToolCalls.size} tool handler(s) still waiting — provider may be stuck`, "warning");
	}
}

function drainForAbort(c: QueryContext, promptStream: PromptStream): void {
	promptStream.fail(new Error("Operation aborted"));
	c.releasePendingToolCalls("Operation aborted");
}

const CONTINUE_AFTER_REWRITE_PROMPT =
	"[Your context was compacted. What precedes this is a summary plus the most recent messages, "
	+ "ending with the tool result you were waiting for. Continue the task from there.]";

const CONTINUE_AFTER_RESUME_PROMPT =
	"[Your session was interrupted and resumed. What precedes this ends with the tool result "
	+ "you were waiting for. Continue the task from there.]";

function discardRewrittenQuery(c: QueryContext): void {
	try { c.commitRecording?.(true); }
	finally { dropParkedQuery(c); }
}

function dropParkedQuery(c: QueryContext): void {
	c.discarded = true;
	c.activeQuery = null;
	activeQueryContexts.delete(c);
	c.turnToolCallIds = [];
	c.promptStream?.fail(new Error("conversation rewritten"));
	c.promptStream = null;
	c.releasePendingToolCalls("Context changed; this query was discarded.");
	c.stopProcess?.();
	if (c.currentPiStream && c.turnOutput) {
		c.turnOutput.stopReason = "error";
		c.turnOutput.errorMessage = "Conversation replaced";
		endCurrentPiStream(c, { type: "error", reason: "error", error: c.turnOutput });
	}
	if (c.piSessionId) historyRewrittenBySession.delete(c.piSessionId);
	debug("provider: discarded parked query; its recorded prefix remains available for a fork");
}

function streamClaudeAgentSdk(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const system = getCurrentSystemMessage(context.messages);
	context = toBridgeContext(context);

	if (options?.cacheRetention === "none") {
		debug(`provider: one-off summarizer call (cacheRetention none) routed to isolated summary, msgs=${context.messages.length}`);
		return isolatedStreamFn(model, context, options);
	}

	const stream = createAssistantMessageEventStream();
	const failBeforeQuery = (err: unknown) => {
		const output = newAssistantOutput(model, "", "error", errorMessage(err));
		queueMicrotask(() => endStream(stream, { type: "error", reason: "error", error: output }));
		return stream;
	};

	const lastMsgRole = context.messages[context.messages.length - 1]?.role;
	debug(`provider: streamClaudeAgentSdk called, activeContexts=${activeQueryContexts.size}, lastMsgRole=${lastMsgRole}`);

	let activeQuery = activeQueryContexts.size > 0;
	const allResults = activeQueryContexts.size > 0 ? extractAllToolResults(context) : [];
	let resultCtx = allResults.length > 0 ? contextForToolResults(allResults, options?.sessionId ?? null) : undefined;

	let divergence: ReturnType<LiveRecording["divergence"]>;
	try {
		divergence = resultCtx && !resultCtx.historyStale ? resultCtx.recording.divergence(nonSystemMessages(context.messages)) : undefined;
	} catch (error) {
		try { discardRewrittenQuery(resultCtx!); }
		catch (discardError) { return failBeforeQuery(discardError); }
		return failBeforeQuery(error);
	}
	const rewrittenUnderQuery = Boolean(resultCtx && (resultCtx.historyStale || divergence !== undefined));
	if (resultCtx && rewrittenUnderQuery) {
		try { discardRewrittenQuery(resultCtx); }
		catch (error) { return failBeforeQuery(error); }
		resultCtx = undefined;
		activeQuery = activeQueryContexts.size > 0;
	}

	const isReentrantUserQuery = activeQuery && lastMsgRole === "user" && allResults.length === 0;
	if (isReentrantUserQuery) {
		debug(`provider: active query user-only call treated as reentrant fresh query, ctx.msgs=${context.messages.length}`);
	}

	if (resultCtx) {
		claimCurrentPiStream(stream, "tool-result", resultCtx, options);
		resultCtx.resetTurnState(model);
		resultCtx.bindRunSignal?.(options?.signal, stream);
		const steer = lastMsgRole === "user" ? steerBlocks(context.messages) : null;
		void deliverToolResults(resultCtx, allResults, steer, context.messages.length, context.messages);
		return stream;
	}

	const lastMsg = context.messages[context.messages.length - 1];
	const unparkedToolResult = lastMsg?.role === "toolResult" && !rewrittenUnderQuery;
	if (unparkedToolResult && options?.signal?.aborted) {
		debug(`provider: orphaned tool result after abort, emitting end_turn`);
		const message = newAssistantOutput(model, "", "stop");
		queueMicrotask(() => endStream(stream, { type: "done", reason: "stop", message }));
		return stream;
	}

	try {
		if (options?.sessionId) for (const parked of [...activeQueryContexts]) {
			if (parked.piSessionId === options.sessionId) discardRewrittenQuery(parked);
		}
	} catch (error) { return failBeforeQuery(error); }

	const isReentrant = activeQuery;
	const queryCtx = new QueryContext();
	debug(`provider: fresh query setup, isReentrant=${isReentrant}, activeContexts=${activeQueryContexts.size}`);

	const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context);
	let systemPromptAppend: string | undefined;
	try {
		systemPromptAppend = claudeCodeAppend(system);
	} catch (err) {
		return failBeforeQuery(err);
	}

	queryCtx.piSessionId = options?.sessionId ?? null;
	queryCtx.resetTurnState(model);
	claimCurrentPiStream(stream, "fresh-query", queryCtx, options);
	activeQueryContexts.add(queryCtx);
	let createdBeforeLaunch: { id: string; cwd: string } | undefined;
	void (async () => {
		await waitForSessionWriter(sessionStateFor(queryCtx.piSessionId)?.ccSessionId, options?.signal);
		if (queryCtx.discarded) return;


		const cwd = currentCwd();
		const cliModel = claudeCodeModelId(model);
		const piSessionId = options?.sessionId ?? null;
		const historyRewritten = rewrittenUnderQuery || (piSessionId !== null && historyRewrittenBySession.has(piSessionId));
		const promptDigest = createHash("sha256").update(systemPromptAppend ?? "").digest("hex");
		const syncResult = syncSharedSession(context.messages, cwd, customToolNameToSdk, cliModel, piSessionId, promptDigest);
		if (syncResult.created) createdBeforeLaunch = { id: syncResult.targetSessionId, cwd };
		if (piSessionId) historyRewrittenBySession.delete(piSessionId);
		const { sessionId: resumeSessionId } = syncResult;
		const recording = queryCtx.recording = new LiveRecording(syncResult.recorded, nonSystemMessages(context.messages));
		const promptBlocks = extractUserPromptBlocks(context.messages);
		let promptText = extractUserPrompt(context.messages) ?? "";

		if (historyRewritten && !promptText && !promptBlocks) {
			promptText = CONTINUE_AFTER_REWRITE_PROMPT;
			debug(`provider: continuing the turn after a rewritten history, ${context.messages.length} msgs rebuilt`);
		}
		if (unparkedToolResult && !promptText && !promptBlocks) {
			promptText = CONTINUE_AFTER_RESUME_PROMPT;
			debug(`provider: resuming the turn at a tool result with no parked query, ${context.messages.length} msgs`);
		}

		if (!promptText && !promptBlocks) {
			diagDump("empty_prompt", {
				contextLength: context.messages.length,
				lastMsgRole: lastMsg?.role,
				isReentrant,
				activeQueryContexts: activeQueryContexts.size,
				activeQueryExists: queryCtx.activeQuery !== null,
				sharedSession: sessionStateFor(piSessionId),
				messageRoles: context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
			});
			promptText = "[continue]";
		}

		const promptStream = makePromptStream();
		const promptUuid = randomUUID();
		recording.users(context.messages, turnStart(context.messages), promptUuid, false, false);
		queryCtx.turnOpener = promptUuid;
		void promptStream.push({ ...userMessage(promptBlocks ?? [{ type: "text", text: promptText }]), uuid: promptUuid })
			.catch((error) => debug(`provider: initial prompt push rejected:`, error));
		queryCtx.promptStream = promptStream;
		const mcpServers = buildMcpServers(mcpTools, queryCtx);


		const effort = effortForReasoning(model, options?.reasoning);
		const thinking = thinkingForReasoning(model, options?.reasoning);

		const extraArgs: Record<string, string | null> = { "replay-user-messages": null };
		if (effort) extraArgs["thinking-display"] = "summarized";

		const childEnv = ccChildEnv(options?.env);
		const cliDebug = makeCliDebugOptions("provider");
		const childProcess = new QueryProcess(cliDebug.stderr);
		const queryOptions: NonNullable<Parameters<typeof query>[0]["options"]> = {
			cwd,
			env: childEnv,
			tools: [],
			permissionMode: "bypassPermissions",
			includePartialMessages: true,
			settingSources: ["user"] as SettingSource[],
			settings: {
				autoMemoryEnabled: false,
				claudeMdExcludes: CLAUDE_MD_EXCLUDES,
				includeGitInstructions: false,
				outputStyle: "default",
			},
			systemPrompt: {
				type: "preset", preset: "claude_code",
				append: systemPromptAppend ? systemPromptAppend : undefined,
				snapshot: false,
			},
			model: cliModel,
			strictMcpConfig: true,
			extraArgs,
			...(effort ? { effort } : {}),
			...(thinking ? { thinking } : {}),
			...(mcpServers ? { mcpServers } : {}),
			...(resumeSessionId ? { resume: resumeSessionId } : {}),
			...(syncResult.forkAt ? { forkSession: true, resumeSessionAt: syncResult.forkAt } : {}),
			...(syncResult.created && (!resumeSessionId || syncResult.forkAt) ? { sessionId: syncResult.targetSessionId } : {}),
			...cliDebug,
			spawnClaudeCodeProcess: childProcess.spawn,
		};

		debug("provider: fresh query",
			`model=${cliModel} msgs=${context.messages.length} tools=${mcpTools.length}`,
			`resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"}`,
			sessionTag(queryCtx.piSessionId),
			`prompt=${promptText.slice(0, 60)}${promptBlocks ? " [+images]" : ""}`);

		let wasAborted = false;
		const stopWriting = () => { sessionWriters.set(syncResult.targetSessionId, childProcess.exited); };
		const releaseWriter = () => {
			if (sessionWriters.get(syncResult.targetSessionId) === childProcess.exited) sessionWriters.delete(syncResult.targetSessionId);
		};
		let sdkQuery: ReturnType<typeof query>;
		try { sdkQuery = query({ prompt: promptStream.stream, options: queryOptions }); }
		catch (error) {
			stopWriting();
			childProcess.terminate();
			await childProcess.exited;
			releaseWriter();
			throw error;
		}
		createdBeforeLaunch = undefined;
		let expectedState = syncResult.state;
		let unsaved: SessionState | null = null;
		const commitRecording = (dirty: boolean) => {
			stopWriting();
			if (!dirty && (recording.hasGaps || (syncResult.created && !recording.hasProgress))) debug(`recording: clean end left messages unrecorded ${sessionTag(piSessionId)}`);
			if (piSessionId == null || sessionStateFor(piSessionId) !== expectedState || (syncResult.created && !recording.hasProgress)) return;
			const state: SessionState = { ...copyRecording(recording.recorded), ccSessionId: syncResult.targetSessionId, cwd, model: cliModel, promptDigest,
				dirtyTail: dirty || queryCtx.historyStale || recording.hasGaps };
			setSessionStateFor(piSessionId, state);
			expectedState = unsaved = state;
		};
		const persistRecording = async () => {
			sdkQuery.close();
			childProcess.close();
			await childProcess.exited;
			const state = unsaved;
			unsaved = null;
			if (state && sharedSessions.get(piSessionId!) === state) saveSessionState(piSessionId!, state);
		};
		queryCtx.commitRecording = commitRecording;
		queryCtx.activeQuery = sdkQuery;

		const abortCtx = queryCtx;

		const requestAbort = () => {
			stopWriting();
			void sdkQuery.interrupt().catch(() => {});
			try { sdkQuery.close(); } catch {}
			childProcess.close();
		};
		queryCtx.stopProcess = requestAbort;
		const onAbort = () => {
			if (wasAborted) return;
			wasAborted = true;
			try { commitRecording(true); }
			finally {
				activeQueryContexts.delete(abortCtx);
				abortCtx.turnToolCallIds = [];
				drainForAbort(abortCtx, promptStream);
				requestAbort();
			}
		};
		if (options?.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}
		let unbindRunSignal = () => {};
		const bindRunSignal = (signal: AbortSignal | undefined, runStream: AssistantMessageEventStream) => {
			unbindRunSignal();
			unbindRunSignal = () => {};
			if (!signal || signal === options?.signal) return;
			const onRunAbort = () => {
				if (!completedStreams.has(runStream as object)) onAbort();
			};
			if (signal.aborted) return onRunAbort();
			signal.addEventListener("abort", onRunAbort, { once: true });
			unbindRunSignal = () => signal.removeEventListener("abort", onRunAbort);
		};
		queryCtx.bindRunSignal = bindRunSignal;

		const failStream = (error: unknown) => {
			queryCtx.activeQuery = null;
			activeQueryContexts.delete(queryCtx);
			if (queryCtx.turnOutput && queryCtx.currentPiStream) {
				queryCtx.turnOutput.stopReason = wasAborted ? "aborted" : "error";
				queryCtx.turnOutput.errorMessage ??= errorMessage(error);
				endCurrentPiStream(queryCtx, { type: "error", reason: wasAborted ? "aborted" : "error", error: queryCtx.turnOutput });
			}
		};
		const failQuery = (error: unknown) => {
			if (queryCtx.discarded) return;
			try { if (!wasAborted) commitRecording(true); }
			finally { failStream(error); }
		};

		queryCtx.settled = consumeQuery(sdkQuery, customToolNameToPi, model, () => wasAborted, queryCtx)
			.then(async ({ capturedSessionId, failure }) => {
				if (queryCtx.discarded) return;
				if (capturedSessionId && capturedSessionId !== syncResult.targetSessionId) {
					const error = new Error(`Claude Code initialized unexpected session ${capturedSessionId}; expected ${syncResult.targetSessionId}`);
					failStream(error);
					throw error;
				}
				if (failure) return failQuery(failure);
				if (wasAborted || options?.signal?.aborted) return failQuery(new Error("Operation aborted"));
				if (queryCtx.currentPiStream) recordAssistantEmission(queryCtx);
				commitRecording(!queryCtx.sawResult);
				try { await persistRecording(); }
				catch (error) {
					failStream(error);
					throw error;
				}
				if (wasAborted) return failQuery(new Error("Operation aborted"));
				queryCtx.activeQuery = null;
				activeQueryContexts.delete(queryCtx);
				finalizeCurrentStream(queryCtx);
			}, failQuery)
			.finally(async () => {
				options?.signal?.removeEventListener("abort", onAbort);
				unbindRunSignal();
				queryCtx.bindRunSignal = null;
				queryCtx.commitRecording = null;
				queryCtx.stopProcess = null;
				promptStream.fail(new Error("query ended"));
				queryCtx.promptStream = null;
				queryCtx.releasePendingToolCalls("Query ended");
				queryCtx.activeQuery = null;
				activeQueryContexts.delete(queryCtx);
				stopWriting();
				try { await persistRecording(); }
				finally {
					if (syncResult.created && !recording.hasProgress) deleteSession(syncResult.targetSessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
					releaseWriter();
				}
			});

	})().catch((error) => {
		if (createdBeforeLaunch) deleteSession(createdBeforeLaunch.id, createdBeforeLaunch.cwd, process.env.CLAUDE_CONFIG_DIR);
		queryCtx.promptStream?.fail(error instanceof Error ? error : new Error(errorMessage(error)));
		queryCtx.promptStream = null;
		if (queryCtx.discarded) return;
		activeQueryContexts.delete(queryCtx);
		const output = newAssistantOutput(model, "", options?.signal?.aborted ? "aborted" : "error", errorMessage(error));
		endStream(stream, { type: "error", reason: output.stopReason as "error" | "aborted", error: output });
		queryCtx.currentPiStream = null;
	});
	return stream;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (event, ctx) => {
		piUI = ctx.ui;
		sessionCwd = ctx.cwd;
		if (event.reason === "fork" && event.previousSessionFile) inheritSessionState(event.previousSessionFile, ctx.sessionManager.getSessionId());
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await closeSessionQueries(ctx.sessionManager.getSessionId());
	});

	pi.on("session_compact", (event, ctx) =>
		markRebuildForSession(ctx.sessionManager.getSessionId(), `session_compact:${event.reason}:willRetry=${event.willRetry}`));
	pi.on("session_tree", (_event, ctx) => markRebuildForSession(ctx.sessionManager.getSessionId(), "session_tree"));

	pi.on("tool_call", (event, ctx) => {
		if (isToolCallEventType("bash", event) && event.input.timeout == null && ctx.model?.provider === PROVIDER_ID
			&& (event.input as { background?: unknown }).background !== true) {
			event.input.timeout = 120;
		}
	});

	pi.registerProvider(PROVIDER_ID, {
		baseUrl: "claude-bridge",
		apiKey: "not-used",
		api: "claude-bridge",
		models: MODELS,
		streamSimple: streamClaudeAgentSdk as any,
	});
}
