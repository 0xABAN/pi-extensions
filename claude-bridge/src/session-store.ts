import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { InvalidRecordingError, type SessionState, validateRecording } from "./session-sync.js";

const FORMAT_VERSION = 1;

function sessionsDir(): string {
	return join(getAgentDir(), "claude-bridge", "sessions");
}

function stateFileName(piSessionId: string): string {
	const hash = createHash("sha256").update(piSessionId, "utf16le").digest("hex");
	return `s-${hash}.json`;
}

function statePath(piSessionId: string): string {
	return join(sessionsDir(), stateFileName(piSessionId));
}

export function loadSessionState(piSessionId: string): SessionState | null {
	let text: string;
	try {
		text = readFileSync(statePath(piSessionId), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}

	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		if (error instanceof SyntaxError) return null;
		throw error;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const stored = value as Record<string, unknown>;
	if (!("version" in stored)) return null;
	if (stored.version !== FORMAT_VERSION) return null;
	for (const key of ["ccSessionId", "cwd", "model", "promptDigest", "digests", "uuids", "cuttable"] as const) {
		if (!(key in stored)) return null;
	}
	for (const key of ["ccSessionId", "cwd", "model", "promptDigest"] as const) {
		if (typeof stored[key] !== "string") return null;
		if (stored[key] === "") return null;
	}
	if (!Array.isArray(stored.digests) || !Array.isArray(stored.uuids) || !Array.isArray(stored.cuttable)) {
		return null;
	}
	try {
		validateRecording({
			digests: stored.digests as string[],
			uuids: stored.uuids as (string | null)[],
			cuttable: stored.cuttable as boolean[],
		});
	} catch (error) {
		if (error instanceof InvalidRecordingError) return null;
		throw error;
	}
	return {
		ccSessionId: stored.ccSessionId as string,
		cwd: stored.cwd as string,
		model: stored.model as string,
		promptDigest: stored.promptDigest as string,
		digests: stored.digests as string[],
		uuids: stored.uuids as (string | null)[],
		cuttable: stored.cuttable as boolean[],
		dirtyTail: true,
	};
}

export function saveSessionState(piSessionId: string, state: SessionState): void {
	for (const key of ["ccSessionId", "cwd", "model", "promptDigest"] as const) {
		if (typeof state[key] !== "string" || state[key] === "") throw new Error(`${key} must be a non-empty string`);
	}
	validateRecording(state);
	const dir = sessionsDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const path = join(dir, stateFileName(piSessionId));
	const tempPath = join(dir, `.${randomUUID()}.tmp`);
	const contents = JSON.stringify({
		version: FORMAT_VERSION,
		ccSessionId: state.ccSessionId,
		cwd: state.cwd,
		model: state.model,
		promptDigest: state.promptDigest,
		digests: state.digests,
		uuids: state.uuids,
		cuttable: state.cuttable,
	});
	writeFileSync(tempPath, contents, { flag: "wx", mode: 0o600 });
	chmodSync(tempPath, 0o600);
	renameSync(tempPath, path);
}

export function deleteSessionState(piSessionId: string): void {
	rmSync(statePath(piSessionId), { force: true });
}
