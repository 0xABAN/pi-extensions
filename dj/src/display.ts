import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { PASTELS, type Playback, type Settings, type Theme } from "./types.ts";

export function parseColors(input: string, mode: Theme["mode"]): string[] {
  const colors = input.trim().split(/\s+/);
  if (colors.some(color => !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(color))) {
    throw new Error("Use #RGB or #RRGGBB colors separated by spaces.");
  }
  if (mode === "solid" ? colors.length !== 1 : colors.length < 2) {
    throw new Error(mode === "solid" ? "Solid needs exactly one color." : "Animated needs at least two colors.");
  }
  return colors.map(color => (color.length === 4
    ? `#${[...color.slice(1)].map(digit => digit + digit).join("")}` : color).toUpperCase());
}

export function colorize(text: string, hex: string): string {
  const rgb = [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return `\x1b[38;2;${rgb.join(";")}m${text}\x1b[39m`;
}

function clean(text: string): string {
  return stripVTControlCharacters(text).replace(/\s+/g, " ")
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "").trim();
}

function time(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function renderLine(playback: Playback, settings: Settings, width: number, now = Date.now()): string {
  if (width <= 0) return "";
  if (width < 2) return " ";
  const available = Math.floor(width) - 1;
  const { track, status } = playback;
  let text = status === "auth" ? "♪ Spotify: /dj auth" : `♪ Spotify ${status}`;
  if (track && (status === "playing" || status === "paused" || status === "offline")) {
    const prefix = status === "playing" ? "♪ " : `♪ ${status} · `;
    const title = clean(track.name) || "Unknown track";
    const artist = clean(track.artists);
    let label = settings.layout === "minimal" || !artist ? title : `${artist} — ${title}`;
    let suffix = "";
    if (settings.layout === "full") {
      const elapsed = track.progressMs + (status === "playing" ? Math.max(0, now - playback.sampledAt) : 0);
      suffix = `  ${time(Math.min(elapsed, track.durationMs))} / ${time(track.durationMs)}`;
      const titleWidth = available - visibleWidth(prefix + suffix);
      if (titleWidth < 8) suffix = "";
      else if (visibleWidth(label) > titleWidth) label = title;
    }
    text = prefix + truncateToWidth(label, Math.max(0, available - visibleWidth(prefix + suffix)), "…") + suffix;
  }
  const colors = settings.theme.colors.length ? settings.theme.colors : PASTELS;
  const index = settings.theme.mode === "solid" ? 0 : Math.floor(now / 90) % colors.length;
  return " " + colorize(truncateToWidth(text, available, "…"), colors[index]);
}
