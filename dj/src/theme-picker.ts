import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, truncateToWidth, type SelectItem } from "@earendil-works/pi-tui";
import { colorize, parseColors, renderLine } from "./display.ts";
import { PASTELS, type Layout, type Settings, type Theme } from "./types.ts";

const palettes = [
  { value: "rainbow", label: "Pastel rainbow", colors: PASTELS },
  { value: "warm", label: "Warm pastels", colors: PASTELS.slice(0, 3) },
  { value: "cool", label: "Cool pastels", colors: PASTELS.slice(3) },
];
const colorNames = ["Pink", "Peach", "Yellow", "Mint", "Blue", "Lavender"];
const overlay = {
  overlay: true,
  overlayOptions: { width: 64, maxHeight: "90%" as const, margin: 1 },
};
type Choice = SelectItem & { theme: Theme };
const sameTheme = (a: Theme, b: Theme) => a.mode === b.mode && a.colors.join() === b.colors.join();

/**
 * Preview mode → palette → optional hex input without mutating or saving settings.
 * Return a patch only for a final selection; cancellation returns undefined.
 * onPreview(undefined) always clears the temporary widget theme, even if a dialog fails.
 */
export async function pickTheme(
  ctx: ExtensionCommandContext,
  settings: Settings,
  onPreview: (theme: Theme | undefined) => void,
): Promise<Partial<Settings> | undefined> {
  let preview = settings.theme;

  function show(theme: Theme) {
    preview = theme;
    onPreview(theme);
  }

  // A fixed sample keeps configuration usable when Spotify is idle or the widget is disabled.
  function sample(width: number): string {
    const now = Date.now();
    return renderLine(
      {
        status: "playing",
        sampledAt: now,
        track: { name: "Midnight City", artists: "M83", progressMs: 84000, durationMs: 222000 },
      },
      { ...settings, theme: preview },
      width,
      now,
    );
  }

  /** Each visit owns a fresh overlay and timer; Pi disposes them when selection/back closes it. */
  function choose(title: string, choices: Choice[], selected: string): Promise<Choice | undefined> {
    return ctx.ui.custom<Choice | undefined>((tui, theme, _keys, done) => {
      const list = new SelectList(choices, 8, {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });

      list.setSelectedIndex(
        Math.max(
          0,
          choices.findIndex((choice) => choice.value === selected),
        ),
      );
      const highlight = (item: SelectItem) =>
        show(choices.find((choice) => choice.value === item.value)!.theme);
      list.onSelectionChange = highlight;
      list.onSelect = (item) => done(choices.find((choice) => choice.value === item.value));
      list.onCancel = () => done(undefined);
      // setSelectedIndex precedes the callback, so preview the initial highlight explicitly.
      highlight(list.getSelectedItem()!);
      const timer = setInterval(() => {
        if (preview.mode === "animated") tui.requestRender();
      }, 90);
      return {
        render(width) {
          if (width <= 0) return [""];
          return [
            theme.fg("accent", title),
            "",
            sample(width),
            "",
            ...list.render(Math.max(4, width)),
            "",
            theme.fg("dim", "Choose to continue · Cancel to go back"),
          ].map((line) => truncateToWidth(line, width, ""));
        },
        handleInput(data) {
          list.handleInput(data);
          tui.requestRender();
        },
        invalidate() {
          list.invalidate();
        },
        dispose() {
          clearInterval(timer);
        },
      };
    }, overlay);
  }

  /** Keep invalid drafts editable; only valid input changes the preview or completes the dialog. */
  function custom(mode: Theme["mode"], colors: string[]): Promise<Theme | undefined> {
    return ctx.ui.custom<Theme | undefined>((tui, theme, _keys, done) => {
      const input = new Input();
      input.setValue(colors.join(" "));
      let error = "",
        closed = false;
      const finish = (result: Theme | undefined) => {
        closed = true;
        done(result);
      };
      input.onEscape = () => finish(undefined);
      input.onSubmit = (value) => {
        try {
          finish({ mode, colors: parseColors(value, mode) });
        } catch (cause) {
          error = (cause as Error).message;
        }
      };
      const timer = setInterval(() => {
        if (preview.mode === "animated") tui.requestRender();
      }, 90);
      return {
        // Forward focus to Input so the terminal cursor and IME candidate window follow it.
        get focused() {
          return input.focused;
        },
        set focused(value: boolean) {
          input.focused = value;
        },
        render(width) {
          if (width <= 0) return [""];
          return [
            theme.fg("accent", `Custom ${mode}`),
            mode === "animated" ? "Two or more hex colors, separated by spaces" : "One hex color",
            "",
            ...input.render(Math.max(4, width)),
            theme.fg("error", error),
            sample(width),
            theme.fg("dim", "Submit to save · Cancel to go back"),
          ].map((line) => truncateToWidth(line, width, ""));
        },
        handleInput(data) {
          const previous = input.getValue();
          input.handleInput(data);
          if (closed) return;
          if (input.getValue() !== previous) error = "";
          try {
            show({ mode, colors: parseColors(input.getValue(), mode) });
          } catch {
            /* An incomplete edit keeps the last valid preview. */
          }
          tui.requestRender();
        },
        invalidate() {
          input.invalidate();
        },
        dispose() {
          clearInterval(timer);
        },
      };
    }, overlay);
  }

  try {
    // Back from a palette returns here; cancel at this root exits without a settings patch.
    while (true) {
      const modeChoice = await choose(
        "DJ theme",
        ["animated", "solid"].map((value) => ({
          value,
          label: `${value === "animated" ? "Animated" : "Solid"}${settings.theme.mode === value ? " ✓" : ""}`,
          theme:
            settings.theme.mode === value
              ? settings.theme
              : {
                  mode: value as Theme["mode"],
                  colors: value === "animated" ? PASTELS : [PASTELS[0]],
                },
        })),
        settings.theme.mode,
      );
      if (!modeChoice) return undefined;

      const mode = modeChoice.theme.mode;
      const saved = mode === "animated" ? settings.customAnimated : settings.customSolid;
      const customTheme: Theme = { mode, colors: saved ?? modeChoice.theme.colors };

      const choices: Choice[] = (
        mode === "animated"
          ? palettes
          : PASTELS.map((color, i) => ({ value: color, label: colorNames[i], colors: [color] }))
      ).map(({ value, label, colors }) => ({ value, label, theme: { mode, colors } }));
      choices.push({ value: "custom", label: "Custom…", theme: customTheme });

      let selected =
        choices.find((choice) => sameTheme(choice.theme, settings.theme))?.value ??
        choices[0].value;
      for (const choice of choices) {
        if (choice.value === selected && settings.theme.mode === mode) choice.label += " ✓";
        choice.label += " " + choice.theme.colors.map((color) => colorize("■", color)).join("");
        choice.description = choice.theme.colors.join(" ");
      }

      // Back from Custom reopens this palette, rather than reusing its disposed component.
      while (true) {
        const choice = await choose(
          mode === "animated" ? "Animated palettes" : "Solid colors",
          choices,
          selected,
        );
        if (!choice) break;
        if (choice.value !== "custom") return { theme: choice.theme };

        selected = choice.value;
        const picked = await custom(mode, customTheme.colors);
        if (picked)
          return {
            theme: picked,
            ...(mode === "animated"
              ? { customAnimated: picked.colors }
              : { customSolid: picked.colors }),
          };
      }
    }
  } finally {
    onPreview(undefined);
  }
}

/** Show examples with the active layout first; the caller owns persistence of the selection. */
export async function pickLayout(
  ctx: ExtensionCommandContext,
  current: Layout,
): Promise<Layout | undefined> {
  const layouts: Layout[] = [
    current,
    ...(["minimal", "medium", "full"] as Layout[]).filter((layout) => layout !== current),
  ];
  const examples = {
    minimal: "♪ Midnight City",
    medium: "♪ M83 — Midnight City",
    full: "♪ M83 — Midnight City  1:24 / 3:42",
  };
  const options = layouts.map(
    (layout) => `${layout}${layout === current ? " ✓" : ""} — ${examples[layout]}`,
  );
  const selected = await ctx.ui.select("DJ layout", options);
  return selected ? layouts[options.indexOf(selected)] : undefined;
}
