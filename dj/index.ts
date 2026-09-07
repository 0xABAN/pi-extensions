import { homedir } from "node:os";
import { join } from "node:path";
import {
  BorderedLoader,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createStore } from "./src/state.ts";
import { createSpotify } from "./src/spotify.ts";
import { renderLine } from "./src/display.ts";
import { pickLayout, pickTheme } from "./src/theme-picker.ts";
import { DEFAULTS, type Layout, type Playback, type Settings, type Theme } from "./src/types.ts";

const LAYOUTS: Layout[] = ["minimal", "medium", "full"];
const ARGUMENTS = [
  ...LAYOUTS,
  "layout",
  "theme",
  "auth",
  "placement",
  "placement above",
  "placement below",
  "placement toggle",
];

/**
 * Register DJ's commands and TUI lifecycle. This layer owns the widget and timers;
 * Spotify/state own cross-session I/O. Optional collaborators allow isolated tests.
 */
export default function dj(
  pi: ExtensionAPI,
  store = createStore(join(getAgentDir(), "dj"), join(homedir(), ".agent-dj")),
  spotify = createSpotify(store),
) {
  let enabled = true;
  let settings = structuredClone(DEFAULTS);
  let playback: Playback = { status: "idle", sampledAt: 0 };
  let preview: Theme | undefined;
  let run: { ctx: ExtensionContext; abort: AbortController } | undefined;
  let auth: AbortController | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let paintTimer: ReturnType<typeof setInterval> | undefined;
  let repaint: (() => void) | undefined;

  // A save may finish after stop/restart; its result must not update the replacement UI.
  let generation = 0;
  let disposed = false;

  /** Restart only the repaint clock needed by the current layout/preview; never fetch. */
  function paint() {
    clearInterval(paintTimer);

    const animated = (preview ?? settings.theme).mode === "animated";
    const delay = animated
      ? 90
      : playback.status === "playing" && settings.layout === "full"
        ? 1000
        : 0;

    if (run && delay) paintTimer = setInterval(() => repaint?.(), delay);
    repaint?.();
  }

  // Mount only on startup or relocation. Replacing neighboring widgets would break powerline.
  function mount() {
    run?.ctx.ui.setWidget(
      "dj",
      (tui) => {
        repaint = () => tui.requestRender();
        return {
          render: (width) => [
            renderLine(playback, { ...settings, theme: preview ?? settings.theme }, width),
          ],
          invalidate() {},
        };
      },
      { placement: settings.placement === "above" ? "aboveEditor" : "belowEditor" },
    );
    paint();
  }

  /** Retire this run before allowing pending I/O to complete. Saved preferences survive. */
  function stop() {
    generation++;
    run?.abort.abort();
    clearTimeout(pollTimer);
    clearInterval(paintTimer);
    run?.ctx.ui.setWidget("dj", undefined);
    run = undefined;
    repaint = undefined;
  }

  async function start(ctx: ExtensionContext) {
    stop();
    if (ctx.mode !== "tui" || !enabled) return;

    // Object identity rejects late results even if another run has already started.
    const current = { ctx, abort: new AbortController() };
    run = current;

    try {
      await store.initialize();
      if (run !== current) return;
      settings = store.readSettings();
      mount();
    } catch (error) {
      if (run === current) {
        stop();
        ctx.ui.notify(`DJ: ${String(error)}`, "error");
      }
      return;
    }

    // Schedule after completion rather than on an interval: slow requests cannot overlap.
    async function poll() {
      try {
        const next = await spotify.poll(current.abort.signal);
        if (run !== current) return;
        playback = next;
      } catch (error) {
        if (run !== current) return;
        playback = { ...playback, status: "offline", message: String(error) };
      }

      paint();
      if (run === current) pollTimer = setTimeout(poll, 5000);
    }

    void poll();
  }

  /** Persist the selected fields, then refresh only the UI that initiated the save. */
  async function save(patch: Partial<Settings>, ctx: ExtensionCommandContext) {
    if (disposed) return;

    const before = generation;
    const next = await store.updateSettings(patch);
    if (before !== generation) return;

    settings = next;
    if (patch.placement) mount();
    else paint();
    ctx.ui.notify("DJ preference saved", "info");
  }

  /** Pause this session's polling while the cancellable browser flow replaces its grant. */
  async function login(ctx: ExtensionCommandContext) {
    let savedId = "";
    try {
      savedId = store.getClientId() ?? "";
    } catch {
      ctx.ui.notify(
        "Stored Spotify credentials are unreadable; successful authorization will replace them.",
        "warning",
      );
    }

    const clientId = await ctx.ui.input("Spotify Client ID", savedId);
    if (disposed || !clientId?.trim()) return;

    stop();
    auth = new AbortController();
    const current = auth;

    try {
      const result = await ctx.ui.custom<Error | undefined>((tui, theme, _keys, done) => {
        const loader = new BorderedLoader(tui, theme, "Waiting for Spotify authorization…");
        const signal = AbortSignal.any([current.signal, loader.signal]);
        loader.onAbort = () => current.abort();
        void spotify
          .authorize(
            clientId.trim(),
            async (url) => {
              ctx.ui.notify(`Authorize Spotify: ${url}`, "info");
              const command =
                process.platform === "darwin"
                  ? "open"
                  : process.platform === "win32"
                    ? "rundll32.exe"
                    : "xdg-open";
              const args =
                process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
              // Browser launching is best-effort; the displayed URL remains a manual fallback.
              await pi.exec(command, args, { timeout: 5000, signal }).catch(() => {});
            },
            signal,
          )
          .then(
            () => done(undefined),
            (error) => done(error instanceof Error ? error : new Error(String(error))),
          );
        return loader;
      });
      if (auth !== current) return;
      if (!current.signal.aborted)
        ctx.ui.notify(
          result ? `DJ: ${result.message}` : "Spotify connected",
          result ? "error" : "info",
        );
    } finally {
      // Shutdown clears auth; an old dialog must not restart polling in a closed session.
      if (auth === current) {
        auth = undefined;
        await start(ctx);
      }
    }
  }

  pi.on("session_start", (_event, ctx) => {
    disposed = false;
    return start(ctx);
  });
  pi.on("session_shutdown", () => {
    disposed = true;
    auth?.abort();
    auth = undefined;
    stop();
  });
  pi.registerCommand("dj", {
    description: "Toggle Spotify; configure layout, placement, theme, or auth",
    getArgumentCompletions: (prefix) =>
      ARGUMENTS.filter((value) => value.startsWith(prefix.toLowerCase())).map((value) => ({
        value,
        label: value,
      })),
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;
      const value = args.trim().toLowerCase();
      try {
        if (!value) {
          enabled = !enabled;
          if (enabled) await start(ctx);
          else stop();
          ctx.ui.notify(`DJ ${enabled ? "enabled" : "disabled"}`, "info");
        } else if (LAYOUTS.includes(value as Layout)) {
          await save({ layout: value as Layout }, ctx);
        } else if (value === "layout") {
          const selected = await pickLayout(ctx, settings.layout);
          if (selected) await save({ layout: selected }, ctx);
        } else if (/^placement(?:\s+(above|below|toggle))?$/.test(value)) {
          const requested = value.split(/\s+/)[1];
          const placement =
            requested === "above" || requested === "below"
              ? requested
              : settings.placement === "above"
                ? "below"
                : "above";
          await save({ placement }, ctx);
        } else if (value === "theme") {
          const selected = await pickTheme(ctx, settings, (theme) => {
            preview = theme;
            paint();
          });
          if (selected) await save(selected, ctx);
        } else if (value === "auth") {
          await login(ctx);
        } else {
          ctx.ui.notify(
            "Usage: /dj [minimal|medium|full|layout|theme|auth|placement [above|below|toggle]]",
            "info",
          );
        }
      } catch (error) {
        if (!disposed) ctx.ui.notify(`DJ: ${String(error)}`, "error");
      }
    },
  });
}
