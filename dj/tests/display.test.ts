import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { colorize, parseColors, renderLine } from "../src/display.ts";
import { DEFAULTS, PASTELS, type Playback, type Settings } from "../src/types.ts";

const playback: Playback = {
  status: "playing",
  sampledAt: 1000,
  track: { name: "Midnight City", artists: "M83", progressMs: 84000, durationMs: 222000 },
};
const plain = (value: string) => stripVTControlCharacters(value);
const solid: Settings = { ...DEFAULTS, theme: { mode: "solid", colors: [PASTELS[0]] } };

test("hex input normalizes shorthand, rejects invalid tokens and enforces mode cardinality", () => {
  expect(parseColors("  #abc #fF0099  ", "animated")).toEqual(["#AABBCC", "#FF0099"]);
  expect(parseColors("#fff", "solid")).toEqual(["#FFFFFF"]);
  for (const input of [
    "",
    "   ",
    "red",
    "fff",
    "#ff",
    "#ffff",
    "#ggg",
    "#fff, #abc",
    "#fff garbage",
  ]) {
    expect(() => parseColors(input, "animated")).toThrow("#RGB or #RRGGBB");
  }
  expect(() => parseColors("#fff", "animated")).toThrow("at least two");
  expect(() => parseColors("#fff #000", "solid")).toThrow("exactly one");
});

test("three layouts preserve the original pastel cycle while only full includes elapsed time", () => {
  expect(plain(renderLine(playback, DEFAULTS, 80, 1000))).toBe(
    " ♪ M83 — Midnight City  1:24 / 3:42",
  );
  expect(plain(renderLine(playback, { ...DEFAULTS, layout: "medium" }, 80, 1000))).toBe(
    " ♪ M83 — Midnight City",
  );
  expect(plain(renderLine(playback, { ...DEFAULTS, layout: "minimal" }, 80, 1000))).toBe(
    " ♪ Midnight City",
  );
  PASTELS.forEach((color, i) => {
    const line = renderLine(playback, DEFAULTS, 80, i * 90);
    expect(line).toBe(" " + colorize(plain(line).slice(1), color));
  });
  expect(renderLine(playback, { ...solid, layout: "minimal" }, 80, 0)).toBe(
    renderLine(playback, { ...solid, layout: "minimal" }, 80, 10000),
  );
});

test("playing progress interpolates and clamps; paused and stale offline tracks stay frozen", () => {
  expect(plain(renderLine(playback, solid, 80, 11000))).toContain("1:34 / 3:42");
  expect(plain(renderLine(playback, solid, 80, 999999))).toContain("3:42 / 3:42");
  expect(plain(renderLine(playback, solid, 80, 0))).toContain("1:24 / 3:42");
  for (const status of ["paused", "offline"] as const) {
    const state = { ...playback, status };
    expect(renderLine(state, solid, 80, 1000)).toBe(renderLine(state, solid, 80, 999999));
    expect(plain(renderLine(state, solid, 80, 999999))).toContain(
      `${status} · M83 — Midnight City  1:24`,
    );
  }
  for (const status of ["idle", "offline", "paused", "auth"] as const) {
    expect(plain(renderLine({ status, sampledAt: 0 }, solid, 80, 0))).toContain(
      status === "auth" ? "/dj auth" : status,
    );
  }
});

test("untrusted metadata is single-line, control-free and Unicode-safe at every terminal width", () => {
  const state: Playback = {
    ...playback,
    track: {
      ...playback.track!,
      name: "夜空 👩‍💻 é\n\t  Song\x1b[2J\x07\u202e",
      artists: "\x1b]0;fake title\x07Artist\x1b[31m\x1b[0m",
    },
  };
  const line = plain(renderLine(state, solid, 120, 1000));
  expect(line).toContain("Artist — 夜空 👩‍💻 é Song");
  expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202e]/);
  for (const layout of ["minimal", "medium", "full"] as const) {
    for (let width = 0; width < 100; width++) {
      expect(
        visibleWidth(renderLine(state, { ...solid, layout }, width, 1000)),
      ).toBeLessThanOrEqual(width);
    }
  }
  expect(renderLine(state, solid, 0)).toBe("");
  expect(renderLine(state, solid, 1)).toBe(" ");
  const narrow = plain(renderLine(playback, solid, 30, 1000));
  expect(narrow).toContain("Midnight City");
  expect(narrow).toContain("1:24 / 3:42");
  expect(narrow).not.toContain("M83");
});
