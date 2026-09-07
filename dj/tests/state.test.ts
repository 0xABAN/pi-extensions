import { afterAll, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  utimesSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/state.ts";
import { DEFAULTS } from "../src/types.ts";

const root = mkdtempSync(join(tmpdir(), "dj-state-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let number = 0;
function setup() {
  const directory = join(root, String(number++));
  return { directory, store: createStore(directory) };
}
const token = {
  access_token: "test-access",
  refresh_token: "test-refresh",
  expires_at: 1_800_000_000,
  scope: "user-read-playback-state",
};

test("initialization imports placement and credentials together once, never the legacy palette", async () => {
  const legacy = join(root, "legacy");
  mkdirSync(legacy);
  const legacyConfig = JSON.stringify({
    spotify_client_id: "legacy-client",
    pi_placement: "above",
    palette: ["#000", "#000", "#000"],
  });
  writeFileSync(join(legacy, "config.json"), legacyConfig);
  writeFileSync(join(legacy, "spotify_tokens.json"), JSON.stringify(token));
  const directory = join(root, "imported"),
    store = createStore(directory, legacy);
  await store.initialize();
  expect(store.readSettings()).toEqual({ ...DEFAULTS, placement: "above" });
  expect(store.readCredentials()).toMatchObject({
    clientId: "legacy-client",
    tokens: { ...token, expires_at: 1_800_000_000_000 },
  });
  await store.withLock(async (lease) =>
    store.writeCredentials(
      { clientId: "new-client", tokens: { ...token, expires_at: 1_900_000_000_000 } },
      lease,
    ),
  );
  await store.updateSettings({ placement: "below" });
  await store.initialize();
  expect(store.readCredentials().clientId).toBe("new-client");
  expect(store.readSettings().placement).toBe("below");
  expect(readFileSync(join(legacy, "config.json"), "utf8")).toBe(legacyConfig);
  expect(JSON.parse(readFileSync(join(legacy, "spotify_tokens.json"), "utf8"))).toEqual(token);
  expect(statSync(directory).mode & 0o777).toBe(0o700);
  for (const name of ["settings.json", "spotify_tokens.json"])
    expect(statSync(join(directory, name)).mode & 0o777).toBe(0o600);
});

test("fresh state defaults, scoped concurrent preferences, custom values and environment priority", async () => {
  const { directory, store } = setup();
  await store.initialize();
  expect(store.readSettings()).toEqual(DEFAULTS);
  const second = createStore(directory);
  await Promise.all([
    store.updateSettings({ layout: "minimal" }),
    second.updateSettings({ placement: "above" }),
  ]);
  expect(store.readSettings()).toMatchObject({ layout: "minimal", placement: "above" });
  await store.updateSettings({
    theme: { mode: "solid", colors: ["#abc"] },
    customSolid: ["#abc"],
    customAnimated: ["#abc", "#fff"],
  });
  expect(second.readSettings().theme).toEqual({ mode: "solid", colors: ["#AABBCC"] });
  await store.withLock(async (lease) => store.writeCredentials({ clientId: "saved" }, lease));
  const old = process.env.SPOTIFY_CLIENT_ID;
  try {
    process.env.SPOTIFY_CLIENT_ID = "  env-client  ";
    expect(store.getClientId()).toBe("env-client");
    delete process.env.SPOTIFY_CLIENT_ID;
    expect(store.getClientId()).toBe("saved");
  } finally {
    if (old === undefined) delete process.env.SPOTIFY_CLIENT_ID;
    else process.env.SPOTIFY_CLIENT_ID = old;
  }
});

test("malformed settings, tokens, and cache are visible and never silently replaced", async () => {
  const { directory, store } = setup();
  await store.initialize();
  for (const patch of [
    { layout: ["full"] },
    { placement: "left" },
    { theme: { mode: "solid", colors: ["#fff", "#000"] } },
    { theme: { mode: "animated", colors: ["#fff"] } },
    { unknown: true },
  ]) {
    await expect(store.updateSettings(patch as never)).rejects.toThrow();
    expect(store.readSettings()).toEqual(DEFAULTS);
  }
  for (const name of ["settings.json", "spotify_tokens.json", "playback.json"]) {
    const path = join(directory, name),
      previous = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    writeFileSync(path, "{broken");
    await expect(store.initialize()).rejects.toThrow(`Cannot read ${path}`);
    expect(readFileSync(path, "utf8")).toBe("{broken");
    if (previous === undefined) rmSync(path);
    else writeFileSync(path, previous);
  }
});

test("new state is not later overwritten by legacy files that appear after initialization", async () => {
  const directory = join(root, "fresh-before-legacy"),
    legacy = join(root, "later-legacy");
  const store = createStore(directory, legacy);
  await store.initialize();
  mkdirSync(legacy);
  writeFileSync(
    join(legacy, "config.json"),
    JSON.stringify({ spotify_client_id: "late", pi_placement: "above" }),
  );
  writeFileSync(join(legacy, "spotify_tokens.json"), JSON.stringify(token));
  await store.initialize();
  expect(store.readCredentials().tokens).toBeUndefined();
  expect(store.readSettings().placement).toBe("below");
});

test("locks bound acquisition, recover stale owners, and prevent aborted or compromised writes", async () => {
  const { directory, store } = setup();
  await store.initialize();
  const lockPath = join(directory, ".spotify.lock");
  mkdirSync(lockPath);
  utimesSync(lockPath, new Date(0), new Date(0));
  await store.withLock(async (lease) => store.writeCredentials({ clientId: "recovered" }, lease));
  await store.withLock(async () => {
    await expect(store.withLock(async () => {}, undefined, false)).rejects.toMatchObject({
      code: "ELOCKED",
    });
  });
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    store.withLock(
      async (lease) => store.writeCredentials({ clientId: "aborted" }, lease),
      aborted.signal,
    ),
  ).rejects.toThrow();
  await expect(
    store.withLock(async (lease) => {
      rmSync(lockPath, { recursive: true });
      store.writeCredentials({ clientId: "lost" }, lease);
    }),
  ).rejects.toThrow("ownership lost");
  expect(store.readCredentials().clientId).toBe("recovered");
});

test("preference writes do not interfere with a pending Spotify lock", async () => {
  const { store } = setup();
  await store.initialize();
  await store.withLock(async (lease) => {
    await store.updateSettings({ layout: "medium" });
    store.writeCredentials({ clientId: "still-owned" }, lease);
  });
  expect(store.readSettings().layout).toBe("medium");
  await store.withLock(async () => {});
  expect(store.readCredentials().clientId).toBe("still-owned");
});

test("cancellation interrupts lock contention before the other owner releases", async () => {
  const { store } = setup();
  await store.initialize();
  await store.withLock(async () => {
    const controller = new AbortController();
    const waiting = store
      .withLock(async () => {}, controller.signal)
      .then(
        () => "acquired",
        () => "aborted",
      );
    controller.abort();
    expect(
      await Promise.race([
        waiting,
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 500)),
      ]),
    ).toBe("aborted");
  });
});

test("proper-lockfile compromise aborts the operation instead of crashing the host", async () => {
  const { directory, store } = setup();
  await store.initialize();
  await expect(
    store.withLock(async (lease) => {
      const aborted = new Promise<void>((resolve) =>
        lease.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      rmSync(join(directory, ".spotify.lock"), { recursive: true });
      await aborted;
      lease.check();
    }),
  ).rejects.toMatchObject({ code: "ECOMPROMISED" });
  expect(store.readCredentials().tokens).toBeUndefined();
});

test("preference locks also merge writes from separate processes", async () => {
  const { directory, store } = setup();
  await store.initialize();
  const modulePath = new URL("../src/state.ts", import.meta.url).pathname;
  const children = [{ placement: "above" }, { layout: "medium" }].map((patch) =>
    Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { createStore } from ${JSON.stringify(modulePath)}; await createStore(${JSON.stringify(directory)}).updateSettings(${JSON.stringify(patch)});`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    ),
  );
  for (const child of children) {
    expect(await new Response(child.stderr).text()).toBe("");
    expect(await child.exited).toBe(0);
  }
  expect(store.readSettings()).toMatchObject({ placement: "above", layout: "medium" });
});
