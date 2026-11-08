import { createHash, randomUUID } from "node:crypto";
import { query, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import {
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	getCurrentSystemMessage,
	type Model,
	type SimpleStreamOptions,
	type Tool,
} from "@earendil-works/pi-ai";
import { deleteSession } from "cc-session-io";
import {
	CLAUDE_MD_EXCLUDES,
	ccChildEnv,
	effortForReasoning,
	errorMessage,
	logServedContextWindow,
	resultErrorText,
	thinkingForReasoning,
} from "./cc-child.js";
import { DEBUG, debug, makeCliDebugOptions } from "./debug.js";
import { extractAllToolResults as _extractAllToolResults, type McpResult } from "./extract-tool-results.js";
import { createToolServer, MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "./mcp-server.js";
import { claudeCodeModelId } from "./models.js";
import { notify } from "./notify.js";
import { claudeCodeAppend } from "./prompt.js";
import { makePromptStream, type PromptStream, userMessage } from "./prompt-stream.js";
import { QueryProcess } from "./query-process.js";
import { activeQueryContexts, newAssistantOutput, QueryContext } from "./query-state.js";
import { rateLimitResponse } from "./rate-limit.js";
import { saveSessionState } from "./session-store.js";
import { copyRecording, LiveRecording, type SessionState } from "./session-sync.js";
import {
	currentCwd,
	historyRewrittenBySession,
	sessionStateFor,
	sessionTag,
	sessionWriters,
	setSessionStateFor,
	sharedSessions,
	syncSharedSession,
	waitForSessionWriter,
} from "./sessions.js";
import {
	claimCurrentPiStream,
	completedStreams,
	endCurrentPiStream,
	endStream,
	finalizeCurrentStream,
	processAssistantMessage,
	processStreamEvent,
	pushTextBlock,
	recordAssistantEmission,
	tapRecording,
} from "./stream-events.js";
import { isolatedStreamFn } from "./summary.js";
import { nonSystemMessages, toBridgeContext } from "./transcript.js";
import { extractUserPrompt, extractUserPromptBlocks, steerBlocks, turnStart } from "./user-prompt.js";

function extractAllToolResults(context: Context): McpResult[] {
	const results = _extractAllToolResults(
		context.messages as unknown as Array<{ role: string; [key: string]: unknown }>,
	);
	if (DEBUG) {
		debug(`extractAllToolResults: ${results.length} results from ${context.messages.length} msgs`);
		debug(`extractAllToolResults: all msg roles:`, context.messages.map((m, i) => `[${i}]${m.role}`).join(" "));
		for (let r = 0; r < results.length; r++) {
			debug(
				`extractAllToolResults: result[${r}] id=${results[r].toolCallId}${results[r].isError ? " ERROR" : ""} preview:`,
				JSON.stringify(results[r].content).slice(0, 150),
			);
		}
	}
	return results;
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

export async function closeSessionQueries(piSessionId: string): Promise<void> {
	const closing = [...activeQueryContexts].filter((c) => c.piSessionId === piSessionId);
	for (const c of closing) {
		debug(
			`${c.activeQuery ? "session_shutdown: closing parked query" : "WARNING: session_shutdown left a context with no query"} — ` +
				`pendingToolCalls=${c.pendingToolCalls.size} promptStream=${c.promptStream !== null}`,
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
			if (
				queryCtx.pendingToolCalls.has(id) ||
				queryCtx.pendingResults.has(id) ||
				queryCtx.turnToolCallIds.includes(id)
			) {
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

function buildMcpServers(
	tools: Tool[],
	queryCtx: QueryContext,
): Record<string, ReturnType<typeof createToolServer>> | undefined {
	if (!tools.length) return undefined;
	const mcpTools = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters,
		handler: async (toolCallId: string) => {
			if (queryCtx.pendingResults.has(toolCallId)) {
				const result = queryCtx.pendingResults.get(toolCallId)!;
				queryCtx.pendingResults.delete(toolCallId);
				debug(
					`mcp handler: ${tool.name} [${toolCallId}] → resolved from queue (${queryCtx.pendingResults.size} remaining)`,
				);
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
				notify(
					info.isUsingOverage
						? `Claude subscription rate limit reached (${info.rateLimitType ?? "unknown"}) — requests are now billed to Extra Usage${resetsAt ? ` until ${resetsAt}` : ""}`
						: `Claude subscription rate limit reached (${info.rateLimitType ?? "unknown"}) — resets at ${resetsAt ?? "unknown"}`,
					"warning",
				);
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
					notify(`Claude rate limit warning: ${percent}% used (${info.rateLimitType ?? ""})`, "warning");
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
				if (!queryCtx.assistantSteps.get(message.message.id)?.emitted)
					processAssistantMessage(message, model, customToolNameToPi, queryCtx);
				break;
			case "result": {
				if (
					resultError === undefined &&
					!queryCtx.turnSawStreamEvent &&
					!queryCtx.turnStarted &&
					message.subtype === "success"
				) {
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

	debug(
		`consumeQuery: for-await loop exited, wasAborted=${wasAborted()}, capturedSessionId=${capturedSessionId?.slice(0, 8) ?? "none"}`,
	);

	return { capturedSessionId, failure };
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

	debug(
		`provider: tool results, ${results.length} results, ${c.pendingToolCalls.size} waiting handlers, ctx.msgs=${contextLength}`,
	);
	for (const result of results) {
		const id = result.toolCallId;
		if (id && c.pendingToolCalls.has(id)) {
			const pending = c.pendingToolCalls.get(id)!;
			c.pendingToolCalls.delete(id);
			if (DEBUG)
				debug(
					`provider: resolving ${pending.toolName} [${id}]${result.isError ? " (error)" : ""}`,
					JSON.stringify(result.content).slice(0, 200),
				);
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
		debug(
			`WARNING: ${c.pendingToolCalls.size} MCP handlers still waiting after delivering ${results.length} results`,
		);
		notify(
			`Claude bridge: ${c.pendingToolCalls.size} tool handler(s) still waiting — provider may be stuck`,
			"warning",
		);
	}
}

function drainForAbort(c: QueryContext, promptStream: PromptStream): void {
	promptStream.fail(new Error("Operation aborted"));
	c.releasePendingToolCalls("Operation aborted");
}

const CONTINUE_AFTER_REWRITE_PROMPT =
	"[Your context was compacted. What precedes this is a summary plus the most recent messages, " +
	"ending with the tool result you were waiting for. Continue the task from there.]";

const CONTINUE_AFTER_RESUME_PROMPT =
	"[Your session was interrupted and resumed. What precedes this ends with the tool result " +
	"you were waiting for. Continue the task from there.]";

function discardRewrittenQuery(c: QueryContext): void {
	try {
		c.commitRecording?.(true);
	} finally {
		dropParkedQuery(c);
	}
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

export function streamClaudeAgentSdk(
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const system = getCurrentSystemMessage(context.messages);
	context = toBridgeContext(context);

	if (options?.cacheRetention === "none") {
		debug(
			`provider: one-off summarizer call (cacheRetention none) routed to isolated summary, msgs=${context.messages.length}`,
		);
		return isolatedStreamFn(model, context, options);
	}

	const stream = createAssistantMessageEventStream();
	const failBeforeQuery = (err: unknown) => {
		const output = newAssistantOutput(model, "", "error", errorMessage(err));
		queueMicrotask(() => endStream(stream, { type: "error", reason: "error", error: output }));
		return stream;
	};

	const lastMsgRole = context.messages[context.messages.length - 1]?.role;
	debug(
		`provider: streamClaudeAgentSdk called, activeContexts=${activeQueryContexts.size}, lastMsgRole=${lastMsgRole}`,
	);

	let activeQuery = activeQueryContexts.size > 0;
	const allResults = activeQueryContexts.size > 0 ? extractAllToolResults(context) : [];
	let resultCtx = allResults.length > 0 ? contextForToolResults(allResults, options?.sessionId ?? null) : undefined;

	let divergence: ReturnType<LiveRecording["divergence"]>;
	try {
		divergence =
			resultCtx && !resultCtx.historyStale
				? resultCtx.recording.divergence(nonSystemMessages(context.messages))
				: undefined;
	} catch (error) {
		try {
			discardRewrittenQuery(resultCtx!);
		} catch (discardError) {
			return failBeforeQuery(discardError);
		}
		return failBeforeQuery(error);
	}
	const rewrittenUnderQuery = Boolean(resultCtx && (resultCtx.historyStale || divergence !== undefined));
	if (resultCtx && rewrittenUnderQuery) {
		try {
			discardRewrittenQuery(resultCtx);
		} catch (error) {
			return failBeforeQuery(error);
		}
		resultCtx = undefined;
		activeQuery = activeQueryContexts.size > 0;
	}

	const isReentrantUserQuery = activeQuery && lastMsgRole === "user" && allResults.length === 0;
	if (isReentrantUserQuery) {
		debug(
			`provider: active query user-only call treated as reentrant fresh query, ctx.msgs=${context.messages.length}`,
		);
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
		if (options?.sessionId)
			for (const parked of [...activeQueryContexts]) {
				if (parked.piSessionId === options.sessionId) discardRewrittenQuery(parked);
			}
	} catch (error) {
		return failBeforeQuery(error);
	}

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
		const historyRewritten =
			rewrittenUnderQuery || (piSessionId !== null && historyRewrittenBySession.has(piSessionId));
		const promptDigest = createHash("sha256")
			.update(systemPromptAppend ?? "")
			.digest("hex");
		const syncResult = syncSharedSession(
			context.messages,
			cwd,
			customToolNameToSdk,
			cliModel,
			piSessionId,
			promptDigest,
		);
		if (syncResult.created) createdBeforeLaunch = { id: syncResult.targetSessionId, cwd };
		if (piSessionId) historyRewrittenBySession.delete(piSessionId);
		const { sessionId: resumeSessionId } = syncResult;
		const recording = new LiveRecording(syncResult.recorded, nonSystemMessages(context.messages));
		queryCtx.recording = recording;
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
			debug("empty_prompt", {
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
		void promptStream
			.push({ ...userMessage(promptBlocks ?? [{ type: "text", text: promptText }]), uuid: promptUuid })
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
				type: "preset",
				preset: "claude_code",
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
			...(syncResult.created && (!resumeSessionId || syncResult.forkAt)
				? { sessionId: syncResult.targetSessionId }
				: {}),
			...cliDebug,
			spawnClaudeCodeProcess: childProcess.spawn,
		};

		debug(
			"provider: fresh query",
			`model=${cliModel} msgs=${context.messages.length} tools=${mcpTools.length}`,
			`resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"}`,
			sessionTag(queryCtx.piSessionId),
			`prompt=${promptText.slice(0, 60)}${promptBlocks ? " [+images]" : ""}`,
		);

		let wasAborted = false;
		const stopWriting = () => {
			sessionWriters.set(syncResult.targetSessionId, childProcess.exited);
		};
		const releaseWriter = () => {
			if (sessionWriters.get(syncResult.targetSessionId) === childProcess.exited)
				sessionWriters.delete(syncResult.targetSessionId);
		};
		let sdkQuery: ReturnType<typeof query>;
		try {
			sdkQuery = query({ prompt: promptStream.stream, options: queryOptions });
		} catch (error) {
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
			if (!dirty && (recording.hasGaps || (syncResult.created && !recording.hasProgress)))
				debug(`recording: clean end left messages unrecorded ${sessionTag(piSessionId)}`);
			if (
				piSessionId == null ||
				sessionStateFor(piSessionId) !== expectedState ||
				(syncResult.created && !recording.hasProgress)
			)
				return;
			const state: SessionState = {
				...copyRecording(recording.recorded),
				ccSessionId: syncResult.targetSessionId,
				cwd,
				model: cliModel,
				promptDigest,
				dirtyTail: dirty || queryCtx.historyStale || recording.hasGaps,
			};
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
			try {
				sdkQuery.close();
			} catch {}
			childProcess.close();
		};
		queryCtx.stopProcess = requestAbort;
		const onAbort = () => {
			if (wasAborted) return;
			wasAborted = true;
			try {
				commitRecording(true);
			} finally {
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
				endCurrentPiStream(queryCtx, {
					type: "error",
					reason: wasAborted ? "aborted" : "error",
					error: queryCtx.turnOutput,
				});
			}
		};
		const failQuery = (error: unknown) => {
			if (queryCtx.discarded) return;
			try {
				if (!wasAborted) commitRecording(true);
			} finally {
				failStream(error);
			}
		};

		queryCtx.settled = consumeQuery(sdkQuery, customToolNameToPi, model, () => wasAborted, queryCtx)
			.then(async ({ capturedSessionId, failure }) => {
				if (queryCtx.discarded) return;
				if (capturedSessionId && capturedSessionId !== syncResult.targetSessionId) {
					const error = new Error(
						`Claude Code initialized unexpected session ${capturedSessionId}; expected ${syncResult.targetSessionId}`,
					);
					failStream(error);
					throw error;
				}
				if (failure) return failQuery(failure);
				if (wasAborted || options?.signal?.aborted) return failQuery(new Error("Operation aborted"));
				if (queryCtx.currentPiStream) recordAssistantEmission(queryCtx);
				commitRecording(!queryCtx.sawResult);
				try {
					await persistRecording();
				} catch (error) {
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
				try {
					await persistRecording();
				} finally {
					if (syncResult.created && !recording.hasProgress)
						deleteSession(syncResult.targetSessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
					releaseWriter();
				}
			});
	})().catch((error) => {
		if (createdBeforeLaunch)
			deleteSession(createdBeforeLaunch.id, createdBeforeLaunch.cwd, process.env.CLAUDE_CONFIG_DIR);
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
