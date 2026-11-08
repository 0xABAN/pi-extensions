import { homedir } from "node:os";
import { join } from "node:path";
import type { Attachment, Message, SessionInfo } from "./types.ts";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function unnamedSessionName(sessionId: string): string {
  const id = sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
  return `session-${id.slice(0, 18)}`;
}

export function formatAttachments(attachments: Attachment[] | undefined): string {
  let text = "";
  for (const attachment of attachments ?? []) {
    text += attachment.language
      ? `\n\n---\nAttachment: ${attachment.name}\n~~~${attachment.language}\n${attachment.content}\n~~~`
      : `\n\n---\nAttachment: ${attachment.name}\n${attachment.content}`;
  }
  return text;
}

export function sessionIdPrefixes(sessions: SessionInfo[]): Map<string, string> {
  const prefixes = new Map<string, string>();
  for (const session of sessions) {
    let longestSharedPrefix = 0;
    for (const other of sessions) {
      if (other.id === session.id) {
        continue;
      }
      let length = 0;
      while (length < session.id.length && session.id[length] === other.id[length]) {
        length += 1;
      }
      longestSharedPrefix = Math.max(longestSharedPrefix, length);
    }

    const minimumLength = Math.max(8, longestSharedPrefix + 1);
    const groupBoundary = session.id.indexOf("-", minimumLength);
    prefixes.set(session.id, session.id.slice(0, groupBoundary === -1 ? minimumLength : groupBoundary));
  }
  return prefixes;
}

export function formatSessionLabel(session: SessionInfo, sessions: SessionInfo[]): string {
  if (!session.name) {
    return session.id;
  }

  const name = session.name.toLowerCase();
  const shared = sessions.filter((other) => other.name?.toLowerCase() === name).length > 1;
  return shared ? `${session.name} (${sessionIdPrefixes(sessions).get(session.id)})` : session.name;
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) {
    return String(Math.max(0, Math.round(tokens)));
  }
  const k = tokens / 1000;
  const value = k >= 100 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, "");
  return `${value}k`;
}

function formatContextUsage(session: SessionInfo): string {
  if (typeof session.contextPct !== "number") {
    return "";
  }

  let text = ` · ${session.contextPct}% ctx`;
  if (typeof session.contextTokens === "number" && typeof session.contextWindow === "number" && session.contextWindow > 0) {
    text += ` (${formatTokenCount(session.contextTokens)}/${formatTokenCount(session.contextWindow)})`;
  }
  return text;
}

function formatHerdrLocation(session: SessionInfo): string {
  const location = session.herdrLocation;
  if (!location) return "";
  if (location.status === "not_hosted") return " · not under Herdr";
  if (location.status === "unavailable") return ` · Herdr location unavailable: ${location.reason} (pane ${location.paneId})`;
  return ` · Herdr ${location.workspace.label} [${location.workspace.id}] / ${location.tab.label} [${location.tab.id}] / pane ${location.paneId}`;
}

export function formatSessionListRow(session: SessionInfo, currentCwd: string, isSelf: boolean, idPrefix: string): string {
  const name = session.name || "Unnamed session";
  const tags = [isSelf ? "self" : session.cwd === currentCwd ? "same cwd" : undefined, session.status]
    .filter((tag): tag is string => Boolean(tag));
  const suffix = tags.length ? ` [${tags.join(", ")}]` : "";
  const pane = session.tmuxPane ? ` · tmux ${session.tmuxPane}` : "";
  return `• ${name} (${idPrefix}) — ${session.cwd} (${session.model}${formatContextUsage(session)}${pane})${formatHerdrLocation(session)}${suffix}`;
}

export function previewText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function firstTextContent(result: { content?: Array<{ type: string; text?: string }> }): string {
  return result.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text?.replace(/\*\*/g, "") ?? "";
}

function isoTime(timestamp: number | undefined): string | undefined {
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

export function formatDeliveryMetadata(message: Message): string {
  const parts = [`id ${message.id}`];
  if (typeof message.senderSequence === "number") parts.push(`seq ${message.senderSequence}`);
  if (message.supersedes) parts.push(`supersedes ${message.supersedes}`);
  if (message.retryOf) parts.push(`retry of ${message.retryOf}`);

  const times: Array<[string, number | undefined]> = [
    ["sent", message.timestamp],
    ["broker delivered", message.brokerDeliveredAt],
    ["receiver received", message.receiverReceivedAt],
    ["injected", message.injectedAt],
  ];
  for (const [label, timestamp] of times) {
    const time = isoTime(timestamp);
    if (time) parts.push(`${label} ${time}`);
  }
  return parts.join(" · ");
}
