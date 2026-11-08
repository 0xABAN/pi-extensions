import { getModels } from "@earendil-works/pi-ai/compat";
import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { PROVIDER_ID } from "./src/convert.js";
import { buildModels } from "./src/models.js";
import { setNotifier } from "./src/notify.js";
import { closeSessionQueries, streamClaudeAgentSdk } from "./src/provider.js";
import { inheritSessionState, markRebuildForSession, setSessionCwd } from "./src/sessions.js";

const MODELS = buildModels(getModels("anthropic"));

export default function claudeBridge(pi: ExtensionAPI) {
	pi.on("session_start", (event, ctx) => {
		setNotifier(ctx.ui);
		setSessionCwd(ctx.cwd);
		if (event.reason === "fork" && event.previousSessionFile) {
			inheritSessionState(event.previousSessionFile, ctx.sessionManager.getSessionId());
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await closeSessionQueries(ctx.sessionManager.getSessionId());
	});

	pi.on("session_compact", (event, ctx) => {
		markRebuildForSession(
			ctx.sessionManager.getSessionId(),
			`session_compact:${event.reason}:willRetry=${event.willRetry}`,
		);
	});

	pi.on("session_tree", (_event, ctx) => {
		markRebuildForSession(ctx.sessionManager.getSessionId(), "session_tree");
	});

	pi.on("tool_call", (event, ctx) => {
		const background = (event.input as { background?: unknown }).background === true;
		if (
			isToolCallEventType("bash", event) &&
			event.input.timeout == null &&
			ctx.model?.provider === PROVIDER_ID &&
			!background
		) {
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
