import type { SessionInfo } from "./types.ts";

export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) {
    return String(Math.max(0, Math.round(tokens)));
  }
  const k = tokens / 1000;
  const value = k >= 100 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, "");
  return `${value}k`;
}

export function formatContextUsage(session: SessionInfo): string {
  if (typeof session.contextPct !== "number") {
    return "";
  }
  let out = ` · ${session.contextPct}% ctx`;
  if (
    typeof session.contextTokens === "number"
    && typeof session.contextWindow === "number"
    && session.contextWindow > 0
  ) {
    out += ` (${formatTokenCount(session.contextTokens)}/${formatTokenCount(session.contextWindow)})`;
  }
  return out;
}
