import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import dj from "../index.ts";
import { DEFAULTS, type Playback, type Settings } from "../src/types.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const playing: Playback = {
  status: "playing",
  sampledAt: Date.now(),
  track: { artists: "Artist", name: "Track", progressMs: 1000, durationMs: 90000 },
};

function harness(poll: (signal: AbortSignal) => Promise<Playback> = async () => playing) {
  const events = new Map<string, Function>();
  const bus = new EventEmitter();
  const widgets = new Map<string, { render(width: number): string[] }>([
    ["powerline-last-prompt", { render: () => ["untouched"] }],
  ]);
  const placements: string[] = [];
  const messages: string[] = [];
  let registered: any;
  let prefs = structuredClone(DEFAULTS);
  let initialized = 0;
  let polls = 0;
  let lastSignal: AbortSignal | undefined;
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      notify(message: string) {
        messages.push(message);
      },
      setWidget(id: string, factory: any, options?: { placement: string }) {
        expect(id).toBe("dj");
        // Pi deletes before setting, so updates move a widget to the end of its group.
        widgets.delete(id);
        if (factory) {
          placements.push(options!.placement);
          widgets.set(id, factory({ requestRender() {} }));
        }
      },
      select: async () => undefined,
      input: async () => undefined,
    },
  };
  dj(
    {
      events: bus,
      on(name: string, handler: Function) {
        events.set(name, handler);
      },
      registerCommand(name: string, command: unknown) {
        expect(name).toBe("dj");
        registered = command;
      },
    } as never,
    {
      initialize: async () => {
        initialized++;
      },
      readSettings: () => prefs,
      updateSettings: async (patch: Partial<Settings>) => (prefs = { ...prefs, ...patch }),
      getClientId: () => undefined,
    } as never,
    {
      poll: async (signal: AbortSignal) => {
        polls++;
        lastSignal = signal;
        return poll(signal);
      },
      authorize: async () => {},
    } as never,
  );
  cleanups.push(() => events.get("session_shutdown")!({}, ctx));
  return {
    ctx,
    events,
    bus,
    widgets,
    placements,
    messages,
    command: (args: string) => registered.handler(args, ctx),
    completions: (prefix: string) => registered.getArgumentCompletions(prefix),
    start: () => events.get("session_start")!({}, ctx),
    get prefs() {
      return prefs;
    },
    get initialized() {
      return initialized;
    },
    get polls() {
      return polls;
    },
    get signal() {
      return lastSignal;
    },
  };
}

test("DJ owns only its widget; commands match powerline toggles without remounting on layout changes", async () => {
  const app = harness();
  await app.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(app.placements).toEqual(["belowEditor"]);
  expect(app.widgets.get("dj")!.render(100)[0]).toContain("Track");
  await app.command("medium");
  expect(app.prefs.layout).toBe("medium");
  expect(app.placements).toHaveLength(1);
  await app.command("placement");
  expect(app.placements).toEqual(["belowEditor", "aboveEditor"]);
  await app.command("");
  expect(app.widgets.has("dj")).toBe(false);
  expect(app.signal!.aborted).toBe(true);
  await app.command("placement below");
  await app.command("minimal");
  expect(app.widgets.has("dj")).toBe(false);
  expect(app.prefs.layout).toBe("minimal");
  await app.command("");
  expect(app.widgets.has("dj")).toBe(true);
  expect(app.placements.at(-1)).toBe("belowEditor");
  expect(app.widgets.get("powerline-last-prompt")!.render(100)).toEqual(["untouched"]);
});

test("powerline coordination keeps its own prompt after DJ across rebuilds and toggles", async () => {
  const app = harness();
  const prompt = app.widgets.get("powerline-last-prompt")!;
  let powerlineEnabled = true;
  const appendPrompt = () => {
    if (!powerlineEnabled) return;
    app.widgets.delete("powerline-last-prompt");
    app.widgets.set("powerline-last-prompt", prompt);
  };
  app.bus.on("dj:mounted", appendPrompt);
  const rebuild = () => {
    app.widgets.delete("powerline-top");
    app.widgets.set("powerline-top", { render: () => ["powerline"] });
    appendPrompt();
    app.bus.emit("powerline:widgets-installed");
  };
  const below = () =>
    [...app.widgets.keys()].filter((id) => id !== "dj" || app.prefs.placement === "below");
  const expected = ["powerline-top", "dj", "powerline-last-prompt"];

  // Powerline first, then DJ; the reverse order is exercised by each rebuild.
  rebuild();
  await app.start();
  expect(below()).toEqual(expected);
  rebuild();
  expect(below()).toEqual(expected);
  await app.command("");
  rebuild();
  expect(below()).toEqual(["powerline-top", "powerline-last-prompt"]);
  await app.command("");
  expect(below()).toEqual(expected);

  await app.command("placement above");
  const mounts = app.placements.length;
  rebuild();
  expect(app.placements).toHaveLength(mounts);
  expect(below()).toEqual(["powerline-top", "powerline-last-prompt"]);
  await app.command("placement below");
  expect(below()).toEqual(expected);

  powerlineEnabled = false;
  app.widgets.delete("powerline-top");
  app.widgets.delete("powerline-last-prompt");
  await app.command("");
  await app.command("");
  expect(below()).toEqual(["dj"]);
  powerlineEnabled = true;
  rebuild();
  expect(below()).toEqual(expected);
  expect(app.widgets.get("powerline-last-prompt")).toBe(prompt);

  app.events.get("session_shutdown")!({}, app.ctx);
  rebuild();
  expect(app.widgets.has("dj")).toBe(false);
});

test("a late Spotify result after shutdown never resurrects the widget", async () => {
  let finish!: (value: Playback) => void;
  const app = harness(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await app.start();
  app.events.get("session_shutdown")!({}, app.ctx);
  finish(playing);
  await Promise.resolve();
  await Promise.resolve();
  expect(app.widgets.has("dj")).toBe(false);
  expect(app.signal!.aborted).toBe(true);
});

test("headless/RPC startup and commands perform no I/O or mount", async () => {
  const app = harness();
  for (const mode of ["print", "rpc"]) {
    app.ctx.mode = mode;
    await app.start();
    await app.command("auth");
  }
  expect(app.initialized).toBe(0);
  expect(app.polls).toBe(0);
  expect(app.placements).toEqual([]);
});

test("Pi discovers and loads the standalone DJ package without initializing Spotify", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dj-loader-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    settingsManager: SettingsManager.inMemory({
      packages: [fileURLToPath(new URL("../", import.meta.url))],
    }),
  });
  await loader.reload();
  const result = loader.getExtensions();
  expect(result.errors).toEqual([]);
  expect(result.extensions).toHaveLength(1);
  expect(result.extensions[0].commands.get("dj")?.description).toBe(
    "minimal, medium, full, layout, placement, theme, auth",
  );
});

test("commands are discoverable and invalid input doesn't alter preferences", async () => {
  const app = harness();
  expect(app.completions("placement ").map((item: any) => item.value)).toEqual([
    "placement above",
    "placement below",
    "placement toggle",
  ]);
  await app.command("nonsense");
  expect(app.prefs).toEqual(DEFAULTS);
  expect(app.messages.at(-1)).toContain("Usage:");
});
