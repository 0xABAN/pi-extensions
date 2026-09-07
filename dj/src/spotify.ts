import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { milliseconds, object, text, type Store, type Tokens } from "./state.ts";
import type { Playback } from "./types.ts";

const SCOPE = "user-read-playback-state", TOKEN_URL = "https://accounts.spotify.com/api/token";
class SpotifyFailure extends Error {
  constructor(message: string, readonly auth = false, readonly retryMs = 30_000, readonly unauthorized = false) { super(message); }
}

function snapshot(value: unknown, sampledAt: number): Playback {
  const data = object(value);
  if (typeof data.is_playing !== "boolean") throw new Error("Invalid Spotify playback state");
  if (!data.item) return { status: data.is_playing ? "idle" : "paused", sampledAt };
  const item = object(data.item);
  if (item.type !== "track" || !text(item.id)) return { status: "idle", sampledAt };
  if (typeof item.name !== "string" || !Array.isArray(item.artists)
    || !item.artists.every(artist => typeof object(artist).name === "string")
    || !milliseconds(item.duration_ms) || (data.progress_ms !== null && !milliseconds(data.progress_ms))) {
    throw new Error("Invalid Spotify track");
  }
  return { status: data.is_playing ? "playing" : "paused", sampledAt, track: {
    name: item.name, artists: item.artists.map(artist => object(artist).name).join(", "),
    progressMs: Math.min(Number(data.progress_ms ?? 0), item.duration_ms), durationMs: item.duration_ms,
  } };
}

export function createSpotify(store: Store, options: { fetch?: typeof fetch; now?: () => number } = {}) {
  const request = options.fetch ?? fetch, now = options.now ?? Date.now;
  async function checked(url: string, init: RequestInit, signal: AbortSignal) {
    signal.throwIfAborted();
    const response = await request(url, { ...init, signal });
    signal.throwIfAborted();
    if (response.ok) return response;
    if (response.status === 429) {
      const header = response.headers.get("Retry-After");
      const delay = header === null ? NaN : /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - now();
      throw new SpotifyFailure("Spotify rate limited; waiting to retry", false, Number.isFinite(delay) && delay > 0 ? Math.max(5_000, delay) : 30_000);
    }
    if (response.status === 401 || response.status === 403) throw new SpotifyFailure("Reconnect Spotify with /dj auth", true, 30_000, response.status === 401);
    if (url === TOKEN_URL && response.status === 400) {
      const body = object(await response.json());
      if (body.error === "invalid_grant" || body.error === "invalid_client") throw new SpotifyFailure("Reconnect Spotify with /dj auth", true);
    }
    throw new SpotifyFailure(`Spotify unavailable (HTTP ${response.status})`);
  }

  async function exchange(parameters: Record<string, string>, signal: AbortSignal, previous?: Tokens): Promise<Tokens> {
    const response = await checked(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(parameters) }, signal);
    const data = object(await response.json());
    const refreshToken = data.refresh_token ?? previous?.refresh_token, scope = data.scope ?? previous?.scope ?? SCOPE;
    if (!text(data.access_token) || !text(refreshToken) || !milliseconds(data.expires_in) || data.expires_in === 0
      || typeof scope !== "string" || (data.token_type !== undefined && String(data.token_type).toLowerCase() !== "bearer")) {
      throw new SpotifyFailure("Spotify returned invalid credentials");
    }
    if (!scope.split(/\s+/).includes(SCOPE)) throw new SpotifyFailure("Spotify playback permission missing; reconnect with /dj auth", true);
    return { access_token: data.access_token, refresh_token: refreshToken, scope, expires_at: now() + data.expires_in * 1000 };
  }

  async function poll(signal: AbortSignal): Promise<Playback> {
    signal.throwIfAborted();
    try {
      return await store.withLock(async lease => {
        const credentials = store.readCredentials(), cached = store.readCache();
        const grant = credentials.grant ?? "", previous = cached?.grant === grant ? cached : undefined;
        if (previous && now() < previous.nextPollAt) return previous.playback;
        const clientId = store.getClientId();
        let tokens = credentials.tokens, refreshed = false, retryMs = 5_000, playback: Playback;
        const networkSignal = AbortSignal.any([lease.signal, AbortSignal.timeout(10_000)]);
        async function refresh() {
          tokens = await exchange({ grant_type: "refresh_token", refresh_token: tokens!.refresh_token, client_id: clientId! }, networkSignal, tokens);
          networkSignal.throwIfAborted();
          lease.check();
          store.writeCredentials({ ...credentials, tokens }, lease);
          refreshed = true;
        }
        try {
          if (!clientId || !tokens || credentials.needsAuth || !tokens.scope.split(/\s+/).includes(SCOPE)) {
            throw new SpotifyFailure(!clientId ? "Set a Spotify client ID with /dj auth" : "Connect Spotify with /dj auth", true);
          }
          if (tokens.expires_at <= now() + 30_000) await refresh();
          const fetchPlayback = () => checked("https://api.spotify.com/v1/me/player", { headers: { Authorization: `Bearer ${tokens!.access_token}` } }, networkSignal);
          let response: Response;
          try { response = await fetchPlayback(); }
          catch (error) {
            if (!(error instanceof SpotifyFailure) || !error.unauthorized || refreshed) throw error;
            await refresh();
            response = await fetchPlayback();
          }
          playback = response.status === 204 ? { status: "idle", sampledAt: now() } : snapshot(await response.json(), now());
          networkSignal.throwIfAborted();
        } catch (error) {
          lease.check();
          const failure = error instanceof SpotifyFailure ? error : new SpotifyFailure("Spotify offline; waiting to retry");
          retryMs = failure.auth ? 60_000 : failure.retryMs;
          playback = { status: failure.auth ? "auth" : "offline", sampledAt: now(), message: failure.message,
            ...(previous?.playback.track ? { track: previous.playback.track } : {}) };
          if (failure.auth && !credentials.needsAuth) store.writeCredentials({ ...credentials, tokens, needsAuth: true }, lease);
        }
        store.writeCache({ grant, nextPollAt: now() + retryMs, playback }, lease);
        return playback;
      }, signal, false);
    } catch (error) {
      signal.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
      const credentials = store.readCredentials(), cached = store.readCache();
      return cached?.grant === (credentials.grant ?? "") ? cached.playback
        : { status: "offline", sampledAt: now(), message: "Spotify is updating in another session" };
    }
  }

  async function authorize(clientId: string, onUrl: (url: string) => void | Promise<void>, signal: AbortSignal): Promise<void> {
    if (!text(clientId)) throw new Error("Spotify client ID is required");
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
    deadline.throwIfAborted();
    const verifier = randomBytes(64).toString("base64url"), state = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    let accept!: (code: string) => void, fail!: (error: Error) => void;
    const authorization = new Promise<string>((resolve, reject) => { accept = resolve; fail = reject; });
    // A callback/abort may arrive before onUrl has finished opening the browser.
    void authorization.catch(() => {});
    const abort = () => fail(deadline.reason);
    deadline.addEventListener("abort", abort, { once: true });
    const server = createServer((request, response) => {
      let url: URL;
      try { url = new URL(request.url ?? "/", "http://127.0.0.1"); }
      catch { response.writeHead(400).end("Invalid callback URL"); return; }
      const returnedState = url.searchParams.get("state") ?? "";
      const validState = url.searchParams.getAll("state").length === 1 && Buffer.byteLength(returnedState) === Buffer.byteLength(state)
        && timingSafeEqual(Buffer.from(returnedState), Buffer.from(state));
      if (request.method !== "GET" || url.pathname !== "/callback" || !validState) {
        response.writeHead(400).end("Not a Spotify authorization callback"); return;
      }
      const codes = url.searchParams.getAll("code"), errors = url.searchParams.getAll("error");
      if (errors.length === 1 && text(errors[0]) && codes.length === 0) {
        response.writeHead(400).end("Spotify authorization declined"); fail(new Error("Spotify authorization declined"));
      } else if (codes.length === 1 && text(codes[0]) && errors.length === 0) {
        response.end("Authorization received. Return to Pi to finish connecting."); accept(codes[0]);
      } else response.writeHead(400).end("Invalid Spotify callback");
    });
    server.on("error", fail);
    try {
      await Promise.race([new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)), authorization]);
      deadline.throwIfAborted();
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Could not bind Spotify callback server");
      const redirect = `http://127.0.0.1:${address.port}/callback`;
      const url = new URL("https://accounts.spotify.com/authorize");
      url.search = new URLSearchParams({ client_id: clientId.trim(), response_type: "code", redirect_uri: redirect, scope: SCOPE,
        state, code_challenge_method: "S256", code_challenge: challenge }).toString();
      void Promise.resolve().then(() => onUrl(url.toString())).catch(fail);
      const code = await authorization;
      const tokens = await exchange({ grant_type: "authorization_code", code, code_verifier: verifier,
        redirect_uri: redirect, client_id: clientId.trim() }, deadline);
      deadline.throwIfAborted();
      await store.withLock(async lease => {
        // Explicit successful authorization replaces credentials, including an unreadable old file.
        store.writeCredentials({ clientId: clientId.trim(), tokens, grant: randomUUID() }, lease);
        store.clearCache(lease);
      }, deadline);
    } finally {
      deadline.removeEventListener("abort", abort);
      server.close();
      server.closeAllConnections();
    }
  }
  return { poll, authorize };
}
