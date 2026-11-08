import type { Context } from "@earendil-works/pi-ai";
import { createSession, getSessionPath } from "cc-session-io";
import { readFileSync, realpathSync, statSync } from "fs";
import { collectCarriedAttachments } from "./attachments.js";
import { DEBUG, debug } from "./debug.js";
import { digestMessages } from "./message-digests.js";
import { notify } from "./notify.js";
import { activeQueryContexts } from "./query-state.js";
import { deleteSessionState, loadSessionState } from "./session-store.js";
import { compareHistory, copyRecording, importHistory, type Recording, type SessionState } from "./session-sync.js";
import { readTranscript, recordedToolResults, resolveRecordingCut, savePrefixSession } from "./session-transcript.js";
import { verifyWrittenSession as _verifyWrittenSession } from "./session-verify.js";
import { nonSystemMessages } from "./transcript.js";
import { turnStart } from "./user-prompt.js";

export const sharedSessions = new Map<string, SessionState>();

const loadedSessionStates = new Set<string>();

export const sessionWriters = new Map<string, Promise<void>>();

let sessionCwd: string | null = null;

export function setSessionCwd(cwd: string): void {
	sessionCwd = cwd;
}

export function currentCwd(): string {
	if (!sessionCwd) throw new Error("claude-bridge: no pi session has started");
	return sessionCwd;
}

export function sessionStateFor(piSessionId: string | null | undefined): SessionState | null {
	if (piSessionId == null) return null;
	if (!loadedSessionStates.has(piSessionId)) {
		const stored = loadSessionState(piSessionId, (message) =>
			debug("session_state_rejected", { piSessionId, message }),
		);
		loadedSessionStates.add(piSessionId);
		if (stored) sharedSessions.set(piSessionId, stored);
	}
	return sharedSessions.get(piSessionId) ?? null;
}

export function inheritSessionState(parentFile: string, piSessionId: string): void {
	let text: string;
	try {
		text = readFileSync(parentFile, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const header = JSON.parse(text.split("\n", 1)[0]);
	if (header?.type !== "session" || typeof header.id !== "string")
		throw new Error(`no session header in ${parentFile}`);
	const parent = sessionStateFor(header.id);
	if (!parent) return;
	setSessionStateFor(piSessionId, { ...parent, ...copyRecording(parent), dirtyTail: true });
	debug(`session_start:fork: inherited ${parent.ccSessionId} from piSession=${header.id} ${sessionTag(piSessionId)}`);
}

export function setSessionStateFor(piSessionId: string, state: SessionState | null): void {
	loadedSessionStates.add(piSessionId);
	if (state === null) sharedSessions.delete(piSessionId);
	else sharedSessions.set(piSessionId, state);
}

export const historyRewrittenBySession = new Set<string>();

export function markRebuildForSession(piSession: string | null, event: string): void {
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

interface SyncResult {
	sessionId: string | null;
	targetSessionId: string;
	created: boolean;
	forkAt?: string;
	recorded: Recording;
	state: SessionState | null;
}

export async function waitForSessionWriter(sessionId: string | undefined, signal?: AbortSignal): Promise<void> {
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
	return {
		digests: recorded.digests.slice(0, count),
		uuids: recorded.uuids.slice(0, count),
		cuttable: recorded.cuttable.slice(0, count),
	};
}

function verifyWrittenSession(
	jsonlPath: string,
	expectedSessionId: string,
	expectedRecordCount: number,
	cwd: string,
): void {
	const warnings = _verifyWrittenSession(jsonlPath, expectedSessionId, expectedRecordCount);
	for (const msg of warnings) {
		debug("session_verify_fail", {
			msg,
			jsonlPath,
			cwd,
			realpath: safeRealpath(cwd),
			claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null,
		});
		notify(`claude-bridge: Claude Code session file issue: ${msg}`, "warning");
	}
}

function safeRealpath(p: string): string {
	try {
		return realpathSync(p);
	} catch (e) {
		return `<failed: ${(e as Error).message}>`;
	}
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
	} catch {}
	debug(`${label}: cwd=${cwd}`);
	if (realCwd !== cwd)
		debug(`${label}: realpath(cwd)=${realCwd} (DIFFERS — symlink-resolved path is what CC SDK uses)`);
	debug(`${label}: jsonlPath=${jsonlPath}`);
	debug(`${label}: fileExists=${fileExists}${fileSize != null ? ` size=${fileSize}` : ""}`);
	debug(
		`${label}: env.CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"} HOME=${process.env.HOME ?? "(unset)"}`,
	);
}

export function syncSharedSession(
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
	const compared = state
		? compareHistory(digestMessages(priors), state)
		: { commonPrefix: 0, cutCount: 0, equal: false };
	let missingFile = false;
	if (state) {
		try {
			statSync(getSessionPath(state.ccSessionId, state.cwd, process.env.CLAUDE_CONFIG_DIR));
		} catch (error) {
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
	const row =
		piSessionId == null
			? 0
			: !state
				? priors.length
					? 2
					: 1
				: state.model !== modelId || promptChanged
					? 3
					: cwdChanged
						? 5
						: compared.equal && !state.dirtyTail
							? 4
							: !compared.cutCount
								? 5
								: compared.cutCount === priors.length
									? 6
									: 7;
	const reason =
		piSessionId == null
			? "unattributed-history"
			: missingFile
				? "missing-transcript"
				: !state
					? "no-state"
					: state.model !== modelId
						? "model-changed"
						: promptChanged
							? "prompt-changed"
							: cwdChanged
								? "cwd-changed"
								: row === 4
									? "equal-digests"
									: state.dirtyTail && compared.equal
										? "dirty-tail"
										: "history-difference";
	const decision = (path: string, after: string) => {
		debug(
			`syncResult: path=${path} sessionId=${after} from=${before?.ccSessionId ?? "none"} priors=${priors.length} commonPrefix=${compared.commonPrefix} cutCount=${compared.cutCount} row=${row} reason=${reason} ${sessionTag(piSessionId)}`,
		);
	};
	if (row === 4) {
		decision("reuse", state!.ccSessionId);
		return {
			sessionId: state!.ccSessionId,
			targetSessionId: state!.ccSessionId,
			created: false,
			recorded: copyRecording(state!),
			state,
		};
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
		const suffix = importHistory(
			session,
			rest,
			customToolNameToSdk,
			collectCarriedAttachments(replaced),
			recordedToolResults(replaced, state!.digests, rest),
		);
		recorded = {
			digests: [...recorded.digests, ...suffix.digests],
			uuids: [...recorded.uuids, ...suffix.uuids],
			cuttable: [...recorded.cuttable, ...suffix.cuttable],
		};
		records = savePrefixSession(session, transcript.slice(0, cut.index + 1), cut.uuid);
	} else {
		const transcript = state ? readTranscript(state) : [];
		recorded = importHistory(
			session,
			priors,
			customToolNameToSdk,
			collectCarriedAttachments(transcript),
			recordedToolResults(transcript, state?.digests ?? [], priors),
		);
		session.save();
		records = session.records.length;
	}
	if (records) verifyWrittenSession(session.jsonlPath, targetSessionId, records, cwd);
	decision(row === 7 ? "prefix-write" : records ? "rebuild" : "clean-start", targetSessionId);
	debugSessionPaths(targetSessionId.slice(0, 8), cwd, session.jsonlPath);
	return { sessionId: records ? targetSessionId : null, targetSessionId, created: true, recorded, state };
}

export function sessionTag(piSessionId: string | null | undefined): string {
	return `piSession=${piSessionId ?? "none"}`;
}
