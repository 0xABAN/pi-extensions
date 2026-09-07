import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { lock } from "proper-lockfile";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULTS, type Playback, type Settings } from "./types.ts";

export interface Tokens { access_token: string; refresh_token: string; expires_at: number; scope: string }
export interface Credentials { clientId?: string; tokens?: Tokens; grant?: string; needsAuth?: boolean }
export interface Cache { grant: string; nextPollAt: number; playback: Playback }
export interface Lease { signal: AbortSignal; check(): void }

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}
export const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
export const milliseconds = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function colors(value: unknown, solid = false): string[] {
  if (!Array.isArray(value) || (solid ? value.length !== 1 : value.length < 2)
    || !value.every(color => typeof color === "string" && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(color))) {
    throw new Error("Expected hex colors: one for solid, two or more for animated");
  }
  return value.map(color => (color.length === 4 ? "#" + [...color.slice(1)].map(c => c + c).join("") : color).toUpperCase());
}

function settings(value: unknown): Settings {
  const data = object(value), theme = object(data.theme);
  if (!["minimal", "medium", "full"].includes(data.layout as string) || !["above", "below"].includes(data.placement as string)
    || !["animated", "solid"].includes(theme.mode as string)
    || Object.keys(theme).some(key => key !== "mode" && key !== "colors")
    || Object.keys(data).some(key => !["layout", "placement", "theme", "customAnimated", "customSolid"].includes(key))) {
    throw new Error("Invalid DJ layout, placement, or theme settings");
  }
  return {
    layout: data.layout as Settings["layout"], placement: data.placement as Settings["placement"],
    theme: { mode: theme.mode as Settings["theme"]["mode"], colors: colors(theme.colors, theme.mode === "solid") },
    ...(data.customAnimated === undefined ? {} : { customAnimated: colors(data.customAnimated) }),
    ...(data.customSolid === undefined ? {} : { customSolid: colors(data.customSolid, true) }),
  };
}

function tokens(value: unknown): Tokens {
  const data = object(value);
  if (!text(data.access_token) || !text(data.refresh_token) || !milliseconds(data.expires_at)
    || typeof data.scope !== "string") throw new Error("Invalid Spotify tokens; reconnect with /dj auth");
  return { access_token: data.access_token, refresh_token: data.refresh_token, scope: data.scope,
    expires_at: data.expires_at };
}

function credentials(value: unknown): Credentials {
  const data = object(value);
  if ((data.clientId !== undefined && !text(data.clientId)) || (data.grant !== undefined && !text(data.grant))
    || (data.needsAuth !== undefined && typeof data.needsAuth !== "boolean")
    || Object.keys(data).some(key => !["clientId", "tokens", "grant", "needsAuth"].includes(key))) throw new Error("Invalid Spotify credentials");
  return { ...data, ...(data.tokens === undefined ? {} : { tokens: tokens(data.tokens) }) } as Credentials;
}

function cache(value: unknown): Cache {
  const data = object(value), playback = object(data.playback);
  if (typeof data.grant !== "string" || !milliseconds(data.nextPollAt) || !milliseconds(playback.sampledAt)
    || !["playing", "paused", "idle", "offline", "auth"].includes(playback.status as string)
    || (playback.message !== undefined && typeof playback.message !== "string")) throw new Error("Invalid DJ playback cache");
  if (playback.track !== undefined) {
    const track = object(playback.track);
    if (typeof track.name !== "string" || typeof track.artists !== "string" || !milliseconds(track.progressMs)
      || !milliseconds(track.durationMs) || track.progressMs > track.durationMs) throw new Error("Invalid DJ cached track");
  } else if (playback.status === "playing") throw new Error("Playing cache has no track");
  return data as unknown as Cache;
}

function read<T>(path: string, validate: (value: unknown) => T): T | undefined {
  try { return validate(JSON.parse(readFileSync(path, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${path}: ${error instanceof SyntaxError ? "invalid JSON" : (error as Error).message}`);
  }
}

export function createStore(directory: string, legacyDirectory?: string) {
  const settingsPath = join(directory, "settings.json"), credentialsPath = join(directory, "spotify_tokens.json");
  const cachePath = join(directory, "playback.json");
  const readSettings = () => read(settingsPath, settings) ?? structuredClone(DEFAULTS);
  const readCredentials = () => read(credentialsPath, credentials) ?? {};
  const readCache = () => read(cachePath, cache);

  // Synchronous rename keeps the abort/ownership check and commit in one event-loop turn.
  function write(path: string, value: unknown, lease: Lease) {
    lease.check();
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
      lease.check();
      renameSync(temporary, path);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }

  async function locked<T>(name: string, work: (lease: Lease) => Promise<T>, signal?: AbortSignal, wait = true): Promise<T> {
    signal?.throwIfAborted();
    const lost = new AbortController(), lockPath = join(directory, `.${name}.lock`);
    let release: () => Promise<void>;
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        // proper-lockfile keys ownership by target, not by lockfilePath.
        release = await lock(join(directory, name), { realpath: false, lockfilePath: lockPath,
          stale: 30_000, update: 1_000, onCompromised: error => lost.abort(error) });
        break;
      } catch (error) {
        if (!wait || attempt >= 40 || (error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
        await delay(250, undefined, { signal });
      }
    }
    const combined = signal ? AbortSignal.any([signal, lost.signal]) : lost.signal;
    const identity = statSync(lockPath);
    function ownsLock() {
      try { const current = statSync(lockPath); return current.ino === identity.ino && current.dev === identity.dev; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    }
    const lease: Lease = { signal: combined, check() {
      if (!ownsLock()) lost.abort(new Error("DJ state lock ownership lost"));
      combined.throwIfAborted();
    } };
    try { lease.check(); const result = await work(lease); lease.check(); return result; }
    finally { if (!lost.signal.aborted && ownsLock()) await release(); }
  }

  return {
    async initialize() {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const legacy = () => legacyDirectory ? read(join(legacyDirectory, "config.json"), object) ?? {} : {};
      await locked("settings", async lease => {
        if (existsSync(settingsPath)) { readSettings(); return; }
        const placement = legacy().pi_placement;
        if (placement !== undefined && placement !== "above" && placement !== "below") throw new Error("Invalid legacy DJ placement");
        write(settingsPath, settings({ ...DEFAULTS, placement: placement ?? DEFAULTS.placement }), lease);
      });
      await locked("spotify", async lease => {
        if (existsSync(credentialsPath)) { readCredentials(); return; }
        const clientId = legacy().spotify_client_id;
        if (clientId !== undefined && !text(clientId)) throw new Error("Invalid legacy Spotify client ID");
        const imported = legacyDirectory ? read(join(legacyDirectory, "spotify_tokens.json"), tokens) : undefined;
        if (imported && imported.expires_at < 1e12) imported.expires_at *= 1000;
        write(credentialsPath, credentials({ clientId, tokens: imported, grant: randomUUID() }), lease);
      });
      readCache();
      for (const path of [settingsPath, credentialsPath, cachePath]) if (existsSync(path)) chmodSync(path, 0o600);
    },
    readSettings, readCredentials, readCache,
    async updateSettings(patch: Partial<Settings>) {
      return locked("settings", async lease => {
        const next = settings({ ...readSettings(), ...patch });
        write(settingsPath, next, lease);
        return next;
      });
    },
    getClientId: () => process.env.SPOTIFY_CLIENT_ID?.trim() || readCredentials().clientId,
    withLock: <T>(work: (lease: Lease) => Promise<T>, signal?: AbortSignal, wait = true) => locked("spotify", work, signal, wait),
    writeCredentials: (value: Credentials, lease: Lease) => write(credentialsPath, credentials(value), lease),
    writeCache: (value: Cache, lease: Lease) => write(cachePath, cache(value), lease),
    clearCache(lease: Lease) { lease.check(); if (existsSync(cachePath)) unlinkSync(cachePath); },
  };
}
export type Store = ReturnType<typeof createStore>;
