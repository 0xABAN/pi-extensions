import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type {
  ExtensionCommandContext,
  ExtensionUIContext,
  Theme as PiTheme,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  getKeybindings,
  visibleWidth,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import { pickLayout, pickTheme } from "../src/theme-picker.ts";
import { DEFAULTS, PASTELS, type Theme } from "../src/types.ts";

const down = "\x1b[B",
  up = "\x1b[A",
  enter = "\r",
  escape = "\x1b";
type Dialog = Component & Partial<Focusable> & { dispose?(): void };
type Step = (dialog: Dialog) => void;
const text = (dialog: Dialog) =>
  stripVTControlCharacters(dialog.render(64).join("\n").replaceAll(CURSOR_MARKER, ""));
const keys =
  (...values: string[]): Step =>
  (dialog) =>
    values.forEach((value) => dialog.handleInput!(value));

function ui(steps: Step[]) {
  let count = 0,
    disposed = 0;
  const custom: ExtensionUIContext["custom"] = async (factory, options) => {
    expect(options?.overlay).toBe(true);
    let close!: (value: unknown) => void;
    const result = new Promise((resolve) => {
      close = resolve;
    });
    const dialog = (await factory(
      { requestRender() {} } as TUI,
      { fg: (_color: string, value: string) => value } as PiTheme,
      {} as Parameters<typeof factory>[2],
      close,
    )) as Dialog;
    try {
      dialog.focused = true;
      for (const width of [0, 1, 2, 4, 20, 64]) {
        for (const line of dialog.render(width))
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      const step = steps[count++];
      if (!step) throw new Error(`Unexpected dialog: ${text(dialog)}`);
      step(dialog);
      return (await result) as never;
    } finally {
      dialog.dispose?.();
      disposed++;
    }
  };
  return {
    ctx: { ui: { custom } } as unknown as ExtensionCommandContext,
    verify() {
      expect(count).toBe(steps.length);
      expect(disposed).toBe(count);
    },
  };
}

test("root cancel clears preview; highlighting previews without mutating settings", async () => {
  const previews: (Theme | undefined)[] = [];
  const settings = structuredClone(DEFAULTS);
  const fake = ui([
    (dialog) => {
      expect(text(dialog)).toContain("Animated ✓");
      expect(text(dialog)).toContain("Midnight City");
      keys(down)(dialog);
      expect(previews.at(-1)?.mode).toBe("solid");
      keys(escape)(dialog);
    },
  ]);
  expect(await pickTheme(fake.ctx, settings, (theme) => previews.push(theme))).toBeUndefined();
  expect(previews.at(-1)).toBeUndefined();
  expect(settings).toEqual(DEFAULTS);
  fake.verify();
});

test("final palette choice alone produces a settings patch, with real ANSI swatches", async () => {
  const fake = ui([
    keys(enter),
    (dialog) => {
      expect(text(dialog)).toContain("Pastel rainbow ✓");
      expect(dialog.render(64).join()).toContain("\x1b[38;2;255;240;242m■");
      keys(down, enter)(dialog);
    },
  ]);
  expect(await pickTheme(fake.ctx, DEFAULTS, () => {})).toEqual({
    theme: { mode: "animated", colors: PASTELS.slice(0, 3) },
  });
  fake.verify();
});

test("back recreates disposed menus and root cancellation restores original preview", async () => {
  const seen = new Set<Dialog>();
  const previews: (Theme | undefined)[] = [];
  const fake = ui([
    (dialog) => {
      seen.add(dialog);
      keys(down, enter)(dialog);
    },
    (dialog) => {
      seen.add(dialog);
      keys(down, escape)(dialog);
    },
    (dialog) => {
      expect(seen.has(dialog)).toBe(false);
      expect(previews.at(-1)).toEqual(DEFAULTS.theme);
      keys(escape)(dialog);
    },
  ]);
  expect(await pickTheme(fake.ctx, DEFAULTS, (theme) => previews.push(theme))).toBeUndefined();
  expect(previews.at(-1)).toBeUndefined();
  fake.verify();
});

test("custom solid prefills saved values, retains invalid input and saves normalized color", async () => {
  const fake = ui([
    keys(down, enter),
    keys(up, enter),
    (dialog) => {
      expect(text(dialog)).toContain("#AABBCC");
      expect(dialog.focused).toBe(true);
      // Native Input starts at column zero; Ctrl+E/Ctrl+U replaces the saved value.
      keys("\x05", "\x15", "#nope", enter)(dialog);
      expect(text(dialog)).toContain("#nope");
      expect(text(dialog)).toContain("Use #RGB or #RRGGBB");
      keys("\x05", "\x15", "#c0f", enter)(dialog);
    },
  ]);
  expect(await pickTheme(fake.ctx, { ...DEFAULTS, customSolid: ["#AABBCC"] }, () => {})).toEqual({
    theme: { mode: "solid", colors: ["#CC00FF"] },
    customSolid: ["#CC00FF"],
  });
  fake.verify();
});

test("custom animated roundtrips, selects active custom theme, and cancels input back to palette", async () => {
  const colors = ["#AABBCC", "#123456"];
  const settings = {
    ...DEFAULTS,
    theme: { mode: "animated" as const, colors },
    customAnimated: colors,
  };
  const fake = ui([
    keys(enter),
    (dialog) => {
      expect(text(dialog)).toContain("→ Custom… ✓");
      keys(enter)(dialog);
    },
    (dialog) => {
      expect(text(dialog)).toContain(colors.join(" "));
      keys(escape)(dialog);
    },
    keys(enter),
    keys(enter),
  ]);
  expect(await pickTheme(fake.ctx, settings, () => {})).toEqual({
    theme: settings.theme,
    customAnimated: colors,
  });
  fake.verify();
});

test("canceling a custom edit returns to Custom without changing saved settings", async () => {
  const settings = structuredClone(DEFAULTS);
  const fake = ui([
    keys(enter),
    keys(up, enter),
    keys("\x05", "\x15", "#bad", escape),
    (dialog) => {
      expect(text(dialog)).toContain("→ Custom…");
      keys(escape)(dialog);
    },
    keys(escape),
  ]);
  expect(await pickTheme(fake.ctx, settings, () => {})).toBeUndefined();
  expect(settings).toEqual(DEFAULTS);
  fake.verify();
});

test("native list and input honor customized keybindings", async () => {
  const bindings = getKeybindings();
  const original = bindings.getUserBindings();
  bindings.setUserBindings({
    ...original,
    "tui.select.down": "ctrl+n",
    "tui.select.confirm": "ctrl+y",
    "tui.input.submit": "ctrl+t",
  });
  try {
    const fake = ui([keys("\x0e", "\x19"), keys(up, "\x19"), keys("\x05", "\x15", "#abc", "\x14")]);
    expect(await pickTheme(fake.ctx, DEFAULTS, () => {})).toEqual({
      theme: { mode: "solid", colors: ["#AABBCC"] },
      customSolid: ["#AABBCC"],
    });
    fake.verify();
  } finally {
    bindings.setUserBindings(original);
  }
});

test("preview clears even when a dialog fails, and layout picker uses native selection", async () => {
  const previews: (Theme | undefined)[] = [];
  const fake = ui([
    () => {
      throw new Error("dialog closed");
    },
  ]);
  await expect(pickTheme(fake.ctx, DEFAULTS, (theme) => previews.push(theme))).rejects.toThrow(
    "dialog closed",
  );
  expect(previews.at(-1)).toBeUndefined();
  fake.verify();
  const ctx = {
    ui: {
      select: async (_title: string, options: string[]) => {
        expect(options[0]).toStartWith("full ✓");
        expect(options[0]).toContain("1:24 / 3:42");
        return options[1];
      },
    },
  } as unknown as ExtensionCommandContext;
  expect(await pickLayout(ctx, "full")).toBe("minimal");
});
