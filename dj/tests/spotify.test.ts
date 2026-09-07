import { afterAll, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type Credentials } from "../src/state.ts";
import { createSpotify } from "../src/spotify.ts";

const root = mkdtempSync(join(tmpdir(), "dj-spotify-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let number = 0;
const epoch = 1_800_000_000_000,
  signal = () => new AbortController().signal;
const credentials: Credentials = {
  clientId: "fixture-client",
  grant: "fixture-grant",
  tokens: {
    access_token: "fixture-access",
    refresh_token: "fixture-refresh",
    expires_at: epoch + 3_600_000,
    scope: "user-read-playback-state",
  },
};
const track = {
  is_playing: true,
  progress_ms: 20_000,
  item: {
    id: "track-id",
    type: "track",
    name: "Title",
    artists: [{ name: "Artist" }],
    duration_ms: 100_000,
  },
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const mockFetch = (handler: (url: string, init: RequestInit) => Response | Promise<Response>) =>
  ((url: string | URL | Request, init?: RequestInit) =>
    handler(String(url), init ?? {})) as typeof fetch;
async function setup(saved: Credentials = credentials) {
  const directory = join(root, String(number++)),
    store = createStore(directory);
  await store.initialize();
  await store.withLock(async (lease) => store.writeCredentials(saved, lease));
  return { directory, store };
}

test("five-second polling shares snapshots across sessions and caches idle/paused/unknown tracks", async () => {
  const { directory, store } = await setup();
  let now = epoch,
    calls = 0,
    response = () => json(track);
  const fetch = mockFetch((url, init) => {
    expect(url).toBe("https://api.spotify.com/v1/me/player");
    expect(init.headers).toEqual({ Authorization: "Bearer fixture-access" });
    calls++;
    return response();
  });
  const first = createSpotify(store, { fetch, now: () => now });
  const second = createSpotify(createStore(directory), { fetch, now: () => now });
  expect(await first.poll(signal())).toEqual({
    status: "playing",
    sampledAt: epoch,
    track: { name: "Title", artists: "Artist", progressMs: 20_000, durationMs: 100_000 },
  });
  now += 4_999;
  expect((await second.poll(signal())).sampledAt).toBe(epoch);
  expect(calls).toBe(1);
  now++;
  response = () => new Response(null, { status: 204 });
  expect((await second.poll(signal())).status).toBe("idle");
  await first.poll(signal());
  expect(calls).toBe(2);
  now += 5_000;
  response = () => json({ ...track, is_playing: false });
  expect((await first.poll(signal())).status).toBe("paused");
  now += 5_000;
  response = () => json({ is_playing: false, item: null });
  expect((await first.poll(signal())).status).toBe("paused");
  now += 5_000;
  response = () => json({ ...track, item: { type: "episode" } });
  expect((await first.poll(signal())).status).toBe("idle");
});

test("simultaneous polling never duplicates a request and lock losers return cached playback", async () => {
  const { directory, store } = await setup();
  let now = epoch,
    calls = 0,
    finish!: (response: Response) => void,
    started!: () => void;
  const begun = new Promise<void>((resolve) => (started = resolve));
  const fetch = mockFetch(() => {
    calls++;
    if (calls === 1) return json(track);
    started();
    return new Promise((resolve) => (finish = resolve));
  });
  const first = createSpotify(store, { fetch, now: () => now }),
    second = createSpotify(createStore(directory), { fetch, now: () => now });
  await first.poll(signal());
  now += 5_000;
  const pending = first.poll(signal());
  await begun;
  expect((await second.poll(signal())).sampledAt).toBe(epoch);
  expect(calls).toBe(2);
  finish(json(track));
  await pending;
  expect((await second.poll(signal())).sampledAt).toBe(now);
  expect(calls).toBe(2);
});

test("401 refreshes once, retains an omitted refresh token, and shares the refreshed credentials", async () => {
  const { store } = await setup();
  const calls: string[] = [];
  const fetch = mockFetch((url, init) => {
    calls.push(url);
    if (url.endsWith("/api/token")) {
      expect(new URLSearchParams(String(init.body)).get("refresh_token")).toBe("fixture-refresh");
      return json({ access_token: "renewed", expires_in: 3600 });
    }
    return (init.headers as Record<string, string>).Authorization === "Bearer renewed"
      ? json(track)
      : json({}, 401);
  });
  expect((await createSpotify(store, { fetch, now: () => epoch }).poll(signal())).status).toBe(
    "playing",
  );
  expect(calls).toHaveLength(3);
  expect(store.readCredentials().tokens).toMatchObject({
    access_token: "renewed",
    refresh_token: "fixture-refresh",
  });
});

test("repeated 401 and invalid_grant require auth without a refresh spin; missing client ID is actionable", async () => {
  for (const invalidGrant of [false, true]) {
    const { store } = await setup();
    let calls = 0,
      now = epoch;
    const fetch = mockFetch((url) => {
      calls++;
      return url.endsWith("/api/token")
        ? invalidGrant
          ? json({ error: "invalid_grant" }, 400)
          : json({ access_token: "rejected", expires_in: 3600 })
        : json({}, 401);
    });
    const spotify = createSpotify(store, { fetch, now: () => now });
    expect((await spotify.poll(signal())).status).toBe("auth");
    expect(calls).toBe(invalidGrant ? 2 : 3);
    now += 61_000;
    expect((await spotify.poll(signal())).status).toBe("auth");
    expect(calls).toBe(invalidGrant ? 2 : 3);
  }
  const { store } = await setup({ tokens: credentials.tokens });
  const old = process.env.SPOTIFY_CLIENT_ID;
  delete process.env.SPOTIFY_CLIENT_ID;
  try {
    const spotify = createSpotify(store, {
      fetch: mockFetch(() => {
        throw new Error("must not fetch");
      }),
      now: () => epoch,
    });
    expect(await spotify.poll(signal())).toMatchObject({
      status: "auth",
      message: "Set a Spotify client ID with /dj auth",
    });
  } finally {
    if (old !== undefined) process.env.SPOTIFY_CLIENT_ID = old;
  }
});

test("offline/invalid responses freeze the last reliable progress and persist error cooldown", async () => {
  for (const fail of [
    () => {
      throw new Error("offline");
    },
    () => json({ ...track, progress_ms: "invalid" }),
    () => json({}, 503),
  ]) {
    const { directory, store } = await setup();
    let now = epoch,
      calls = 0;
    const fetch = mockFetch(() => (++calls === 1 ? json(track) : fail()));
    const spotify = createSpotify(store, { fetch, now: () => now });
    await spotify.poll(signal());
    now += 5_000;
    const offline = await spotify.poll(signal());
    expect(offline).toMatchObject({
      status: "offline",
      track: { progressMs: 20_000 },
      sampledAt: now,
    });
    now += 29_999;
    expect(
      await createSpotify(createStore(directory), { fetch, now: () => now }).poll(signal()),
    ).toEqual(offline);
    expect(calls).toBe(2);
  }
});

test("Retry-After seconds, HTTP dates, and malformed fallback survive another session", async () => {
  for (const [header, delay] of [
    ["120", 120_000],
    [new Date(epoch + 90_000).toUTCString(), 90_000],
    ["invalid", 30_000],
    [null, 30_000],
  ] as const) {
    const { directory, store } = await setup();
    let now = epoch,
      calls = 0;
    const fetch = mockFetch(() => {
      calls++;
      return new Response(null, { status: 429, headers: header ? { "Retry-After": header } : {} });
    });
    await createSpotify(store, { fetch, now: () => now }).poll(signal());
    now += delay - 1;
    await createSpotify(createStore(directory), { fetch, now: () => now }).poll(signal());
    expect(calls).toBe(1);
    now++;
    await createSpotify(store, { fetch, now: () => now }).poll(signal());
    expect(calls).toBe(2);
  }
});

test("aborted late refreshes cannot write credentials or cached playback", async () => {
  const original = { ...credentials, tokens: { ...credentials.tokens!, expires_at: epoch - 1 } };
  const { store } = await setup(original),
    controller = new AbortController();
  const fetch = mockFetch((_url, init) => {
    expect(init.signal).toBeDefined();
    controller.abort();
    return json({ access_token: "late", expires_in: 3600 });
  });
  await expect(
    createSpotify(store, { fetch, now: () => epoch }).poll(controller.signal),
  ).rejects.toThrow();
  expect(store.readCredentials()).toEqual(original);
  expect(store.readCache()).toBeUndefined();
  // The aborted operation released the lock.
  await store.withLock(async () => {});
});

test("PKCE binds loopback, ignores unrelated callbacks, validates state, and atomically connects without holding a browser lock", async () => {
  const { store } = await setup();
  let authorizationUrl!: URL,
    calls = 0;
  const spotify = createSpotify(store, {
    now: () => epoch,
    fetch: mockFetch((url, init) => {
      calls++;
      expect(url).toBe("https://accounts.spotify.com/api/token");
      const body = new URLSearchParams(String(init.body));
      expect(body.get("redirect_uri")).toBe(authorizationUrl.searchParams.get("redirect_uri"));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("test-code");
      expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(
        authorizationUrl.searchParams.get("code_challenge")!,
      );
      return json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "user-read-playback-state",
      });
    }),
  });
  await spotify.authorize(
    "new-client",
    async (url) => {
      authorizationUrl = new URL(url);
      expect(authorizationUrl.origin).toBe("https://accounts.spotify.com");
      expect(authorizationUrl.searchParams.get("scope")).toBe("user-read-playback-state");
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
      const redirect = authorizationUrl.searchParams.get("redirect_uri")!;
      expect(new URL(redirect).hostname).toBe("127.0.0.1");
      await store.withLock(async () => {}); // Browser login never holds the state lock.
      expect((await fetch(new URL("/favicon.ico", redirect))).status).toBe(400);
      expect((await fetch(`${redirect}?state=wrong&code=test-code`)).status).toBe(400);
      const valid = `${redirect}?state=${authorizationUrl.searchParams.get("state")}`;
      expect((await fetch(`${valid}&code=one&code=two`)).status).toBe(400);
      expect((await fetch(`${valid}&code=test-code`)).status).toBe(200);
    },
    signal(),
  );
  expect(calls).toBe(1);
  expect(store.readCredentials()).toMatchObject({
    clientId: "new-client",
    tokens: { access_token: "new-access", refresh_token: "new-refresh" },
  });
  expect(store.readCredentials().grant).not.toBe(credentials.grant);
  expect(store.readCache()).toBeUndefined();
  await expect(fetch(authorizationUrl.searchParams.get("redirect_uri")!)).rejects.toThrow();
});

test("cancelled, denied, or failed authorization preserves existing credentials and closes the server", async () => {
  for (const kind of ["abort", "deny", "exchange", "opener"] as const) {
    const { store } = await setup(),
      controller = new AbortController();
    let redirect = "",
      calls = 0;
    const spotify = createSpotify(store, {
      fetch: mockFetch(() => {
        calls++;
        return json({ error: "invalid_grant" }, 400);
      }),
    });
    await expect(
      spotify.authorize(
        "candidate",
        async (raw) => {
          const url = new URL(raw);
          redirect = url.searchParams.get("redirect_uri")!;
          if (kind === "abort") {
            controller.abort();
            return;
          }
          if (kind === "opener") throw new Error("Could not open browser");
          const callback = `${redirect}?state=${url.searchParams.get("state")}&${kind === "deny" ? "error=access_denied" : "code=valid"}`;
          await fetch(callback);
        },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(calls).toBe(kind === "exchange" ? 1 : 0);
    expect(store.readCredentials()).toEqual(credentials);
    await expect(fetch(redirect)).rejects.toThrow();
  }
});

test("network and login deadlines abort requests, close loopback listeners, and preserve tokens", async () => {
  const timeout = AbortSignal.timeout;
  const shortened = spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
    timeout(ms === 180_000 || ms === 10_000 ? 40 : ms),
  );
  try {
    const { store } = await setup();
    let redirect = "";
    const spotify = createSpotify(store, {
      now: () => epoch,
      fetch: mockFetch(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason), {
              once: true,
            });
          }),
      ),
    });
    expect((await spotify.poll(signal())).status).toBe("offline");
    await expect(
      spotify.authorize(
        "candidate",
        (raw) => {
          redirect = new URL(raw).searchParams.get("redirect_uri")!;
          // An opener that never resolves must not defeat the login timeout.
          return new Promise(() => {});
        },
        signal(),
      ),
    ).rejects.toThrow();
    expect(store.readCredentials()).toEqual(credentials);
    await expect(fetch(redirect)).rejects.toThrow();
  } finally {
    shortened.mockRestore();
  }
});

test("explicit successful authorization can recover unreadable credentials and cache", async () => {
  const { directory, store } = await setup();
  writeFileSync(join(directory, "spotify_tokens.json"), "{broken");
  writeFileSync(join(directory, "playback.json"), "{broken");
  await createSpotify(store, {
    fetch: mockFetch(() =>
      json({ access_token: "reconnected", refresh_token: "new-refresh", expires_in: 3600 }),
    ),
  }).authorize(
    "new-client",
    async (raw) => {
      const url = new URL(raw);
      await fetch(
        `${url.searchParams.get("redirect_uri")}?state=${url.searchParams.get("state")}&code=new`,
      );
    },
    signal(),
  );
  expect(store.readCredentials()).toMatchObject({
    clientId: "new-client",
    tokens: { access_token: "reconnected" },
  });
  expect(store.readCache()).toBeUndefined();
});

test("reauthorization waits for old polling then invalidates the old account cache", async () => {
  const { store } = await setup();
  let finish!: (value: Response) => void, started!: () => void;
  const begun = new Promise<void>((resolve) => (started = resolve));
  const polling = createSpotify(store, {
    now: () => epoch,
    fetch: mockFetch(() => {
      started();
      return new Promise((resolve) => (finish = resolve));
    }),
  }).poll(signal());
  await begun;
  const authorizing = createSpotify(store, {
    now: () => epoch,
    fetch: mockFetch(() => {
      finish(json(track));
      return json({ access_token: "reauthorized", refresh_token: "new-refresh", expires_in: 3600 });
    }),
  }).authorize(
    "new-client",
    async (raw) => {
      const url = new URL(raw);
      await fetch(
        `${url.searchParams.get("redirect_uri")}?state=${url.searchParams.get("state")}&code=new`,
      );
    },
    signal(),
  );
  await Promise.all([polling, authorizing]);
  expect(store.readCredentials().tokens?.access_token).toBe("reauthorized");
  expect(store.readCache()).toBeUndefined();
});
