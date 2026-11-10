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
	resultErrorText,
	thinkingForReasoning,
} from "./cc-child.js";
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
	} catch {}
}

export async function closeSessionQueries(piSessionId: string): Promise<void> {
	const closing = [...activeQueryContexts].filter((c) => c.piSessionId === piSessionId);
	for (const c of closing) {
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
				return result;
			}
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
			resultError = resultErrorText(message);
			if (resultError !== undefined || queryCtx.pendingSteerUuids.size === 0) queryCtx.promptStream?.end();
			if (resultError !== undefined) {
				if (queryCtx.rateLimitRejection) {
					resultError = describeRateLimitFailure(queryCtx.rateLimitRejection, resultError);
					queryCtx.rateLimitRejection = null;
				}
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
				break;
		}
	}

	return { capturedSessionId, failure };
}

async function deliverToolResults(
	c: QueryContext,
	results: McpResult[],
	steer: ContentBlockParam[] | null,
	messages?: Context["messages"],
): Promise<void> {
	if (messages) c.recording.results(messages);
	if (steer && c.promptStream) {
		const uuid = randomUUID();
		c.pendingSteerUuids.add(uuid);
		if (messages) c.recording.users(messages, turnStart(messages), uuid, false);
		try {
			await c.promptStream.push({ ...userMessage(steer, "next"), uuid });
		} catch {
			c.pendingSteerUuids.delete(uuid);
		}
	}

	for (const result of results) {
		const id = result.toolCallId;
		if (id && c.pendingToolCalls.has(id)) {
			const pending = c.pendingToolCalls.get(id)!;
			c.pendingToolCalls.delete(id);
			pending.resolve(result);
		} else if (id) {
			c.pendingResults.set(id, result);
		}
	}
	if (c.pendingToolCalls.size > 0) {
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
}

export function streamClaudeAgentSdk(
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const system = getCurrentSystemMessage(context.messages);
	context = toBridgeContext(context);

	if (options?.cacheRetention === "none") {
		return isolatedStreamFn(model, context, options);
	}

	const stream = createAssistantMessageEventStream();
	const failBeforeQuery = (err: unknown) => {
		const output = newAssistantOutput(model, "", "error", errorMessage(err));
		queueMicrotask(() => endStream(stream, { type: "error", reason: "error", error: output }));
		return stream;
	};

	const lastMsgRole = context.messages[context.messages.length - 1]?.role;
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
	}

	if (resultCtx) {
		claimCurrentPiStream(stream, resultCtx, options);
		resultCtx.resetTurnState(model);
		resultCtx.bindRunSignal?.(options?.signal, stream);
		const steer = lastMsgRole === "user" ? steerBlocks(context.messages) : null;
		void deliverToolResults(resultCtx, allResults, steer, context.messages);
		return stream;
	}

	const lastMsg = context.messages[context.messages.length - 1];
	const unparkedToolResult = lastMsg?.role === "toolResult" && !rewrittenUnderQuery;
	if (unparkedToolResult && options?.signal?.aborted) {
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

	const queryCtx = new QueryContext();

	const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context);
	let systemPromptAppend: string | undefined;
	try {
		systemPromptAppend = claudeCodeAppend(system);
	} catch (err) {
		return failBeforeQuery(err);
	}

	queryCtx.piSessionId = options?.sessionId ?? null;
	queryCtx.resetTurnState(model);
	claimCurrentPiStream(stream, queryCtx, options);
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
		}
		if (unparkedToolResult && !promptText && !promptBlocks) {
			promptText = CONTINUE_AFTER_RESUME_PROMPT;
		}

		if (!promptText && !promptBlocks) {
			promptText = "[continue]";
		}

		const promptStream = makePromptStream();
		const promptUuid = randomUUID();
		recording.users(context.messages, turnStart(context.messages), promptUuid, false, false);
		queryCtx.turnOpener = promptUuid;
		void promptStream
			.push({ ...userMessage(promptBlocks ?? [{ type: "text", text: promptText }]), uuid: promptUuid })
			.catch(() => {});
		queryCtx.promptStream = promptStream;
		const mcpServers = buildMcpServers(mcpTools, queryCtx);

		const effort = effortForReasoning(model, options?.reasoning);
		const thinking = thinkingForReasoning(model, options?.reasoning);

		const extraArgs: Record<string, string | null> = { "replay-user-messages": null };
		if (effort) extraArgs["thinking-display"] = "summarized";

		const childEnv = ccChildEnv(options?.env);
		const childProcess = new QueryProcess();
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
			spawnClaudeCodeProcess: childProcess.spawn,
		};

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
