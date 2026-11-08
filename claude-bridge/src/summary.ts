import { query, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import {
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
	ccChildEnv,
	effortForReasoning,
	errorMessage,
	logServedContextWindow,
	resultErrorText,
	thinkingForReasoning,
} from "./cc-child.js";
import { debug, makeCliDebugOptions } from "./debug.js";
import { claudeCodeModelId } from "./models.js";
import { newAssistantOutput } from "./query-state.js";
import { currentCwd } from "./sessions.js";
import { endStream } from "./stream-events.js";
import { extractUserPrompt } from "./user-prompt.js";

export function isolatedStreamFn(
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
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
		try {
			sdkQuery?.close();
		} catch {}
	};

	try {
		const promptText = extractUserPrompt(context.messages);
		if (!promptText)
			throw new Error("runIsolatedSummary: one-off summary without a user prompt (last message is not user?)");
		const cwd = currentCwd();
		const cliModel = claudeCodeModelId(model);
		const effort = effortForReasoning(model, options?.reasoning);
		const thinking = thinkingForReasoning(model, options?.reasoning);
		debug(
			`compact summary: spawn model=${cliModel} registeredModel=${model.id} effort=${effort ?? "default"}${thinking ? " thinking=disabled" : ""} promptLen=${promptText.length}`,
		);

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
		try {
			sdkQuery?.close();
		} catch {}
	}
}
