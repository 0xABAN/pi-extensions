import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { createHash, randomBytes } from "node:crypto";
import { getSessionPath, normalizeProjectPath } from "cc-session-io";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

interface TraceRun {
	dir: string;
	raw: boolean;
	proxy: string | undefined;
	maxArtifactBytes: number;
	maxRunBytes: number;
	artifactBytes: number;
	seq: number;
	ids: number;
	incomplete: string | null;
	signals: WeakMap<AbortSignal, string>;
	manifest: Record<string, unknown>;
}

const RUN_KEY = Symbol.for("claude-bridge:cacheTrace");
const INSTANCE = randomBytes(3).toString("hex");

let notify: (message: string) => void = (message) => console.error(message);

export function setTraceNotifier(fn: (message: string) => void): void {
	notify = fn;
}

function run(): TraceRun | null {
	const root = process.env.CLAUDE_BRIDGE_TRACE_DIR;
	if (!root) return null;
	const g = globalThis as Record<symbol, unknown>;
	return (g[RUN_KEY] as TraceRun | undefined) ?? (g[RUN_KEY] = startRun(root)) as TraceRun;
}

export function resetTraceForTests(): void {
	delete (globalThis as Record<symbol, unknown>)[RUN_KEY];
}

export function packageVersion(name: string): string | null {
	try {
		const require = createRequire(import.meta.url);
		let dir = dirname(require.resolve(name));
		while (!existsSync(join(dir, "package.json"))) dir = dirname(dir);
		return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version ?? null;
	} catch {
		return null;
	}
}

export const BRIDGE_VERSION: string = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version;

function startRun(root: string): TraceRun {
	const proxy = process.env.CLAUDE_BRIDGE_TRACE_PROXY?.replace(/\/$/, "") || undefined;
	const r: TraceRun = {
		dir: join(root, `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`),
		raw: process.env.CLAUDE_BRIDGE_TRACE_RAW === "1",
		proxy,
		maxArtifactBytes: Number(process.env.CLAUDE_BRIDGE_TRACE_MAX_ARTIFACT_BYTES ?? 64 * 1024 * 1024),
		maxRunBytes: Number(process.env.CLAUDE_BRIDGE_TRACE_MAX_RUN_BYTES ?? 2 * 1024 * 1024 * 1024),
		artifactBytes: 0,
		seq: 0,
		ids: 0,
		incomplete: null,
		signals: new WeakMap(),
		manifest: {},
	};
	r.manifest = {
		schema: 1,
		run: r.dir.split("/").pop(),
		startedAt: new Date().toISOString(),
		endedAt: null,
		incomplete: null,
		pid: process.pid,
		platform: `${process.platform}-${process.arch}`,
		node: process.version,
		bridge: BRIDGE_VERSION,
		sdk: packageVersion("@anthropic-ai/claude-agent-sdk"),
		pi: PI_VERSION,
		recording: r.raw ? "raw" : "shape",
		routing: proxy ? { mode: "per-query-base-url", proxy } : null,
		limits: { maxArtifactBytes: r.maxArtifactBytes, maxRunBytes: r.maxRunBytes },
	};
	try {
		mkdirSync(join(r.dir, "artifacts"), { recursive: true, mode: 0o700 });
		writeFileSync(join(r.dir, "manifest.json"), JSON.stringify(r.manifest, null, 1), { mode: 0o600 });
	} catch (error) {
		latch(r, error);
		return r;
	}
	if (proxy && process.env.ANTHROPIC_BASE_URL) latch(r, new Error("CLAUDE_BRIDGE_TRACE_PROXY set but ANTHROPIC_BASE_URL is already configured"));
	process.on("exit", () => {
		try {
			writeFileSync(join(r.dir, "manifest.json"), JSON.stringify({ ...r.manifest, endedAt: new Date().toISOString(), incomplete: r.incomplete, events: r.seq, artifactBytes: r.artifactBytes }, null, 1));
		} catch {
		}
	});
	return r;
}

function latch(r: TraceRun, error: unknown): void {
	if (r.incomplete) return;
	r.incomplete = error instanceof Error ? error.message : String(error);
	try {
		writeFileSync(join(r.dir, "manifest.json"), JSON.stringify({ ...r.manifest, incomplete: r.incomplete }, null, 1), { mode: 0o600 });
	} catch {
	}
	notify(`Claude bridge cache trace is incomplete and stopped recording: ${r.incomplete} (${r.dir})`);
}

export function digest(value: unknown): string {
	return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex").slice(0, 32);
}

function write(r: TraceRun, type: string, fields: Record<string, unknown>, strict: boolean): void {
	const line = `${JSON.stringify({ seq: r.seq + 1, at: new Date().toISOString(), instance: INSTANCE, type, ...fields })}\n`;
	if (r.incomplete) {
		if (strict) throw new Error(`Claude bridge cache trace is incomplete: ${r.incomplete}`);
		return;
	}
	try {
		appendFileSync(join(r.dir, "events.jsonl"), line, { mode: 0o600 });
		r.seq++;
	} catch (error) {
		latch(r, error);
		if (strict) throw error;
	}
}

export function traceId(kind: string): string | undefined {
	const r = run();
	return r ? `${kind}-${INSTANCE}-${++r.ids}` : undefined;
}

export function traceSignalId(signal: AbortSignal | undefined): string | undefined {
	const r = run();
	if (!r || !signal) return undefined;
	let id = r.signals.get(signal);
	if (!id) r.signals.set(signal, id = `signal-${INSTANCE}-${++r.ids}`);
	return id;
}

export function traceEvent(type: string, fields: Record<string, unknown>): void {
	const r = run();
	if (r) write(r, type, fields, false);
}

export function traceStrict(type: string, fields: Record<string, unknown>): void {
	const r = run();
	if (r) write(r, type, fields, true);
}

export function traceAssertReady(): void {
	const r = run();
	if (r?.incomplete) throw new Error(`Claude bridge cache trace is incomplete: ${r.incomplete}`);
}

export function traceQueryStart<E extends Record<string, string | undefined>>(
	queryId: string | undefined,
	fields: Record<string, unknown> & { digests?: Record<string, unknown> },
	env: E,
): E {
	const r = run();
	if (!r || !queryId) return env;
	const { digests, ...rest } = fields;
	const hashed = digests && Object.fromEntries(Object.entries(digests).map(([k, v]) => [k, v === undefined ? null : digest(v)]));
	let kept: Record<string, unknown> | undefined;
	try {
		kept = r.raw && digests && !r.incomplete
			? Object.fromEntries(Object.entries(digests).filter(([, v]) => v !== undefined).map(([k, v]) => [k, artifact(r, v)]))
			: undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === undefined) throw error;
		latch(r, error);
		throw error;
	}
	write(r, "query-start", { queryId, ...rest, ...(hashed ? { digests: hashed } : {}), ...(kept ? { artifacts: kept } : {}), route: r.proxy ? queryId : null }, true);
	return r.proxy ? { ...env, _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1", ANTHROPIC_BASE_URL: `${r.proxy}/q/${queryId}` } : env;
}

const BOOKKEEPING = new Set(["timestamp", "usage", "responseId", "responseModel", "diagnostics", "details", "providerThinkingLevel", "thinkingLevel"]);

function projectMessage(message: Record<string, unknown>): Record<string, unknown> {
	const source = Object.fromEntries(Object.entries(message).filter(([key]) => !BOOKKEEPING.has(key)));
	const content = message.content;
	const blocks = typeof content === "string"
		? [{ type: "string", digest: digest(content) }]
		: Array.isArray(content)
			? content.map((block: Record<string, unknown>) => ({
				type: block.type,
				keys: Object.keys(block),
				digest: digest(block),
				...(block.type === "toolCall" ? { id: block.id, name: block.name } : {}),
			}))
			: [{ type: typeof content }];
	return {
		role: message.role,
		keys: Object.keys(message),
		digest: digest(source),
		blocks,
		...(message.role === "toolResult" ? { toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError } : {}),
		...(message.role === "assistant" ? { provider: message.provider, stopReason: message.stopReason } : {}),
	};
}

function artifact(r: TraceRun, value: unknown): { artifact?: string; artifactRejected?: string } {
	if (!r.raw) return {};
	const text = JSON.stringify(value);
	const name = `${digest(text)}.json`;
	const path = join(r.dir, "artifacts", name);
	if (existsSync(path)) return { artifact: name };
	const bytes = Buffer.byteLength(text);
	if (bytes > r.maxArtifactBytes) return { artifactRejected: "max-artifact-bytes" };
	if (r.artifactBytes + bytes > r.maxRunBytes) return { artifactRejected: "max-run-bytes" };
	writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
	renameSync(`${path}.tmp`, path);
	r.artifactBytes += bytes;
	return { artifact: name };
}

export function traceInput(callId: string | undefined, source: Context, effective: Context, model: Model<any>, options: SimpleStreamOptions | undefined): void {
	const r = run();
	if (!r || !callId || r.incomplete) return;
	try {
		const sameAsSource = source === effective;
		write(r, "input", {
			callId,
			piSessionId: options?.sessionId ?? null,
			signal: traceSignalId(options?.signal),
			model: model.id,
			reasoning: options?.reasoning ?? null,
			cacheRetention: options?.cacheRetention ?? null,
			source: { messages: source.messages.map((m) => projectMessage(m as unknown as Record<string, unknown>)), ...artifact(r, source) },
			effective: sameAsSource ? "source" : {
				systemPrompt: effective.systemPrompt === undefined ? null : digest(effective.systemPrompt),
				tools: (effective.tools ?? []).map((tool) => ({ name: tool.name, digest: digest(tool) })),
				messages: effective.messages.map((m) => projectMessage(m as unknown as Record<string, unknown>)),
				...artifact(r, effective),
			},
		}, false);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === undefined) throw error;
		latch(r, error);
	}
}

type SnapshotWriter = "no-known-writer";

export function traceSnapshot(
	fields: { ccSession: string; cwd: string; mirrorCwd?: string; reason: string; writer: SnapshotWriter; callId?: string; queryId?: string },
	strict: boolean,
): void {
	const r = run();
	if (!r) return;
	if (r.incomplete) {
		if (strict) throw new Error(`Claude bridge cache trace is incomplete: ${r.incomplete}`);
		return;
	}
	let record: Record<string, unknown>;
	try {
		record = snapshot(r, fields);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === undefined) throw error;
		latch(r, error);
		if (strict) throw error;
		return;
	}
	write(r, "snapshot", record, strict);
}

function snapshot(r: TraceRun, fields: { ccSession: string; cwd: string; mirrorCwd?: string; reason: string; writer: SnapshotWriter }): Record<string, unknown> {
	const jsonl = getSessionPath(fields.ccSession, normalizeProjectPath(fields.cwd), process.env.CLAUDE_CONFIG_DIR);
	const projectDir = dirname(jsonl);
	const companion = jsonl.slice(0, -".jsonl".length);
	if (!r.raw) return { ...fields, jsonl, recorded: false, bytes: existsSync(jsonl) ? statSync(jsonl).size : null };

	const snapshotId = `snap-${INSTANCE}-${++r.ids}`;
	const dir = join(r.dir, "snapshots", snapshotId);
	const files: Array<{ path: string; bytes: number; sha256: string }> = [];
	const rejected: Array<{ path: string; reason: string }> = [];
	let changedDuringCopy = false;
	let jsonlText: string | null = null;
	const copy = (abs: string, rel: string) => {
		const before = lstatSync(abs);
		if (before.isSymbolicLink()) return void rejected.push({ path: rel, reason: "symlink" });
		if (before.isDirectory()) {
			for (const name of readdirSync(abs).sort()) copy(join(abs, name), `${rel}/${name}`);
			return;
		}
		if (!before.isFile()) return void rejected.push({ path: rel, reason: "not-a-file" });
		if (before.size > r.maxArtifactBytes) return void rejected.push({ path: rel, reason: "max-artifact-bytes" });
		if (r.artifactBytes + before.size > r.maxRunBytes) return void rejected.push({ path: rel, reason: "max-run-bytes" });
		const data = readFileSync(abs);
		const after = statSync(abs);
		if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || data.length !== before.size) changedDuringCopy = true;
		const target = join(dir, "files", rel);
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		writeFileSync(`${target}.tmp`, data, { mode: 0o600 });
		renameSync(`${target}.tmp`, target);
		r.artifactBytes += data.length;
		files.push({ path: rel, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
		if (abs === jsonl) jsonlText = data.toString("utf8");
	};
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const jsonlPresent = lstatSync(jsonl, { throwIfNoEntry: false }) !== undefined;
	if (jsonlPresent) copy(jsonl, basename(jsonl));
	if (lstatSync(companion, { throwIfNoEntry: false })) copy(companion, basename(companion));

	const projectsRoot = dirname(projectDir);
	const missingReferences = new Set<string>();
	const externalReferences = new Set<string>();
	const named = (jsonlText as string | null)?.match(new RegExp(`${projectsRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^\\s"'<>\\\\]+`, "g")) ?? [];
	for (const raw of new Set(named)) {
		const path = resolve(raw.replace(/[.,;:)\]]+$/, ""));
		if (path === jsonl) continue;
		if (path.startsWith(companion + sep)) {
			const rel = relative(projectDir, path);
			if (!files.some((f) => f.path === rel || f.path.startsWith(rel + "/"))) missingReferences.add(rel);
		} else externalReferences.add(relative(projectsRoot, path));
	}

	const manifest = {
		snapshotId, ...fields, jsonl, takenAt: new Date().toISOString(),
		complete: jsonlPresent && !rejected.length && !missingReferences.size && !externalReferences.size && !changedDuringCopy,
		jsonlPresent, changedDuringCopy, files, rejected,
		missingReferences: [...missingReferences], externalReferences: [...externalReferences],
	};
	writeFileSync(join(dir, "manifest.json.tmp"), JSON.stringify(manifest, null, 1), { mode: 0o600 });
	renameSync(join(dir, "manifest.json.tmp"), join(dir, "manifest.json"));
	const { files: _files, ...summary } = manifest;
	return { ...summary, recorded: true, fileCount: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) };
}
