import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { type OpenQuestionnaire, registerAnswerChannel } from "./answer-channel.ts";
import {
	COLLAPSE_KEY_OFF,
	loadConfig,
	resolveCollapseKey,
	resolveNotesKey,
	validateGuidanceFields,
} from "./config.ts";
import {
	ASK_USER_BLOCKED_EVENT,
	ASK_USER_PROMPT_EVENT,
	type AskUserBlockedEventPayload,
	type AskUserPromptEventPayload,
} from "./events.ts";
import {
	mustYieldInlineSlot,
	type Presentation,
	resolvePresentation,
	rowBudgetForHost,
	STACKED_OVERLAY_PRESENTATION,
	YIELD_TO_OVERLAY,
} from "./presentation.ts";
import { type DialogUI, hasDialogUI, runRpcQuestionnaire } from "./rpc-fallback.ts";
import { displayLabel, t } from "./state/i18n-bridge.ts";
import { sentinelsToAppend } from "./state/row-intent.ts";
import { normalizeQuestionParams, prepareQuestionArguments } from "./tool/normalize-params.ts";
import { buildQuestionnaireResponse, buildToolResult } from "./tool/response-envelope.ts";
import {
	MAX_OPTIONS,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	type QuestionData,
	type QuestionnaireError,
	type QuestionnaireResult,
	type QuestionParams,
	QuestionParamsSchema,
} from "./tool/types.ts";
import { validateQuestionnaire } from "./tool/validate-questionnaire.ts";
import type { WrappingSelectItem } from "./view/components/wrapping-select.ts";
import { renderAskCall, renderAskResult, summarizeAsk } from "./view/transcript.ts";

function emitAskUserPromptEvent(pi: ExtensionAPI, params: QuestionParams, toolCallId: string): void {
	const payload: AskUserPromptEventPayload = {
		toolCallId,
		questions: params.questions.map((q) => ({
			question: q.question,
			header: q.header,
			multiSelect: q.multiSelect ?? false,
			options: q.options.map((o) => ({
				label: o.label,
				description: o.description,
				hasPreview: typeof o.preview === "string" && o.preview.length > 0,
			})),
		})),
	};
	pi.events.emit(ASK_USER_PROMPT_EVENT, payload);
}

function emitAskUserBlockedEvent(pi: ExtensionAPI, active: boolean, toolCallId: string): void {
	const payload: AskUserBlockedEventPayload = { active, toolCallId };
	pi.events.emit(ASK_USER_BLOCKED_EVENT, payload);
}

function rejectWithoutUi() {
	return buildToolResult(ERROR_NO_UI, { answers: [], cancelled: true, error: "no_ui" });
}

async function runRpcPath(pi: ExtensionAPI, ui: DialogUI, typed: QuestionParams, toolCallId: string) {
	emitAskUserBlockedEvent(pi, true, toolCallId);
	try {
		emitTerminalAttention();
		return buildQuestionnaireResponse(await runRpcQuestionnaire(ui, typed), typed);
	} finally {
		emitAskUserBlockedEvent(pi, false, toolCallId);
	}
}

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

const ERROR_NO_UI = "Error: UI not available (running in non-interactive mode)";

const ERROR_NO_CUSTOM_UI =
	"Error: this client cannot render the questionnaire (custom UI is unavailable, e.g. RPC/ACP hosts such as Zed or Paseo). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, without using this tool.";

const ERROR_SESSION_LOAD_FAILED =
	"Error: the questionnaire UI failed to load — the host's installed dependencies were likely replaced or removed on disk while Pi was running (e.g. a package-manager install touched the store). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, and tell the user that restoring this tool requires repairing the install if needed and restarting Pi.";

const ERROR_STALE_MODULE_CACHE =
	"Error: the questionnaire UI cannot load — the host's module cache went stale after an earlier failed load (typically dependencies replaced on disk mid-session). This is unrecoverable within the current Pi process. The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, and tell the user to restart Pi to restore this tool.";

export const BEL = "\x07";

function emitTerminalAttention(): void {
	try {
		if (process.stdout.isTTY) process.stdout.write(BEL);
	} catch {
	}
}

export const PREWARM_DELAY_MS = 2000;

type SessionModule = typeof import("./state/questionnaire-session.ts");

type SessionRef = { current: import("./state/questionnaire-session.ts").QuestionnaireSession | null };
type OverlayHandleRef = { current: OverlayHandle | undefined };

type SessionLoad =
	| { ok: true; module: SessionModule }
	| { ok: false; error: Extract<QuestionnaireError, "session_load_failed" | "stale_module_cache">; message: string };

export async function loadQuestionnaireSession(): Promise<SessionLoad> {
	let mod: SessionModule;
	try {
		mod = await import("./state/questionnaire-session.ts");
	} catch (e) {
		const cause = e instanceof Error ? e.message : String(e);
		return { ok: false, error: "session_load_failed", message: `${ERROR_SESSION_LOAD_FAILED} (cause: ${cause})` };
	}
	if (typeof mod.QuestionnaireSession !== "function") {
		const keys = JSON.stringify(Object.keys(mod));
		return {
			ok: false,
			error: "stale_module_cache",
			message: `${ERROR_STALE_MODULE_CACHE} (resolved namespace keys: ${keys})`,
		};
	}
	return { ok: true, module: mod };
}

function registerCollapseKeyListener(
	ctx: ExtensionContext,
	collapseKey: string,
	sessionRef: SessionRef,
	overlayHandleRef: OverlayHandleRef,
): (() => void) | undefined {
	if (collapseKey === COLLAPSE_KEY_OFF || typeof ctx.ui.onTerminalInput !== "function") return undefined;
	let hasAnnouncedHide = false;
	return ctx.ui.onTerminalInput((data) => {
		const handle = overlayHandleRef.current;
		if (!handle) return undefined;
		if (!handle.isHidden() && !handle.isFocused()) return undefined;
		if (!matchesKey(data, collapseKey as Parameters<typeof matchesKey>[1])) return undefined;
		if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
		sessionRef.current?.toggleCollapsedExternal();
		if (handle.isHidden() && !hasAnnouncedHide) {
			hasAnnouncedHide = true;
			ctx.ui.notify?.(`ask_user_question hidden — press ${collapseKey} to reopen`, "info");
		}
		return { consume: true };
	});
}

function makeSessionFactory(config: {
	ctx: ExtensionContext;
	typed: QuestionParams;
	itemsByTab: WrappingSelectItem[][];
	collapseKey: string;
	notesKey: string;
	canReopenWhileHidden: boolean;
	presentation: Presentation;
	sessionRef: SessionRef;
	open: OpenQuestionnaire;
	Session: SessionModule["QuestionnaireSession"];
}) {
	const {
		ctx,
		typed,
		itemsByTab,
		collapseKey,
		notesKey,
		canReopenWhileHidden,
		presentation,
		sessionRef,
		open,
		Session,
	} = config;
	return (
		tui: TUI,
		theme: Theme,
		keybindings: import("./state/questionnaire-session.ts").QuestionnaireSessionConfig["keybindings"],
		done: (result: QuestionnaireResult) => void,
	): import("./state/questionnaire-session.ts").QuestionnaireSessionComponent => {
		if (!presentation.overlay && mustYieldInlineSlot(tui)) {
			done(YIELD_TO_OVERLAY);
			return INERT_COMPONENT;
		}
		if (open.settled) {
			done(open.settled);
			return INERT_COMPONENT;
		}
		open.attach(done);
		const session = new Session({
			tui,
			theme,
			params: typed,
			itemsByTab,
			done: (result) => open.settle(result),
			keybindings,
			editInput: async (value) => {
				try {
					const [{ SettingsManager }, { editWithExternalEditor }] = await Promise.all([
						import("@earendil-works/pi-coding-agent"),
						import("./state/external-editor.ts"),
					]);
					const editorCommand = SettingsManager.create(ctx.cwd, undefined, {
						projectTrusted: ctx.isProjectTrusted(),
					}).getExternalEditorCommand();
					if (!editorCommand) throw new Error("No external editor command is configured");
					return await editWithExternalEditor(tui, editorCommand, value);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`${t("editor.failed", "External editor failed")}: ${message}`, "error");
					return undefined;
				}
			},
			collapseKey,
			notesKey,
			canReopenWhileHidden,
			rowBudget: rowBudgetForHost(tui.terminal, presentation.rowBudget),
		});
		sessionRef.current = session;
		return session.component;
	};
}

const INERT_COMPONENT: import("./state/questionnaire-session.ts").QuestionnaireSessionComponent = {
	render: () => [],
	invalidate: () => {},
	handleInput: () => {},
};

async function mountQuestionnaire(config: {
	ctx: ExtensionContext;
	typed: QuestionParams;
	itemsByTab: WrappingSelectItem[][];
	collapseKey: string;
	notesKey: string;
	presentation: Presentation;
	open: OpenQuestionnaire;
	Session: SessionModule["QuestionnaireSession"];
}): Promise<QuestionnaireResult | undefined> {
	const { ctx, collapseKey, presentation } = config;
	const sessionRef: SessionRef = { current: null };
	const overlayHandleRef: OverlayHandleRef = { current: undefined };
	const removeOverlayInputListener = presentation.hideOnCollapse
		? registerCollapseKeyListener(ctx, collapseKey, sessionRef, overlayHandleRef)
		: undefined;
	const canReopenWhileHidden = removeOverlayInputListener !== undefined;
	try {
		return await ctx.ui.custom<QuestionnaireResult>(
			makeSessionFactory({ ...config, canReopenWhileHidden, sessionRef }),
			presentation.overlay
				? {
						overlay: true,
						overlayOptions: {
							anchor: "bottom-center",
							width: "100%",
							maxHeight: "100%",
							margin: { left: 0, right: 0, bottom: 0 },
						},
						onHandle: (handle) => {
							overlayHandleRef.current = handle;
							sessionRef.current?.setOverlayHandle(handle);
						},
					}
				: { overlay: false },
		);
	} finally {
		removeOverlayInputListener?.();
	}
}

async function resolveUndefinedResult(ctx: ExtensionContext, typed: QuestionParams) {
	if (hasDialogUI(ctx.ui)) {
		return buildQuestionnaireResponse(await runRpcQuestionnaire(ctx.ui, typed), typed);
	}
	return buildToolResult(ERROR_NO_CUSTOM_UI, { answers: [], cancelled: true, error: "no_custom_ui" });
}

async function runTuiPath(pi: ExtensionAPI, ctx: ExtensionContext, typed: QuestionParams, open: OpenQuestionnaire) {
	const itemsByTab: WrappingSelectItem[][] = typed.questions.map((q) => buildItemsForQuestion(q));
	let presentation: Presentation | undefined;

	emitAskUserBlockedEvent(pi, true, open.toolCallId);
	try {
		const sessionLoad = await loadQuestionnaireSession();
		if (open.settled) return buildQuestionnaireResponse(open.settled, typed);
		if (!sessionLoad.ok) {
			return buildToolResult(sessionLoad.message, { answers: [], cancelled: true, error: sessionLoad.error });
		}
		const { QuestionnaireSession } = sessionLoad.module;
		const config = loadConfig();
		const collapseKey = resolveCollapseKey(config);
		const notesKey = resolveNotesKey(config);
		const mount = (p: Presentation) =>
			Promise.race([
				mountQuestionnaire({
					ctx,
					typed,
					itemsByTab,
					collapseKey,
					notesKey,
					presentation: p,
					open,
					Session: QuestionnaireSession,
				}),
				open.answeredEarly,
			]);

		presentation = resolvePresentation();
		emitTerminalAttention();
		let result = await mount(presentation);
		if (result === YIELD_TO_OVERLAY) {
			presentation.release?.();
			presentation = STACKED_OVERLAY_PRESENTATION;
			result = await mount(presentation);
		}

		if (result === undefined) {
			open.host = "rpc";
			return await resolveUndefinedResult(ctx, typed);
		}

		return buildQuestionnaireResponse(result, typed);
	} finally {
		presentation?.release?.();
		emitAskUserBlockedEvent(pi, false, open.toolCallId);
	}
}

function prewarmSessionGraph(): void {
	const timer = setTimeout(() => void loadQuestionnaireSession().catch(() => undefined), PREWARM_DELAY_MS);
	timer.unref?.();
}

export function buildItemsForQuestion(question: QuestionData): WrappingSelectItem[] {
	const items: WrappingSelectItem[] = question.options.map((o) => ({
		kind: "option",
		label: o.label,
		description: o.description,
	}));
	for (const kind of sentinelsToAppend(question)) {
		items.push({ kind, label: displayLabel(kind) });
	}
	return items;
}

export const DEFAULT_PROMPT_SNIPPET = `Ask the user up to ${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) when requirements are ambiguous`;
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	`Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to ${MAX_QUESTIONS} questions per invocation.`,
	`Each question MUST have ${MIN_OPTIONS}-${MAX_OPTIONS} options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs. The user can additionally type a custom answer via the automatically appended "Type something." row on every question, or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.`,
	`Set multiSelect: true when multiple answers are valid. Provide an options[].preview markdown string when an option benefits from richer side-by-side context (mockups, code snippets, diagrams, configs) — single-select only. The "Type something." row is appended to every question; in preview mode it expands to the full pane width while typing so the custom answer is not cramped into the narrow options column. If you recommend a specific option, make that the first option and append "(Recommended)" to its label.`,
	"Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.",
];

export const DEFAULT_TOOL_DESCRIPTION = `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Users can type a custom answer via the automatically appended "Type something." row on every question or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.
- Use multiSelect: true when multiple answers are valid. The "Type something." row is available on every question, including when options carry a \`preview\`; in preview mode it expands to the full pane width while typing so the custom answer is not cramped into the narrow options column.
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).`;

export function registerAskUserQuestionTool(pi: ExtensionAPI): void {
	const guidance = validateGuidanceFields(loadConfig().guidance);
	const answers = registerAnswerChannel(pi);
	pi.registerTool({
		name: ASK_USER_QUESTION_TOOL_NAME,
		label: "Ask User Question",
		exposure: "model-only",
		description: guidance.description ?? DEFAULT_TOOL_DESCRIPTION,
		promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
		parameters: QuestionParamsSchema,
		prepareArguments: prepareQuestionArguments,
		summarize: (args) => summarizeAsk(args),
		renderCall: (args, theme) => renderAskCall(args, theme),
		renderResult: (result, { expanded }, theme, context) =>
			renderAskResult(result, context?.args, theme, { expanded, isError: context?.isError ?? false }),

		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const typed = normalizeQuestionParams(params as unknown as QuestionParams);
			if (!ctx.hasUI) return rejectWithoutUi();

			const validation = validateQuestionnaire(typed);
			if (!validation.ok) {
				return buildToolResult(validation.message, {
					answers: [],
					cancelled: true,
					error: validation.error,
				});
			}

			const viaRpc = (ctx as { mode?: string }).mode === "rpc" && hasDialogUI(ctx.ui);
			const open = answers.open(toolCallId, typed.questions, viaRpc ? "rpc" : "tui");
			try {
				emitAskUserPromptEvent(pi, typed, toolCallId);
				if (viaRpc) return await runRpcPath(pi, ctx.ui, typed, toolCallId);
				return await runTuiPath(pi, ctx, typed, open);
			} finally {
				answers.close(open);
			}
		},
	});

	prewarmSessionGraph();
}

export { buildQuestionnaireResponse, buildToolResult };
