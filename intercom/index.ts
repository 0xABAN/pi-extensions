import { BorderedLoader, defineTool, VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { randomUUID } from "crypto";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { IntercomClient, IntercomSessionHeldError, type SendResult } from "./broker/client.ts";
import { spawnBrokerIfNeeded } from "./broker/spawn.ts";
import { SessionListOverlay, type SessionListSelection } from "./ui/session-list.ts";
import { HandoverPicker, type HandoverPickerResult, type RemoteSessionLister } from "./ui/handover-picker.ts";
import { ComposeOverlay, type ComposeResult } from "./ui/compose.ts";
import { InlineMessageComponent } from "./ui/inline-message.ts";
import { getAskTimeoutMs, getIntercomScopeId, loadConfig, setIntercomScopeId, type IntercomConfig } from "./config.ts";
import type { Attachment, BrokerMessage, Message, MessageControl, MessageReceiptStatus, SessionInfo, SessionRegistration } from "./types.ts";
import { ReplyTracker } from "./reply-tracker.ts";
import { homedir } from "node:os";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { sameCwd } from "./cwd.ts";
import { formatContextUsage } from "./format-context.ts";
import { openProjectPane, resolveTargetInCwd, waitForProjectSession, type ProjectPaneLaunch } from "./project-agent.ts";
import { relaySenderName } from "./cross-machine-envelope.ts";
import { runCommand, sendCrossMachine } from "./cross-machine-transport.ts";
import { listMachineAgents, listSavedMachines, parseCrossMachineTarget } from "./cross-machine-discovery.ts";
import { formatHandoverMessage, generateHandoverBody, readGitState } from "./handover.ts";
import { isIdleWakePending, releaseIdleWake, reserveIdleWake } from "./idle-wake.ts";

const INTERCOM_TOOL_NAME = "intercom";
const INBOUND_MESSAGE_DEDUPE_MAX = 1000;
const INBOUND_MESSAGE_DEDUPE_RETENTION_MS = 60 * 60 * 1000;
const DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX = "session";
const STABLE_INTERCOM_SESSION_ID_ENV = "PI_INTERCOM_STABLE_ID";
const NAME_POLL_MS_ENV = "PI_INTERCOM_NAME_POLL_MS";

interface InboundMessageEntry {
  from: SessionInfo;
  message: Message;
  replyCommand?: string;
  bodyText: string;
}

interface DeliveryTarget {
  id: string;
  label: string;
  projectPane?: ProjectPaneLaunch;
}

interface DeliveryRequest {
  to?: string;
  cwd?: string;
  openProjectPaneIfMissing?: boolean;
  focus?: boolean;
  message: string;
  attachments?: Attachment[];
  replyTo?: string;
  supersedes?: string;
  retryOf?: string;
  handover?: boolean;
}

interface IntercomToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

interface PrefixTarget {
  rawTo: string;
  firstTarget: string;
  display: string;
}

interface PrefixSend {
  result: SendResult;
  display: string;
  resolution: string;
  noMatchText?: string;
}

const BLOCKING_ASK_GUIDANCE = "Blocking asks are not queued; use send for a non-blocking mailbox delivery or retry after the session reconnects.";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function triggerTurnRunsPromptLifecycle(piVersion: string): boolean {
  const match = /^(\d+)\.(\d+)\./.exec(piVersion);
  if (!match) return false;
  const major = Number(match[1]);
  return major > 1 || (major === 1 && Number(match[2]) >= 2);
}

export function explicitCrossMachineSendRestriction(options: {
  to?: string;
  cwd?: string;
  openProjectPaneIfMissing?: boolean;
  attachments?: readonly unknown[];
  replyTo?: string;
  supersedes?: string;
  retryOf?: string;
}): string | undefined {
  if (!options.to?.includes("@")) return undefined;
  if (options.cwd || options.openProjectPaneIfMissing) {
    return "Cross-machine send does not support cwd or opening project panes.";
  }
  if (options.replyTo || options.supersedes || options.retryOf || options.attachments?.length) {
    return "Cross-machine send only supports a new text message; attachments, reply relationships, supersede, and retry are not supported.";
  }
  return undefined;
}

function undeliveredText(target: string, result: SendResult): string {
  const reason = result.reason ?? "Session may not exist or has disconnected.";
  return result.outcomeKnown
    ? `Message to "${target}" was not delivered: ${reason}`
    : `Delivery to "${target}" could not be confirmed: ${reason}. The message may still arrive, so sending it again could duplicate it.`;
}

function queuedText(target: string, what = "message"): string {
  return `Session "${target}" is not connected. The ${what} is waiting in the broker mailbox until that session reconnects.`;
}

function deliveryDetails(result: SendResult): Record<string, unknown> {
  return {
    messageId: result.id,
    delivered: result.delivered,
    delivery: result.delivery,
    retryable: result.retryable,
    outcomeKnown: result.outcomeKnown,
    ...(result.code ? { code: result.code } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function formatAttachments(attachments: Attachment[]): string {
  let text = "";
  for (const att of attachments) {
    if (att.language) {
      text += `\n\n---\nAttachment: ${att.name}\n~~~${att.language}\n${att.content}\n~~~`;
    } else {
      text += `\n\n---\nAttachment: ${att.name}\n${att.content}`;
    }
  }
  return text;
}

function duplicateSessionNames(sessions: SessionInfo[]): Set<string> {
  return new Set(
    sessions
      .map(s => s.name?.toLowerCase())
      .filter((name): name is string => Boolean(name))
      .filter((name, index, names) => names.indexOf(name) !== index)
  );
}
function sessionIdPrefixes(sessions: SessionInfo[]): Map<string, string> {
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
    const length = groupBoundary === -1 ? minimumLength : groupBoundary;
    prefixes.set(session.id, session.id.slice(0, length));
  }
  return prefixes;
}
function resolveIntercomPresenceName(sessionName: string | undefined, sessionId: string): string {
  const trimmedName = sessionName?.trim();
  if (trimmedName) {
    return trimmedName;
  }
  const normalizedSessionId = sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
  return `${DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX}-${normalizedSessionId.slice(0, 18)}`;
}
function buildPresenceIdentity(pi: ExtensionAPI, sessionId: string): { name: string; runtimeFallbackAlias: boolean } {
  const sessionName = pi.getSessionName();
  return {
    name: resolveIntercomPresenceName(sessionName, sessionId),
    runtimeFallbackAlias: !sessionName?.trim(),
  };
}
function resolveConfiguredIntercomSessionId(piSessionId: string, config: IntercomConfig): string {
  return process.env[STABLE_INTERCOM_SESSION_ID_ENV]?.trim() || config.stableId || piSessionId;
}
function currentTmuxPane(): string | undefined {
  const pane = process.env.TMUX_PANE?.trim();
  return pane ? pane : undefined;
}
function currentHerdrPane(): string | undefined {
  const pane = process.env.HERDR_PANE_ID?.trim();
  return pane ? pane : undefined;
}
function formatIntercomContactSnippet(sessionId: string): string {
  return `Use pi-intercom: intercom({ action: "send", to: "${sessionId}", message: "..." })`;
}
function formatSessionLabel(session: SessionInfo, duplicates: Set<string>): string {
  if (!session.name) {
    return session.id;
  }
  return duplicates.has(session.name.toLowerCase())
    ? `${session.name} (${session.id.slice(0, 8)})`
    : session.name;
}
function formatHerdrLocation(session: SessionInfo): string {
  const location = session.herdrLocation;
  if (!location) return "";
  if (location.status === "not_hosted") return "not under Herdr";
  if (location.status === "unavailable") return `Herdr location unavailable: ${location.reason} (pane ${location.paneId})`;
  return `Herdr ${location.workspace.label} [${location.workspace.id}] / ${location.tab.label} [${location.tab.id}] / pane ${location.paneId}`;
}
function formatSessionListRow(session: SessionInfo, currentCwd: string, isSelf: boolean, idPrefix: string): string {
  const name = session.name || "Unnamed session";
  const tags = [isSelf ? "self" : session.cwd === currentCwd ? "same cwd" : undefined, session.status]
    .filter((tag): tag is string => Boolean(tag));
  const suffix = tags.length ? ` [${tags.join(", ")}]` : "";
  const pane = session.tmuxPane ? ` · tmux ${session.tmuxPane}` : "";
  const herdrLocation = formatHerdrLocation(session);
  const herdr = herdrLocation ? ` · ${herdrLocation}` : "";
  return `• ${name} (${idPrefix}) — ${session.cwd} (${session.model}${formatContextUsage(session)}${pane})${herdr}${suffix}`;
}
function previewText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}
function expandHomePath(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? joinPath(homedir(), path.slice(2)) : path;
}
function firstTextContent(result: { content?: Array<{ type: string; text?: string }> }): string {
  return result.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text?.replace(/\*\*/g, "") ?? "";
}
function formatMessageTimestamp(timestamp: number | undefined): string | undefined {
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}
function formatInboundDeliveryMetadata(message: Message): string {
  const parts = [`id ${message.id}`];
  if (typeof message.senderSequence === "number") parts.push(`seq ${message.senderSequence}`);
  if (message.supersedes) parts.push(`supersedes ${message.supersedes}`);
  if (message.retryOf) parts.push(`retry of ${message.retryOf}`);
  const sentAt = formatMessageTimestamp(message.timestamp);
  if (sentAt) parts.push(`sent ${sentAt}`);
  const brokerDeliveredAt = formatMessageTimestamp(message.brokerDeliveredAt);
  if (brokerDeliveredAt) parts.push(`broker delivered ${brokerDeliveredAt}`);
  const receiverReceivedAt = formatMessageTimestamp(message.receiverReceivedAt);
  if (receiverReceivedAt) parts.push(`receiver received ${receiverReceivedAt}`);
  const injectedAt = formatMessageTimestamp(message.injectedAt);
  if (injectedAt) parts.push(`injected ${injectedAt}`);
  return parts.join(" · ");
}
function getNamePollMs(): number {
  const configured = process.env[NAME_POLL_MS_ENV];
  if (configured !== undefined) {
    const value = Number(configured);
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return 1000;
}
export default function piIntercomExtension(pi: ExtensionAPI, piVersion = VERSION) {
  let client: IntercomClient | null = null;
  const wakeWithTriggerTurn = triggerTurnRunsPromptLifecycle(piVersion);
  const config: IntercomConfig = loadConfig();
  const askTimeoutMs = getAskTimeoutMs();
  let runtimeContext: ExtensionContext | null = null;
  let currentSessionId: string | null = null;
  let currentIntercomSessionId: string | null = null;
  let currentModel = "unknown";
  let sessionStartedAt: number | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let namePollTimer: NodeJS.Timeout | null = null;
  let lastPresenceName: string | null = null;
  let lastPresenceRuntimeFallbackAlias: boolean | null = null;
  let reconnectPromise: Promise<IntercomClient> | null = null;
  let reconnectPromiseGeneration: number | null = null;
  let startupConnectTimer: NodeJS.Timeout | null = null;
  let reconnectAttempt = 0;
  let sessionHeldBlocked = false;
  let shuttingDown = false;
  let disposed = true;
  let runtimeStarted = false;
  let runtimeGeneration = 0;
  let agentRunning = false;
  const heldInboundMessages: InboundMessageEntry[] = [];
  let heldInboundTimer: NodeJS.Timeout | null = null;
  function dropHeldInboundMessage(messageId: string, receipt: { status: MessageReceiptStatus; detail?: string }): boolean {
    const index = heldInboundMessages.findIndex((entry) => entry.message.id === messageId);
    if (index < 0) return false;
    heldInboundMessages.splice(index, 1);
    if (heldInboundMessages.length === 0) clearHeldInboundTimer();
    emitMessageReceipt(messageId, receipt.status, receipt.detail);
    return true;
  }
  function expireHeldInboundMessages(detail: string): void {
    for (const entry of heldInboundMessages.splice(0)) {
      emitMessageReceipt(entry.message.id, "expired", detail);
    }
    clearHeldInboundTimer();
  }
  const activeTools = new Map<string, string>();
  const replyTracker = new ReplyTracker();

  const seenInboundMessages = new Map<string, number>();
  const latestOutboundReceipts = new Map<string, { status: MessageReceiptStatus; timestamp: number; detail?: string }>();
  function dismissIncomingAsk(messageId: string): void {
    replyTracker.dismissPendingAsk(messageId);
    dropHeldInboundMessage(messageId, { status: "acknowledged", detail: "answered before injection" });
  }
  function hasSeenInboundMessage(from: SessionInfo, message: Message, now = Date.now()): boolean {
    for (const [key, seenAt] of seenInboundMessages) {
      if (now - seenAt > INBOUND_MESSAGE_DEDUPE_RETENTION_MS) {
        seenInboundMessages.delete(key);
      }
    }
    const key = `${from.id}\0${message.id}`;
    if (seenInboundMessages.has(key)) {
      return true;
    }
    seenInboundMessages.set(key, now);
    while (seenInboundMessages.size > INBOUND_MESSAGE_DEDUPE_MAX) {
      const oldestKey = seenInboundMessages.keys().next().value;
      if (typeof oldestKey !== "string") break;
      seenInboundMessages.delete(oldestKey);
    }
    return false;
  }
  function emitMessageReceipt(messageId: string, status: MessageReceiptStatus, detail?: string): void {
    try {
      client?.sendMessageReceipt({
        messageId,
        status,
        timestamp: Date.now(),
        ...(detail ? { detail } : {}),
      });
    } catch {
    }
  }
  function handleMessageControl(control: MessageControl): void {
    replyTracker.dismissPendingAsk(control.messageId);
    const supersededDetail = control.supersededBy ? `superseded by ${control.supersededBy}` : undefined;
    if (dropHeldInboundMessage(control.messageId, control.action === "cancel"
      ? { status: "cancelled", detail: "dropped before injection" }
      : { status: "superseded", detail: supersededDetail })) return;
    if (control.action === "cancel") {
      emitMessageReceipt(control.messageId, "cancellation_requested", "message may already be injected or processed");
      return;
    }
    emitMessageReceipt(control.messageId, "superseded", supersededDetail);
  }
  function latestDeliveryState(messageId: string | null, fallback: string): string {
    if (!messageId) {
      return fallback;
    }
    const receipt = latestOutboundReceipts.get(messageId);
    return receipt ? receipt.status : fallback;
  }
  let replyWaiter: {
    from: string;
    replyTo: string;
    resolve: (message: Message) => void;
    reject: (error: Error) => void;
  } | null = null;
  function waitForReply(from: string, replyTo: string, signal?: AbortSignal, cancelOnAbort?: () => void, getDeliveryState: () => string = () => "unknown"): Promise<Message> {
    if (replyWaiter) {
      return Promise.reject(new Error("Already waiting for a reply"));
    }
    if (signal?.aborted) {
      return Promise.reject(new Error("Cancelled"));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const timeoutDescription = askTimeoutMs % 60000 === 0 ? `${askTimeoutMs / 60000} minutes` : `${askTimeoutMs}ms`;
        rejectReplyWaiter(new Error(`No reply from "${from}" for message ${replyTo} within ${timeoutDescription}. Last known delivery state: ${getDeliveryState()}. This waiter timeout is not cancellation; the delivered message may still be queued or actionable in the recipient session.`));
      }, askTimeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        if (replyWaiter?.replyTo === replyTo) {
          replyWaiter = null;
        }
      };
      const onAbort = () => {
        cancelOnAbort?.();
        cleanup();
        reject(new Error("Cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      replyWaiter = {
        from,
        replyTo,
        resolve: (message) => {
          cleanup();
          resolve(message);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
    });
  }
  function rejectReplyWaiter(error: Error): void {
    replyWaiter?.reject(error);
  }
  function clearReconnectTimer(): void {
    if (!reconnectTimer) {
      return;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  function clearStartupConnectTimer(): void {
    if (!startupConnectTimer) {
      return;
    }
    clearTimeout(startupConnectTimer);
    startupConnectTimer = null;
  }
  function clearNamePollTimer(): void {
    if (!namePollTimer) {
      return;
    }
    clearInterval(namePollTimer);
    namePollTimer = null;
  }
  function getLiveContext(ctx: ExtensionContext | null = runtimeContext, generation = runtimeGeneration): ExtensionContext | null {
    if (disposed || shuttingDown || generation !== runtimeGeneration || !ctx) {
      return null;
    }
    try {
      if (currentSessionId && ctx.sessionManager.getSessionId() !== currentSessionId) {
        return null;
      }
      void ctx.hasUI;
      return ctx;
    } catch {
      return null;
    }
  }
  function notifyIfLive(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error", generation = runtimeGeneration): void {
    const liveContext = getLiveContext(ctx, generation);
    if (!liveContext?.hasUI) {
      return;
    }
    try {
      liveContext.ui.notify(message, level);
    } catch {
    }
  }
  function notifyCommand(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error", generation = runtimeGeneration): void {
    const liveContext = getLiveContext(ctx, generation);
    if (!liveContext) return;
    if (!liveContext.hasUI) {
      console.error(message);
      return;
    }
    notifyIfLive(liveContext, message, level, generation);
  }
  function getReconnectDelayMs(): number {
    const backoffMs = [1000, 2000, 5000, 10000, 30000];
    return backoffMs[Math.min(reconnectAttempt, backoffMs.length - 1)]!;
  }
  function currentStatus(): string {
    const activeToolName = activeTools.values().next().value;
    const lifecycleStatus = activeToolName ? `tool:${activeToolName}` : agentRunning ? "thinking" : "idle";
    return config.status ? `${lifecycleStatus} · ${config.status}` : lifecycleStatus;
  }
  function buildRegistration(): SessionRegistration {
    const liveContext = getLiveContext();
    if (!liveContext || !currentSessionId || sessionStartedAt === null) {
      throw new Error("Intercom runtime not initialized");
    }

    const identity = buildPresenceIdentity(pi, currentIntercomSessionId ?? currentSessionId);
    const tmuxPane = currentTmuxPane();
    const herdrPaneId = currentHerdrPane();
    const herdrSessionPath = herdrPaneId ? liveContext.sessionManager.getSessionFile() : undefined;
    return {
      ...identity,
      cwd: liveContext.cwd,
      model: currentModel,
      pid: process.pid,
      startedAt: sessionStartedAt,
      lastActivity: Date.now(),
      status: currentStatus(),
      ...(tmuxPane ? { tmuxPane } : {}),
      ...(herdrPaneId ? { herdrPaneId } : {}),
      ...(herdrSessionPath ? { herdrSessionPath } : {}),
      acknowledgesReceipts: true,
    };
  }
  function currentContextUsage(): { contextPct?: number | null; contextTokens?: number | null; contextWindow?: number } {
    const usage = getLiveContext()?.getContextUsage?.();
    if (!usage) {
      return {};
    }
    const result: { contextPct?: number | null; contextTokens?: number | null; contextWindow?: number } = {
      contextPct: typeof usage.percent === "number" && Number.isFinite(usage.percent) ? Math.round(usage.percent) : null,
      contextTokens: typeof usage.tokens === "number" && Number.isFinite(usage.tokens) ? usage.tokens : null,
    };
    if (typeof usage.contextWindow === "number" && usage.contextWindow > 0) {
      result.contextWindow = usage.contextWindow;
    }
    return result;
  }

  function syncPresenceIdentity(sessionId: string): void {
    if (!client || !getLiveContext()) {
      return;
    }
    const identity = buildPresenceIdentity(pi, currentIntercomSessionId ?? sessionId);
    lastPresenceName = identity.name;
    lastPresenceRuntimeFallbackAlias = identity.runtimeFallbackAlias;
    client.updatePresence({ ...identity, status: currentStatus(), ...currentContextUsage() });
  }
  function startNamePoll(): void {
    clearNamePollTimer();
    const initialIdentity = currentSessionId ? buildPresenceIdentity(pi, currentIntercomSessionId ?? currentSessionId) : null;
    lastPresenceName = initialIdentity?.name ?? null;
    lastPresenceRuntimeFallbackAlias = initialIdentity?.runtimeFallbackAlias ?? null;
    namePollTimer = setInterval(() => {
      if (!currentSessionId || !getLiveContext()) {
        return;
      }
      const identity = buildPresenceIdentity(pi, currentIntercomSessionId ?? currentSessionId);
      if (identity.name !== lastPresenceName || identity.runtimeFallbackAlias !== lastPresenceRuntimeFallbackAlias) {
        syncPresenceIdentity(currentSessionId);
      }
    }, getNamePollMs());
    namePollTimer.unref?.();
  }
  function syncPresenceStatus(): void {
    if (!client || !currentSessionId || !getLiveContext()) {
      return;
    }
    client.updatePresence({ status: currentStatus(), ...currentContextUsage() });
  }
  function currentSessionTargetMatches(to: string, resolvedTo?: string | null, activeClient?: IntercomClient): boolean {
    const targets = new Set<string>();
    const addTarget = (target: string | undefined | null) => {
      const trimmed = target?.trim();
      if (trimmed) targets.add(trimmed.toLowerCase());
    };
    addTarget(currentSessionId);
    addTarget(currentIntercomSessionId);
    addTarget(activeClient?.sessionId);
    addTarget(pi.getSessionName());
    if (currentSessionId) addTarget(buildPresenceIdentity(pi, currentIntercomSessionId ?? currentSessionId).name);
    return Boolean(resolvedTo && activeClient?.sessionId && resolvedTo === activeClient.sessionId)
      || targets.has(to.trim().toLowerCase());
  }
  function shouldTriggerInboundMessage(entry: InboundMessageEntry, forceTrigger = false): boolean {
    if (forceTrigger) {
      return true;
    }
    if (config.inboundTrigger === "always") {
      return true;
    }
    if (config.inboundTrigger === "replies") {
      return Boolean(entry.message.replyTo);
    }
    return false;
  }
  function sendIncomingMessage(entry: InboundMessageEntry, delivery: "trigger" | "steer", generation = runtimeGeneration, forceTrigger = false): void {
    if (runtimeStarted && !getLiveContext(runtimeContext, generation)) {
      emitMessageReceipt(entry.message.id, "expired", "session context no longer active before injection");
      return;
    }
    const injectedMessage = { ...entry.message, injectedAt: Date.now() };
    const replyCommand = delivery === "steer" && entry.replyCommand && entry.message.expectsReply
      ? `intercom({ action: "reply", replyTo: ${JSON.stringify(entry.message.id)}, message: "..." })`
      : entry.replyCommand;
    const deliveredEntry = { ...entry, message: injectedMessage, replyCommand };
    replyTracker.queueTurnContext({ from: entry.from, message: injectedMessage, receivedAt: Date.now() });
    const senderDisplay = injectedMessage.crossMachine
      ? `${relaySenderName(injectedMessage.crossMachine.origin)} · unverified cross-machine`
      : entry.from.name || entry.from.id.slice(0, 8);
    const replyInstruction = replyCommand ? `\n\nTo reply, use the intercom tool: ${replyCommand}` : "";
    const deliveryMetadata = formatInboundDeliveryMetadata(injectedMessage);
    const trigger = delivery === "trigger" && shouldTriggerInboundMessage(entry, forceTrigger);
    const triggerContext = trigger ? getLiveContext(runtimeContext, generation) : undefined;
    const startTurn = wakeWithTriggerTurn && triggerContext?.isIdle() === true;
    pi.sendMessage(
      {
        customType: "intercom_message",
        content: `**From ${senderDisplay}** (${entry.from.cwd})${replyInstruction}\n\n_${deliveryMetadata}_\n\n${entry.bodyText}`,
        display: true,
        details: deliveredEntry,
      },
      startTurn ? { triggerTurn: true } : trigger ? undefined : { deliverAs: "steer" }
    );
    if (!wakeWithTriggerTurn && triggerContext?.isIdle() && !isIdleWakePending(triggerContext.sessionManager)) {
      reserveIdleWake(triggerContext.sessionManager);
      pi.sendUserMessage("New intercom message above.", { deliverAs: "steer" });
    }
    emitMessageReceipt(injectedMessage.id, "injected");
  }
  function sendIncomingBrokerMessage(entry: InboundMessageEntry, delivery: "trigger" | "steer", generation = runtimeGeneration): void {
    sendIncomingMessage(entry, delivery, generation);
  }
  function deliverIncomingBrokerMessage(entry: InboundMessageEntry, ctx: ExtensionContext, generation: number): void {
    const activeContext = getLiveContext(ctx, generation);
    if (!activeContext) return;
    if (!activeContext.isIdle()) {
      if (!activeContext.hasUI) {
        const activeClient = client;
        if (!entry.message.replyTo && activeClient?.isConnected()) {
          void (async () => {
            try {
              const result = await activeClient.send(entry.from.id, {
                text: "This agent is running in non-interactive mode and cannot respond to intercom messages while it is working. It will continue its current task and exit when done.",
                replyTo: entry.message.id,
              });
              if (result.delivered && getLiveContext(ctx, generation)) dismissIncomingAsk(entry.message.id);
            } catch {
            }
          })();
        }
        return;
      }
      sendIncomingBrokerMessage(entry, "steer", generation);
      return;
    }
    sendIncomingBrokerMessage(entry, "trigger", generation);
  }
  function flushHeldInboundMessages(ctx: ExtensionContext, generation: number): void {
    if (!getLiveContext(ctx, generation)) return;
    if (config.busyDelivery === "human-first" && ctx.hasUI) {
      if (ctx.isIdle() && !isIdleWakePending(ctx.sessionManager) && heldInboundMessages.length > 0) {
        deliverIncomingBrokerMessage(heldInboundMessages.shift()!, ctx, generation);
      }
      if (heldInboundMessages.length === 0) clearHeldInboundTimer();
      return;
    }
    while (heldInboundMessages.length > 0 && (ctx.isIdle() || agentRunning) && getLiveContext(ctx, generation)) {
      deliverIncomingBrokerMessage(heldInboundMessages.shift()!, ctx, generation);
    }
    if (heldInboundMessages.length === 0) clearHeldInboundTimer();
  }
  function clearHeldInboundTimer(): void {
    if (heldInboundTimer) clearInterval(heldInboundTimer);
    heldInboundTimer = null;
  }
  function holdIncomingBrokerMessage(entry: InboundMessageEntry, ctx: ExtensionContext, generation: number): void {
    heldInboundMessages.push(entry);
    emitMessageReceipt(entry.message.id, "queued", "held until delivery is safe");
    if (!heldInboundTimer) {
      heldInboundTimer = setInterval(() => flushHeldInboundMessages(ctx, generation), 100);
      heldInboundTimer.unref();
    }
  }
  function handleIncomingMessage(ctx: ExtensionContext, from: SessionInfo, message: Message): void {
    const messageGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, messageGeneration);
    if (!liveContext) {
      emitMessageReceipt(message.id, "expired", "session context no longer active on receipt");
      return;
    }
    const receiverReceivedAt = Date.now();
    if (hasSeenInboundMessage(from, message, receiverReceivedAt)) {
      emitMessageReceipt(message.id, "acknowledged", "duplicate message id suppressed");
      return;
    }
    const receivedMessage = { ...message, receiverReceivedAt };
    emitMessageReceipt(receivedMessage.id, "receiver_received");
    if (replyWaiter) {
      const senderTarget = from.name || from.id;
      const fromMatches = senderTarget.toLowerCase() === replyWaiter.from.toLowerCase()
        || from.id === replyWaiter.from;
      const replyMatches = receivedMessage.replyTo === replyWaiter.replyTo;
      if (fromMatches && replyMatches) {
        emitMessageReceipt(receivedMessage.id, "acknowledged", "matched reply waiter");
        replyWaiter.resolve(receivedMessage);
        return;
      }
    }
    const attachmentText = receivedMessage.content.attachments?.length
      ? formatAttachments(receivedMessage.content.attachments)
      : "";
    const bodyText = `${receivedMessage.content.text}${attachmentText}`;
    const replyCommand = config.replyHint && receivedMessage.crossMachine
      ? `intercom({ action: "send", to: ${JSON.stringify(relaySenderName(receivedMessage.crossMachine.origin))}, message: "..." })`
      : config.replyHint && receivedMessage.expectsReply
        ? `intercom({ action: "reply", message: "..." })`
        : undefined;
    replyTracker.recordIncomingMessage(from, receivedMessage, receiverReceivedAt);
    emitMessageReceipt(receivedMessage.id, "acknowledged", "accepted by receiver");
    const entry = { from, message: receivedMessage, replyCommand, bodyText };
    if (heldInboundMessages.length > 0 || (!liveContext.isIdle() && (!agentRunning || (config.busyDelivery === "human-first" && liveContext.hasUI)))) {
      holdIncomingBrokerMessage(entry, liveContext, messageGeneration);
    } else {
      deliverIncomingBrokerMessage(entry, liveContext, messageGeneration);
    }
  }
  function attachClientHandlers(nextClient: IntercomClient): void {
    nextClient.onBrokerMessage((message: BrokerMessage) => {
      if (client !== nextClient) return;
      if (message.type === "message_receipt") {
        latestOutboundReceipts.set(message.receipt.messageId, {
          status: message.receipt.status,
          timestamp: message.receipt.timestamp,
          ...(message.receipt.detail ? { detail: message.receipt.detail } : {}),
        });
      } else if (message.type === "message_control") {
        handleMessageControl(message.control);
      }
    });
    nextClient.on("message", (from, message) => {
      const liveContext = getLiveContext();
      if (client !== nextClient) {
        return;
      }
      if (!liveContext) {
        emitMessageReceipt(message.id, "expired", "session context no longer active on receipt");
        return;
      }
      handleIncomingMessage(liveContext, from, message);
    });
    nextClient.on("disconnected", (error: Error) => {
      if (client !== nextClient) {
        return;
      }
      rejectReplyWaiter(new Error(`Disconnected while waiting for reply: ${error.message}`, { cause: error }));
      client = null;
      if (!shuttingDown && !disposed) {
        clearReconnectTimer();
        scheduleReconnect();
      }
    });
    nextClient.on("error", () => {
    });
  }
  function scheduleReconnect(): void {
    if (disposed || shuttingDown || sessionHeldBlocked || reconnectTimer || reconnectPromise || !getLiveContext()) {
      return;
    }
    const scheduledGeneration = runtimeGeneration;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (scheduledGeneration !== runtimeGeneration || !getLiveContext()) {
        return;
      }
      reconnectAttempt += 1;
      void ensureConnected("background").catch(() => {
      });
    }, getReconnectDelayMs());
  }
  function reportSessionHeld(ctx: ExtensionContext, generation: number, error: IntercomSessionHeldError): void {
    if (sessionHeldBlocked || !getLiveContext(ctx, generation)) return;
    sessionHeldBlocked = true;
    const message = `Intercom is offline: session id ${currentIntercomSessionId} is held by process ${error.holder.pid} in ${error.holder.cwd}. Close that session and run /reload, or give this session its own PI_INTERCOM_STABLE_ID.`;
    notifyIfLive(ctx, message, "warning", generation);
    pi.appendEntry("intercom_session_held", {
      sessionId: currentIntercomSessionId,
      holder: error.holder,
      error: error.message,
      timestamp: Date.now(),
    });
  }
  async function ensureConnected(reason: "startup" | "background" | "tool" | "overlay"): Promise<IntercomClient> {
    if (!config.enabled) {
      throw new Error("Intercom disabled");
    }
    if (disposed || shuttingDown) {
      throw new Error("Intercom shutting down");
    }
    if (client && client.isConnected()) {
      return client;
    }
    const contextAtStart = getLiveContext();
    const generationAtStart = runtimeGeneration;
    if (!contextAtStart || !currentSessionId || sessionStartedAt === null) {
      throw new Error("Intercom runtime not initialized");
    }
    clearReconnectTimer();
    if (reconnectPromise && reconnectPromiseGeneration === generationAtStart) {
      return reconnectPromise;
    }
    const nextReconnectPromise = (async () => {
      const nextClient = new IntercomClient();
      client = nextClient;
      attachClientHandlers(nextClient);
      let retryAfterFailure = false;
      try {
        await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
        await nextClient.connect(buildRegistration(), currentIntercomSessionId ?? currentSessionId);
        if (!getLiveContext(contextAtStart, generationAtStart)) {
          await nextClient.disconnect();
          throw new Error("Intercom runtime no longer active");
        }
        client = nextClient;
        reconnectAttempt = 0;
        sessionHeldBlocked = false;
        return nextClient;
      } catch (error) {
        if (client === nextClient) {
          client = null;
        }
        if (error instanceof IntercomSessionHeldError) {
          reportSessionHeld(contextAtStart, generationAtStart, error);
        }
        retryAfterFailure = reason === "background";
        throw toError(error);
      } finally {
        if (reconnectPromise === nextReconnectPromise) {
          reconnectPromise = null;
          reconnectPromiseGeneration = null;
        }
        if (retryAfterFailure && getLiveContext(contextAtStart, generationAtStart)) {
          scheduleReconnect();
        }
      }
    })();
    reconnectPromise = nextReconnectPromise;
    reconnectPromiseGeneration = generationAtStart;
    return nextReconnectPromise;
  }
  async function resolveSessionTarget(activeClient: IntercomClient, nameOrId: string): Promise<string | null> {
    const sessions = await activeClient.listSessions();
    const byId = sessions.find(s => s.id === nameOrId);
    if (byId) {
      return byId.id;
    }
    const lowerName = nameOrId.toLowerCase();
    const byName = sessions.filter(s => s.name?.toLowerCase() === lowerName);
    if (byName.length > 1) {
      const prefixes = sessionIdPrefixes(sessions);
      const ids = byName.map((session) => prefixes.get(session.id)!).join(", ");
      throw new Error(`Multiple sessions named "${nameOrId}" are connected. Address one by the id shown in parentheses by "list" (${ids}).`);
    }
    if (byName.length === 1) {
      return byName[0]!.id;
    }

    const byIdPrefix = sessions.filter(s => s.id.startsWith(nameOrId));
    if (byIdPrefix.length === 1) {
      return byIdPrefix[0]!.id;
    }
    if (byIdPrefix.length > 1) {
      throw new Error(`Multiple sessions match ID prefix "${nameOrId}". Use a longer session ID prefix.`);
    }
    return null;
  }
  async function sendWithNamePrefixFallback(activeClient: IntercomClient, target: PrefixTarget, attempt: (target: string) => Promise<SendResult>): Promise<PrefixSend> {
    const { rawTo, firstTarget, display } = target;
    const result = await attempt(firstTarget);
    if (result.delivered || firstTarget !== rawTo || result.code !== "E_TARGET_NOT_FOUND") {
      return { result, display, resolution: "" };
    }
    const sessions = await activeClient.listSessions();
    const lowerName = rawTo.toLowerCase();
    const byNamePrefix = sessions.filter(s => s.name?.toLowerCase().startsWith(lowerName) ?? false);
    if (byNamePrefix.length > 1) {
      const prefixes = sessionIdPrefixes(sessions);
      const candidates = byNamePrefix.map((session) => `"${session.name}" (${prefixes.get(session.id)!})`).join(", ");
      throw new Error(`Multiple session names start with "${rawTo}": ${candidates}. Use the full name or the id shown in parentheses by "list".`);
    }
    const match = byNamePrefix[0];
    if (!match || match.id === activeClient.sessionId) {
      return { result, display, resolution: "", noMatchText: describeNoSessionMatch(sessions, rawTo) };
    }
    return { result: await attempt(match.id), display: match.name!, resolution: ` ("${rawTo}" resolved to "${match.name}")` };
  }
  async function askWithNamePrefixFallback(activeClient: IntercomClient, target: PrefixTarget, payload: Omit<Parameters<IntercomClient["send"]>[1], "messageId" | "expectsReply">, wait: {
    signal: AbortSignal | undefined;
    onAttempt: (askId: string) => void;
    deliveryState: () => string;
  }): Promise<PrefixSend & { reply: Promise<Message> }> {
    let reply!: Promise<Message>;
    const sent = await sendWithNamePrefixFallback(activeClient, target, async (attemptTo) => {
      if (wait.signal?.aborted) {
        throw new Error("Cancelled");
      }
      const askId = randomUUID();
      wait.onAttempt(askId);
      reply = waitForReply(attemptTo, askId, wait.signal, () => activeClient.cancelAsk(askId), wait.deliveryState);
      reply.catch(() => undefined);
      const result = await activeClient.send(attemptTo, { ...payload, messageId: askId, expectsReply: true });
      if (!result.delivered) {
        rejectReplyWaiter(new Error(undeliveredText(attemptTo, result)));
        await reply.catch(() => undefined);
      }
      return result;
    });
    return { ...sent, reply };
  }
  function editDistance(a: string, b: string): number {
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        row.push(Math.min(row[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost));
      }
      previous = row;
    }
    return previous[b.length]!;
  }
  function nearestSessionName(sessions: SessionInfo[], to: string): SessionInfo | null {
    const needle = to.toLowerCase();
    let best: SessionInfo | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const session of sessions) {
      if (!session.name) {
        continue;
      }
      const candidate = session.name.toLowerCase();
      const limit = Math.max(2, Math.floor(Math.max(candidate.length, needle.length) / 4));
      const distance = editDistance(candidate, needle);
      if (distance <= limit && distance < bestDistance) {
        best = session;
        bestDistance = distance;
      }
    }
    return best;
  }
  function describeNoSessionMatch(sessions: SessionInfo[], to: string): string {
    const nearest = nearestSessionName(sessions, to);
    if (nearest?.name) {
      const prefixes = sessionIdPrefixes(sessions);
      return `No connected session matches "${to}". Nearest name: "${nearest.name}" (${prefixes.get(nearest.id)!}). Run intercom list and address the session by its full name or the id shown in parentheses.`;
    }
    return `No connected session matches "${to}". Run intercom list for connected sessions.`;
  }
  async function resolveCwdDeliveryTarget(activeClient: IntercomClient, options: {
    to?: string;
    cwd: string;
    openProjectPaneIfMissing?: boolean;
    focus?: boolean;
    signal?: AbortSignal;
  }): Promise<DeliveryTarget> {
    const sessions = await activeClient.listSessions();
    const currentSessionId = activeClient.sessionId;
    if (!currentSessionId) {
      throw new Error("Current session is not registered with intercom.");
    }
    const currentSession = sessions.find((session) => session.id === currentSessionId);
    if (!currentSession) {
      throw new Error("Current session is missing from intercom session list.");
    }

    const targetCwd = options.cwd && options.cwd !== "."
      ? resolvePath(currentSession.cwd, options.cwd)
      : currentSession.cwd;
    const existing = resolveTargetInCwd({
      sessions,
      currentSessionId,
      targetCwd,
      ...(options.to ? { to: options.to } : {}),
    });
    if (existing.kind === "found" && existing.session) {
      return { id: existing.session.id, label: options.to || existing.session.name || existing.session.id };
    }
    if (!options.openProjectPaneIfMissing) {
      throw new Error(`${existing.reason ?? `No intercom session is connected in ${targetCwd}.`} Pass openProjectPaneIfMissing: true to open a Herdr project pane and start Pi there.`);
    }

    const beforeSessionIds = new Set(sessions.map((session) => session.id));
    const projectPane = await openProjectPane({ cwd: targetCwd, focus: options.focus, signal: options.signal });
    const session = await waitForProjectSession(activeClient, {
      projectRoot: projectPane.projectRoot,
      currentSessionId,
      beforeSessionIds,
      ...(options.to ? { to: options.to } : {}),
      signal: options.signal,
    });
    return { id: session.id, label: session.name || session.id, projectPane };
  }
  async function deliverMessage(
    connectedClient: IntercomClient,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    request: DeliveryRequest,
  ): Promise<IntercomToolResult> {
    const { to, cwd, openProjectPaneIfMissing, focus, message, attachments, replyTo, supersedes, retryOf } = request;
    try {
      const crossMachineTarget = Boolean(to?.includes("@"));
      const crossMachineRestriction = explicitCrossMachineSendRestriction({
        to, cwd, openProjectPaneIfMissing, attachments, replyTo, supersedes, retryOf,
      });
      if (crossMachineRestriction) {
        return {
          content: [{ type: "text", text: crossMachineRestriction }],
          details: { error: true, crossMachine: false },
        };
      }
      if (crossMachineTarget) {
        try {
          parseCrossMachineTarget(to!);
        } catch (error) {
          return {
            content: [{ type: "text", text: getErrorMessage(error) }],
            details: { error: true, crossMachine: false },
          };
        }
      }
      if (openProjectPaneIfMissing && !cwd) {
        return {
          content: [{ type: "text", text: "openProjectPaneIfMissing requires a target cwd." }],
          details: { error: true },
        };
      }
      const confirmSend = !replyTo && config.confirmSend && ctx.hasUI;
      const attachmentText = attachments?.length ? formatAttachments(attachments) : "";
      if (confirmSend && cwd && openProjectPaneIfMissing) {
        const confirmed = await ctx.ui.confirm(
          "Send message",
          `Send to "${to ?? cwd}":\n\n${message}${attachmentText}`,
        );
        if (!confirmed) {
          return {
            content: [{ type: "text", text: "Message cancelled by user" }],
            details: {},
          };
        }
      }
      if (confirmSend && crossMachineTarget) {
        const confirmed = await ctx.ui.confirm("Send message", `Send to "${to}":\n\n${message}`);
        if (!confirmed) {
          return {
            content: [{ type: "text", text: "Message cancelled by user" }],
            details: {},
          };
        }
      }
      if (crossMachineTarget) {
        if (request.handover && signal?.aborted) {
          return { content: [{ type: "text", text: "Handover was cancelled before delivery." }], details: { error: true } };
        }
        const identity = buildPresenceIdentity(pi, connectedClient.sessionId ?? ctx.sessionManager.getSessionId());
        try {
          const remote = await sendCrossMachine(to!, message, {
            name: identity.name,
            sessionId: connectedClient.sessionId ?? ctx.sessionManager.getSessionId(),
            machine: config.crossMachine.machineName,
          }, {
            remoteCommand: config.crossMachine.remoteCommand,
          });
          const remoteTarget = relaySenderName({ name: remote.agent.name, machine: remote.machine.label });
          pi.appendEntry("intercom_sent", {
            to: remoteTarget,
            message: { text: message },
            timestamp: Date.now(),
            crossMachine: true,
          });
          return {
            content: [{ type: "text", text: `Message sent to ${remoteTarget} over SSH (origin identity is SSH-asserted)` }],
            details: { delivered: true, crossMachine: true, machine: remote.machine.label, target: remote.agent.name, trust: "ssh-asserted" },
          };
        } catch (remoteError) {
          return {
            content: [{ type: "text", text: `Explicit cross-machine message to "${to}" was not delivered: ${getErrorMessage(remoteError)}` }],
            details: { error: true, crossMachine: false },
          };
        }
      }
      const target: DeliveryTarget = cwd
        ? await resolveCwdDeliveryTarget(connectedClient, { to, cwd, openProjectPaneIfMissing, focus, signal })
        : { id: (await resolveSessionTarget(connectedClient, to!)) ?? to!, label: to! };
      const sendTo = target.id;
      const targetDisplay = target.projectPane ? target.label : to ?? target.label;
      if (sendTo === connectedClient.sessionId) {
        return {
          content: [{ type: "text", text: "Cannot message the current session" }],
          details: { error: true },
        };
      }
      const activeReplyMismatch = replyTo ? null : replyTracker.findActiveReplyTargetMismatch(sendTo);
      if (activeReplyMismatch) {
        const senderLabel = activeReplyMismatch.from.name || activeReplyMismatch.from.id;
        return {
          content: [{ type: "text", text: `This turn is responding to an intercom ask from "${senderLabel}". Use intercom({ action: "reply", message: "..." }) or set replyTo: "${activeReplyMismatch.message.id}". Refusing non-reply send to "${targetDisplay}" to avoid a misdirected reply.` }],
          details: { error: true, replyTo: activeReplyMismatch.message.id },
        };
      }
      const inferredAsk = replyTo || request.handover ? null : replyTracker.findUniquePendingAskFrom(sendTo);
      const effectiveReplyTo = replyTo ?? inferredAsk?.message.id;
      if (confirmSend && !(cwd && openProjectPaneIfMissing)) {
        const confirmed = await ctx.ui.confirm(
          "Send message",
          `Send to "${targetDisplay}":\n\n${message}${attachmentText}`,
        );
        if (!confirmed) {
          return {
            content: [{ type: "text", text: "Message cancelled by user" }],
            details: {},
          };
        }
      }
      if (request.handover && signal?.aborted) {
        return { content: [{ type: "text", text: "Handover was cancelled before delivery." }], details: { error: true } };
      }
      const { result, display, resolution, noMatchText } = await sendWithNamePrefixFallback(connectedClient, { rawTo: cwd ? "" : to!, firstTarget: sendTo, display: targetDisplay }, (attemptTo) => connectedClient.send(attemptTo, {
        text: message,
        attachments,
        replyTo: effectiveReplyTo,
        supersedes,
        retryOf,
      }));
      if (!result.delivered) {
        return {
          content: [{ type: "text", text: noMatchText ?? `${undeliveredText(display, result)}${resolution}` }],
          details: { ...deliveryDetails(result), ...(noMatchText ? { error: true } : {}) },
        };
      }
      pi.appendEntry("intercom_sent", {
        to: display,
        message: { text: message, attachments, replyTo: effectiveReplyTo, supersedes, retryOf },
        messageId: result.id,
        timestamp: Date.now(),
      });
      if (effectiveReplyTo) {
        dismissIncomingAsk(effectiveReplyTo);
      }
      return {
        content: [{
          type: "text",
          text: result.delivery === "queued"
            ? queuedText(display, inferredAsk ? "reply (inferred from pending ask)" : "message")
            : target.projectPane
              ? `Opened Herdr project pane ${target.projectPane.paneId} for ${target.projectPane.projectRoot} and sent message to ${targetDisplay}`
              : inferredAsk ? `Reply sent to ${targetDisplay} (inferred from pending ask)` : `Message sent to ${display}${resolution}`,
        }],
        details: {
          ...deliveryDetails(result),
          ...(effectiveReplyTo ? { replyTo: effectiveReplyTo } : {}),
          ...(target.projectPane ? { openedProjectPane: true, paneId: target.projectPane.paneId, projectRoot: target.projectPane.projectRoot } : {}),
        },
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to send: ${getErrorMessage(error)}` }],
        details: { error: true },
      };
    }
  }
  async function buildHandoverText(
    connectedClient: IntercomClient,
    ctx: ExtensionContext,
    options: { goal?: string; crossMachine: boolean },
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const [body, git] = await Promise.all([
      generateHandoverBody(ctx, options.goal, signal),
      readGitState(ctx.cwd),
    ]);
    if (signal?.aborted) {
      throw new Error("Handover generation was aborted.");
    }
    const sessionId = connectedClient.sessionId ?? ctx.sessionManager.getSessionId();
    return formatHandoverMessage({
      senderName: pi.getSessionName()?.trim() || sessionId.slice(0, 8),
      senderCwd: ctx.cwd,
      sessionFile: options.crossMachine ? undefined : ctx.sessionManager.getSessionFile(),
      git,
      body,
    });
  }
  function startSessionRuntime(ctx: ExtensionContext): void {
    const previousClient = client;
    shuttingDown = false;
    disposed = false;
    runtimeStarted = true;
    runtimeGeneration += 1;
    reconnectAttempt = 0;
    sessionHeldBlocked = false;
    clearReconnectTimer();
    clearStartupConnectTimer();
    clearNamePollTimer();
    rejectReplyWaiter(new Error("Session replaced"));
    replyTracker.reset();
    if (previousClient) {
      client = null;
      void previousClient.disconnect().catch(() => undefined);
    }
    runtimeContext = ctx;
    currentSessionId = ctx.sessionManager.getSessionId();
    currentIntercomSessionId = resolveConfiguredIntercomSessionId(currentSessionId, config);
    currentModel = ctx.model?.id ?? "unknown";
    sessionStartedAt = Date.now();
    const initialPresenceIdentity = buildPresenceIdentity(pi, currentIntercomSessionId);
    lastPresenceName = initialPresenceIdentity.name;
    lastPresenceRuntimeFallbackAlias = initialPresenceIdentity.runtimeFallbackAlias;
    agentRunning = false;
    expireHeldInboundMessages("session replaced before injection");
    activeTools.clear();
    startNamePoll();
    const startupGeneration = runtimeGeneration;
    startupConnectTimer = setTimeout(() => {
      startupConnectTimer = null;
      if (!getLiveContext(ctx, startupGeneration)) {
        return;
      }
      void ensureConnected("startup").catch(() => {
        if (!getLiveContext(ctx, startupGeneration)) {
          return;
        }
        scheduleReconnect();
      });
    }, 0);
  }
  pi.on("session_start", (_event, ctx) => {
    if (!config.enabled) {
      return;
    }
    startSessionRuntime(ctx);
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    disposed = true;
    runtimeGeneration += 1;
    clearStartupConnectTimer();
    clearReconnectTimer();
    clearNamePollTimer();
    rejectReplyWaiter(new Error("Session shutting down"));
    replyTracker.reset();
    agentRunning = false;
    expireHeldInboundMessages("session shut down before injection");
    activeTools.clear();
    if (client) {
      await client.disconnect();
      client = null;
    }
    runtimeContext = null;
    currentSessionId = null;
    currentIntercomSessionId = null;
    sessionStartedAt = null;
  });
  pi.on("turn_end", (event, ctx) => {
    if (!getLiveContext()) {
      return;
    }
    replyTracker.endTurn();
    if (config.busyDelivery === "human-first" && ctx.hasUI && event.message.role === "assistant"
      && event.message.stopReason !== "aborted" && event.message.stopReason !== "error"
      && heldInboundMessages.length > 0 && agentRunning
      && !ctx.isIdle() && !ctx.hasPendingMessages() && getLiveContext(ctx)) {
      sendIncomingBrokerMessage(heldInboundMessages.shift()!, "steer", runtimeGeneration);
      if (heldInboundMessages.length === 0) clearHeldInboundTimer();
    }
  });
  pi.on("agent_start", (_event, ctx) => {
    releaseIdleWake(ctx.sessionManager);
    if (!getLiveContext()) {
      return;
    }
    agentRunning = true;
    if (runtimeContext) flushHeldInboundMessages(runtimeContext, runtimeGeneration);
    activeTools.clear();
    syncPresenceStatus();
  });
  pi.on("tool_execution_start", (event) => {
    if (!getLiveContext()) {
      return;
    }
    activeTools.set(event.toolCallId, event.toolName);
    syncPresenceStatus();
  });
  pi.on("tool_execution_end", (event) => {
    if (!getLiveContext()) {
      return;
    }
    activeTools.delete(event.toolCallId);
    syncPresenceStatus();
  });
  pi.on("agent_end", () => {
    if (!getLiveContext()) {
      return;
    }
    agentRunning = false;
    activeTools.clear();
    syncPresenceStatus();
  });
  pi.on("turn_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!currentSessionId || sessionId !== currentSessionId) {
      if (!config.enabled) {
        return;
      }
      startSessionRuntime(ctx);
      replyTracker.beginTurn();
      return;
    }
    if (!getLiveContext(ctx)) {
      return;
    }
    syncPresenceIdentity(sessionId);
    replyTracker.beginTurn();
  });
  pi.on("model_select", (event, ctx) => {
    if (!getLiveContext(ctx)) {
      return;
    }
    currentModel = event.model.id;
    if (client) {
      client.updatePresence({
        ...buildPresenceIdentity(pi, currentIntercomSessionId ?? ctx.sessionManager.getSessionId()),
        model: event.model.id,
        status: currentStatus(),
      });
    }
  });

  const inlineMessageExpansion = new WeakMap<object, { globalExpanded: boolean; expanded: boolean }>();
  pi.registerMessageRenderer("intercom_message", (message, options, theme) => {
    const details = message.details as { from: SessionInfo; message: Message; replyCommand?: string; bodyText?: string } | undefined;
    if (!details) return undefined;
    let expansionState = inlineMessageExpansion.get(message);
    if (!expansionState) {
      expansionState = { globalExpanded: options.expanded, expanded: options.expanded };
      inlineMessageExpansion.set(message, expansionState);
    } else if (expansionState.globalExpanded !== options.expanded) {
      expansionState.globalExpanded = options.expanded;
      expansionState.expanded = options.expanded;
    }
    return new InlineMessageComponent(details.from, details.message, theme, details.replyCommand, details.bodyText, !options.expanded, expansionState, options.outputPad);
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "intercom") {
      return;
    }
    if (!event.details || typeof event.details !== "object") {
      return;
    }

    const details = event.details as { error?: unknown; delivered?: unknown };
    if (details.error === true || details.delivered === false) {
      return { isError: true };
    }
  });

  pi.registerTool(defineTool({
    name: "intercom",
    label: "Intercom",
    description: `Send a message to another pi session running on this machine.
Use this to communicate findings, request help, or coordinate work with other sessions.

Target a session by name, full session ID, or the short id shown in parentheses
by "list" (a leading prefix of the ID is enough). Prefer the short id when two
sessions share a name. Re-list before reusing a session ID; skip if it resolves to self.

Usage:
  intercom({ action: "list" })                    → List active sessions
  intercom({ action: "list-cwd" })                → List sessions in the current working directory
  intercom({ action: "list-cwd", cwd: "/path" })  → List sessions in a specific directory
  intercom({ action: "send", to: "name-or-id", message: "..." })  → Send message
  intercom({ action: "send", cwd: "/path", openProjectPaneIfMissing: true, message: "..." }) → Open a visible Herdr project pane when needed, then send
  intercom({ action: "ask", to: "name-or-id", message: "..." })   → Ask and wait for reply
  intercom({ action: "handover", to: "name-or-id", message: "next task" }) → Summarize this session and hand it over; the receiver acts on it
  intercom({ action: "handover", cwd: "/path", openProjectPaneIfMissing: true }) → Hand over to the session in that project, opening a Herdr pane when needed
  intercom({ action: "cancel", messageId: "..." })                 → Request cancellation of a sent message
  intercom({ action: "reply", message: "..." })                      → Reply to the active/single pending ask
  intercom({ action: "pending" })                                      → List unresolved inbound asks
  intercom({ action: "status" })                  → Show connection status`,
    promptSnippet:
      "Use to coordinate with other local pi sessions: list peers, send updates, ask for help, or check intercom connectivity.",

    parameters: Type.Object({
      action: StringEnum(["list", "list-cwd", "send", "ask", "handover", "reply", "pending", "status", "cancel"] as const, {
        description: "Action: 'list', 'list-cwd', 'send', 'ask', 'handover', 'reply', 'pending', 'status', or 'cancel'. 'handover' summarizes this session with the current model and sends it to the target, which acts on it; 'message' is the optional next task.",
      }),
      to: Type.Optional(Type.String({
        description: "Target session: name, full session ID, or the short id shown in parentheses by 'list' (a leading ID prefix resolves; when no session has this exact name or ID, a leading name prefix shared by exactly one connected session also resolves, otherwise use the full name). For send/ask/handover with cwd, omit to target the sole live session in that cwd or the newly opened project-pane session. For 'reply', disambiguates the pending ask.",
      })),
      message: Type.Optional(Type.String({
        description: "Message to send (for 'send', 'ask', or 'reply' action). For 'handover', the optional next task for the receiver.",
      })),
      attachments: Type.Optional(Type.Array(Type.Object({
        type: StringEnum(["file", "snippet", "context"] as const),
        name: Type.String(),
        content: Type.String(),
        language: Type.Optional(Type.String()),
      }))),
      replyTo: Type.Optional(Type.String({
        description: "Message ID to reply to (for threading or responding to an 'ask')",
      })),
      messageId: Type.Optional(Type.String({
        description: "Message ID for actions that operate on an existing message, such as 'cancel'.",
      })),
      supersedes: Type.Optional(Type.String({
        description: "Previous message ID this send/ask explicitly supersedes. Only works for the same sender and receiver.",
      })),
      retryOf: Type.Optional(Type.String({
        description: "Previous message ID this send/ask is a user-authored retry of. Retries always send a new message ID.",
      })),
      cwd: Type.Optional(Type.String({
        description: "Working directory filter for 'list-cwd'. For send/ask/handover, scopes target lookup to that directory; omit 'to' to target the sole live peer there. Absolute, or relative to the current session's cwd; '.' means the current cwd.",
      })),
      openProjectPaneIfMissing: Type.Optional(Type.Boolean({
        description: "For send/ask/handover with cwd, open a visible Herdr project pane and launch Pi there when no matching live session is connected.",
      })),
      focus: Type.Optional(Type.Boolean({
        description: "For openProjectPaneIfMissing, focus the new Herdr pane. Defaults to true.",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let connectedClient: IntercomClient;
      try {
        connectedClient = await ensureConnected("tool");
      } catch (error) {
        return {
          content: [{ type: "text", text: `Intercom not connected: ${getErrorMessage(error)}` }],
          details: { error: true },
        };
      }

      syncPresenceIdentity(ctx.sessionManager.getSessionId());

      const { action, to, message, attachments, replyTo, messageId, supersedes, retryOf, cwd, openProjectPaneIfMissing, focus } = params;

      switch (action) {
        case "list": {
          try {
            const mySessionId = connectedClient.sessionId;
            const sessions = await connectedClient.listSessions();
            const currentSession = sessions.find(s => s.id === mySessionId);
            const otherSessions = sessions.filter(s => s.id !== mySessionId);

            if (!currentSession) {
              return {
                content: [{ type: "text", text: "Current session is missing from intercom session list." }],
                details: { error: true },
              };
            }

            const prefixes = sessionIdPrefixes(sessions);
            const currentSection = `**Current session:**\n${formatSessionListRow(currentSession, currentSession.cwd, true, prefixes.get(currentSession.id)!)}`;
            const otherSection = otherSessions.length === 0
              ? "**Other sessions:**\nNo other sessions connected."
              : `**Other sessions:**\n${otherSessions.map((session) => formatSessionListRow(session, currentSession.cwd, false, prefixes.get(session.id)!)).join("\n")}`;

            return {
              content: [{ type: "text", text: `${currentSection}\n\n${otherSection}` }],
              details: { roster: { peers: otherSessions.length, total: sessions.length } },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to list sessions: ${getErrorMessage(error)}` }],
              details: { error: true },
            };
          }
        }

        case "list-cwd": {
          try {
            const mySessionId = connectedClient.sessionId;
            const sessions = await connectedClient.listSessions();
            const currentSession = sessions.find(s => s.id === mySessionId);

            if (!currentSession) {
              return {
                content: [{ type: "text", text: "Current session is missing from intercom session list." }],
                details: { error: true },
              };
            }

            const filterCwd = cwd && cwd !== "."
              ? resolvePath(currentSession.cwd, cwd)
              : currentSession.cwd;

            const otherSessions = sessions.filter(
              s => s.id !== mySessionId && sameCwd(s.cwd, filterCwd),
            );

            let emptyNote = "No other sessions in this directory.";
            if (otherSessions.length === 0 && !sameCwd(filterCwd, currentSession.cwd)) {
              const here = sessions.filter(
                s => s.id !== mySessionId && sameCwd(s.cwd, currentSession.cwd),
              ).length;
              if (here > 0) {
                emptyNote += ` Your session's cwd is ${currentSession.cwd} (${here} peer${here === 1 ? "" : "s"} there) — call list-cwd without a cwd argument to list them.`;
              }
            }

            const prefixes = sessionIdPrefixes(sessions);
            const currentSection = `**Current session:**\n${formatSessionListRow(currentSession, currentSession.cwd, true, prefixes.get(currentSession.id)!)}`;
            const otherSection = otherSessions.length === 0
              ? `**Other sessions (cwd: ${filterCwd}):**\n${emptyNote}`
              : `**Other sessions (cwd: ${filterCwd}):**\n${otherSessions.map((session) => formatSessionListRow(session, currentSession.cwd, false, prefixes.get(session.id)!)).join("\n")}`;

            return {
              content: [{ type: "text", text: `${currentSection}\n\n${otherSection}` }],
              details: { roster: { peers: otherSessions.length, total: sessions.length, cwd: filterCwd } },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to list sessions: ${getErrorMessage(error)}` }],
              details: { error: true },
            };
          }
        }

        case "cancel": {
          if (!messageId) {
            return {
              content: [{ type: "text", text: "Missing 'messageId' parameter" }],
              details: { error: true },
            };
          }
          try {
            const result = await connectedClient.cancelMessage(messageId);
            if (!result.delivered) {
              const errorText = result.reason ?? "Message may not exist or may belong to another sender.";
              return {
                content: [{ type: "text", text: `Cancellation for ${messageId} was not delivered: ${errorText}` }],
                details: { messageId, delivered: false, reason: result.reason },
              };
            }
            return {
              content: [{ type: "text", text: `Cancellation requested for ${messageId}` }],
              details: { messageId, delivered: true },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to cancel message: ${getErrorMessage(error)}` }],
              details: { error: true, messageId },
            };
          }
        }

        case "send": {
          if ((!to && !cwd) || !message) {
            return {
              content: [{ type: "text", text: "Missing 'to' or 'cwd', or missing 'message' parameter" }],
              details: { error: true },
            };
          }
          return deliverMessage(connectedClient, ctx, _signal, {
            to, cwd, openProjectPaneIfMissing, focus, message, attachments, replyTo, supersedes, retryOf,
          });
        }

        case "handover": {
          if (!to && !cwd) {
            return {
              content: [{ type: "text", text: "Missing 'to' or 'cwd' parameter" }],
              details: { error: true },
            };
          }
          if (replyTo || supersedes || retryOf || attachments?.length) {
            return {
              content: [{ type: "text", text: "Handover always sends a new message; replyTo, supersedes, retryOf, and attachments are not supported." }],
              details: { error: true },
            };
          }
          let handoverText: string;
          try {
            handoverText = await buildHandoverText(connectedClient, ctx, { goal: message, crossMachine: Boolean(to?.includes("@")) }, _signal);
          } catch (error) {
            return {
              content: [{ type: "text", text: `Handover failed: ${getErrorMessage(error)}` }],
              details: { error: true },
            };
          }
          return deliverMessage(connectedClient, ctx, _signal, { to, cwd, openProjectPaneIfMissing, focus, message: handoverText, handover: true });
        }

        case "ask": {
          if ((!to && !cwd) || !message) {
            return {
              content: [{ type: "text", text: "Missing 'to' or 'cwd', or missing 'message' parameter" }],
              details: { error: true },
            };
          }

          if (replyWaiter) {
            return {
              content: [{ type: "text", text: "Already waiting for a reply" }],
              details: { error: true },
            };
          }

          if (_signal?.aborted) {
            return {
              content: [{ type: "text", text: "Cancelled" }],
              details: { error: true },
            };
          }
          let deliveryState = "created";
          let questionId: string | null = null;

          try {
            if (openProjectPaneIfMissing && !cwd) {
              return {
                content: [{ type: "text", text: "openProjectPaneIfMissing requires a target cwd." }],
                details: { error: true },
              };
            }
            let target: DeliveryTarget;
            if (cwd) {
              target = await resolveCwdDeliveryTarget(connectedClient, { to, cwd, openProjectPaneIfMissing, focus, signal: _signal });
            } else {
              target = { id: (await resolveSessionTarget(connectedClient, to!)) ?? to!, label: to! };
            }
            const sendTo = target.id;
            const targetDisplay = target.projectPane ? target.label : to ?? target.label;
            if (_signal?.aborted) {
              return {
                content: [{ type: "text", text: "Cancelled" }],
                details: { error: true },
              };
            }
            if (sendTo === connectedClient.sessionId) {
              return {
                content: [{ type: "text", text: "Cannot message the current session" }],
                details: { error: true },
              };
            }
            if (replyWaiter) {
              return {
                content: [{ type: "text", text: "Already waiting for a reply" }],
                details: { error: true },
              };
            }
            const sent = await askWithNamePrefixFallback(connectedClient, { rawTo: cwd ? "" : to!, firstTarget: sendTo, display: targetDisplay }, { text: message, attachments, replyTo, supersedes, retryOf }, {
              signal: _signal,
              onAttempt: (askId) => { questionId = askId; },
              deliveryState: () => latestDeliveryState(questionId, deliveryState),
            });
            const { result: sendResult, display: askTarget, resolution } = sent;

            deliveryState = sendResult.delivery;
            if (!sendResult.delivered) {
              const errorText = sent.noMatchText
                ? `${sent.noMatchText} ${BLOCKING_ASK_GUIDANCE}`
                : sendResult.code === "E_TARGET_DISCONNECTED"
                  ? `Session "${askTarget}" is not currently connected. ${BLOCKING_ASK_GUIDANCE}`
                  : `${undeliveredText(askTarget, sendResult)}${resolution}`;
              return {
                content: [{ type: "text", text: errorText }],
                details: { error: true, ...deliveryDetails(sendResult) },
              };
            }
            pi.appendEntry("intercom_sent", {
              to: askTarget,
              message: { text: message, attachments, replyTo, supersedes, retryOf },
              messageId: sendResult.id,
              timestamp: Date.now(),
            });
            const replyMessage = await sent.reply;
            const replyText = replyMessage.content.text;
            const replyAttachments = replyMessage.content.attachments?.length
              ? formatAttachments(replyMessage.content.attachments)
              : "";
            pi.appendEntry("intercom_received", {
              from: askTarget,
              message: { text: replyText, attachments: replyMessage.content.attachments },
              messageId: replyMessage.id,
              timestamp: replyMessage.timestamp,
            });
            return {
              content: [{ type: "text", text: `**Reply from ${askTarget}${resolution}:**\n${replyText}${replyAttachments}` }],
              details: target.projectPane ? { openedProjectPane: true, paneId: target.projectPane.paneId, projectRoot: target.projectPane.projectRoot } : {},
            };
          } catch (error) {
            rejectReplyWaiter(toError(error));
            return {
              content: [{ type: "text", text: `Failed: ${getErrorMessage(error)}` }],
              details: { error: true, ...(questionId ? { messageId: questionId, deliveryState: latestDeliveryState(questionId, deliveryState) } : {}) },
            };
          }
        }

        case "reply": {
          if (!message) {
            return {
              content: [{ type: "text", text: "Missing 'message' parameter" }],
              details: { error: true },
            };
          }

          try {
            const target = replyTracker.resolveReplyTarget({ to, replyTo });
            if (target.from.id === connectedClient.sessionId) {
              return {
                content: [{ type: "text", text: "Cannot message the current session" }],
                details: { error: true },
              };
            }
            const result = await connectedClient.send(target.from.id, {
              text: message,
              attachments,
              replyTo: target.message.id,
            });
            if (!result.delivered) {
              if (result.reason === "Session not found") {
                dismissIncomingAsk(target.message.id);
              }
              return {
                content: [{ type: "text", text: undeliveredText(target.from.name || target.from.id, result) }],
                details: deliveryDetails(result),
              };
            }
            dismissIncomingAsk(target.message.id);
            pi.appendEntry("intercom_sent", {
              to: target.from.name || target.from.id,
              message: { text: message, attachments, replyTo: target.message.id },
              messageId: result.id,
              timestamp: Date.now(),
            });
            return {
              content: [{ type: "text", text: result.delivery === "queued" ? queuedText(target.from.name || target.from.id, "reply") : `Reply sent to ${target.from.name || target.from.id}` }],
              details: { ...deliveryDetails(result), replyTo: target.message.id },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to reply: ${getErrorMessage(error)}` }],
              details: { error: true },
            };
          }
        }

        case "pending": {
          const pendingAsks = replyTracker.listPending();
          if (pendingAsks.length === 0) {
            return {
              content: [{ type: "text", text: "No unresolved inbound asks." }],
              details: {},
            };
          }

          const now = Date.now();
          const lines = pendingAsks.map(({ from, message, receivedAt }) => {
            const preview = message.content.text.replace(/\s+/g, " ").slice(0, 80);
            const elapsedSeconds = Math.max(0, Math.floor((now - receivedAt) / 1000));
            return `- ${from.name || from.id} · ${message.id} · ${elapsedSeconds}s ago · ${preview}`;
          });
          return {
            content: [{ type: "text", text: `**Pending asks:**\n${lines.join("\n")}` }],
            details: {},
          };
        }

        case "status": {
          try {
            const mySessionId = connectedClient.sessionId;
            const sessions = await connectedClient.listSessions();
            const pool = getIntercomScopeId();
            const mySession = sessions.find((session) => session.id === mySessionId);
            const shortId = (mySessionId ?? "unknown").slice(0, 8);
            return {
              content: [{
                type: "text",
                text: `**Intercom status:**\nConnected: Yes\nSession ID: ${mySessionId}\nSession name: ${mySession?.name ?? "(unnamed)"} (short id: ${shortId})${pool ? `\nPool: ${pool}` : ""}\nActive sessions: ${sessions.length}`,
              }],
              details: {},
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to get status: ${getErrorMessage(error)}` }],
              details: { error: true },
            };
          }
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown action: ${action}` }],
            details: { error: true },
          };
      }
    },
    summarize(args) {
      return { label: "Chat", icon: "⇄", target: [args.action, args.to?.trim()].filter(Boolean).join(" → ") };
    },
    renderCall(args, theme, context) {
      const action = typeof args.action === "string" ? args.action : "intercom";
      const target = typeof args.to === "string" && args.to.trim() ? args.to.trim() : undefined;
      const messageText = context.expanded && typeof args.message === "string"
        ? args.message
        : previewText(args.message, 96);
      const attachmentCount = Array.isArray(args.attachments) ? args.attachments.length : 0;
      let text = theme.fg("toolTitle", theme.bold("intercom "));
      text += theme.fg(action === "ask" ? "warning" : action === "reply" ? "success" : "accent", action);
      if (target) {
        text += " " + theme.fg("muted", "→") + " " + theme.fg("accent", target);
      }
      if (attachmentCount > 0) {
        text += " " + theme.fg("dim", `(${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"})`);
      }
      if (messageText) {
        text += "\n  " + theme.fg("dim", messageText);
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { isPartial }, theme, context) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Intercom working..."), 0, 0);
      }
      const details = result.details as { delivered?: boolean; error?: boolean; messageId?: string; reason?: string; roster?: { peers: number; total: number; cwd?: string } } | undefined;
      const failed = Boolean(context.isError || details?.error === true || details?.delivered === false);
      let text = failed ? theme.fg("error", "✗ ") : theme.fg("success", "✓ ");
      if (details?.roster && !failed && !context.expanded) {
        const { peers, total, cwd: rosterCwd } = details.roster;
        const where = rosterCwd ? ` in ${rosterCwd}` : "";
        text += theme.fg("text", peers === 0 ? `no other sessions${where}` : `${peers} other session${peers === 1 ? "" : "s"}${where}`);
        text += theme.fg("dim", ` (${total} connected)`);
        return new Text(text, 0, 0);
      }
      text += theme.fg(failed ? "error" : "text", firstTextContent(result));
      if (details?.messageId && !context.expanded) {
        text += theme.fg("dim", ` (${details.messageId.slice(0, 8)})`);
      }
      if (details?.reason && context.expanded) {
        text += "\n" + theme.fg("dim", `Reason: ${details.reason}`);
      }
      return new Text(text, 0, 0);
    },
  }));

  function insertIntoEditor(ctx: ExtensionContext, text: string): boolean {
    if (!ctx.hasUI) return false;
    const ui = ctx.ui as { getEditorText?: () => string; setEditorText?: (text: string) => void };
    if (typeof ui.setEditorText !== "function") return false;
    const existing = typeof ui.getEditorText === "function" ? ui.getEditorText() : "";
    ui.setEditorText(existing.trim() ? `${existing.trimEnd()}\n\n${text}` : text);
    return true;
  }

  async function insertIntercomId(ctx: ExtensionContext): Promise<void> {
    const commandGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, commandGeneration);
    if (!liveContext) return;
    let contactClient: IntercomClient;
    try {
      contactClient = await ensureConnected("tool");
    } catch (error) {
      notifyIfLive(ctx, `Intercom unavailable: ${getErrorMessage(error)}`, "error", commandGeneration);
      return;
    }
    const sessionId = contactClient.sessionId;
    if (!sessionId || !getLiveContext(liveContext, commandGeneration)) return;
    const snippet = formatIntercomContactSnippet(sessionId);
    if (insertIntoEditor(liveContext, snippet)) {
      notifyIfLive(liveContext, `Inserted intercom contact target: ${sessionId}`, "info", commandGeneration);
      return;
    }
    notifyIfLive(liveContext, `Intercom contact target: ${sessionId}`, "info", commandGeneration);
  }

  async function setIntercomAlias(args: string, ctx: ExtensionContext): Promise<void> {
    const commandGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, commandGeneration);
    if (!liveContext) return;

    let alias = args.trim();
    const opensAliasInput = !alias || alias.toLowerCase() === "menu";
    if (opensAliasInput) {
      if (!liveContext.hasUI) {
        const currentAlias = pi.getSessionName()?.trim();
        notifyCommand(
          liveContext,
          alias ? "The alias menu requires an interactive UI; use /alias <name>." : currentAlias ? `Session alias: ${currentAlias}` : "No session alias set. Use /alias <name>.",
          alias ? "warning" : "info",
          commandGeneration,
        );
        return;
      }

      const currentAlias = pi.getSessionName()?.trim();
      let entered: string | undefined;
      try {
        entered = await liveContext.ui.input(
          "Set session alias",
          currentAlias ? `Current alias: ${currentAlias}` : "Enter an alias",
        );
      } catch (error) {
        notifyCommand(liveContext, `Unable to set session alias: ${getErrorMessage(error)}`, "error", commandGeneration);
        return;
      }
      if (entered === undefined) return;
      alias = entered.trim();
      if (!alias) {
        notifyCommand(liveContext, "Session alias cannot be empty.", "warning", commandGeneration);
        return;
      }
    }

    if (!getLiveContext(liveContext, commandGeneration)) return;
    try {
      pi.setSessionName(alias);
    } catch (error) {
      notifyCommand(liveContext, `Unable to set session alias: ${getErrorMessage(error)}`, "error", commandGeneration);
      return;
    }

    syncPresenceIdentity(liveContext.sessionManager.getSessionId());
    notifyCommand(liveContext, `Session alias set: ${alias}`, "info", commandGeneration);
  }

  async function runIntercomPoolCommand(args: string, ctx: ExtensionContext): Promise<void> {
    const commandGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, commandGeneration);
    if (!liveContext) return;
    const requested = args.trim();
    if (!requested) {
      notifyCommand(liveContext, `Intercom pool: ${getIntercomScopeId() ?? "default"}`, "info", commandGeneration);
      return;
    }
    const nextPool = requested === "default" ? undefined : requested;
    await reconnectPromise?.catch(() => undefined);
    if (!getLiveContext(liveContext, commandGeneration)) return;
    if (nextPool === getIntercomScopeId()) {
      notifyCommand(liveContext, `Already in intercom pool: ${requested}`, "info", commandGeneration);
      return;
    }
    if (replyWaiter) {
      notifyCommand(liveContext, `Cannot switch intercom pool while waiting for a reply from "${replyWaiter.from}". Wait for the reply or cancel the ask first.`, "warning", commandGeneration);
      return;
    }

    setIntercomScopeId(nextPool);
    const previousClient = client;
    client = null;
    clearReconnectTimer();
    await previousClient?.disconnect().catch(() => undefined);
    if (!getLiveContext(liveContext, commandGeneration)) return;
    try {
      await ensureConnected("background");
    } catch (error) {
      if (getLiveContext(liveContext, commandGeneration)) {
        scheduleReconnect();
      }
      notifyCommand(liveContext, `Switched to intercom pool ${requested}, but intercom is unavailable: ${getErrorMessage(error)}. Retrying in the background.`, "warning", commandGeneration);
      return;
    }
    notifyCommand(liveContext, `Joined intercom pool: ${requested}`, "info", commandGeneration);
  }

  async function runHandoverCommand(args: string, ctx: ExtensionContext): Promise<void> {
    const commandGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, commandGeneration);
    if (!liveContext) return;
    if (!liveContext.hasUI || (liveContext as ExtensionContext & { mode?: string }).mode !== "tui") {
      notifyCommand(liveContext, "/handover requires the interactive terminal UI; use the intercom tool's handover action instead.", "error", commandGeneration);
      return;
    }
    const input = args.trim();
    if (!input) {
      await openHandoverPicker(liveContext, commandGeneration);
      return;
    }
    const target = input.split(/\s+/, 1)[0]!;
    const goal = input.slice(target.length).trim() || undefined;
    const isPath = /^(\/|\.\.?\/|~(\/|$))/.test(target);
    const request = isPath ? { cwd: expandHomePath(target), openProjectPaneIfMissing: true } : { to: target };
    await performHandover(liveContext, commandGeneration, request, { goal, crossMachine: !isPath && target.includes("@") });
  }

  async function openHandoverPicker(ctx: ExtensionContext, generation: number, preselectSessionId?: string): Promise<void> {
    let pickerClient: IntercomClient;
    try {
      pickerClient = await ensureConnected("tool");
    } catch (error) {
      notifyIfLive(ctx, `Intercom unavailable: ${getErrorMessage(error)}`, "error", generation);
      return;
    }
    if (!getLiveContext(ctx, generation)) return;
    syncPresenceIdentity(ctx.sessionManager.getSessionId());

    let sessions: SessionInfo[];
    try {
      sessions = await pickerClient.listSessions();
    } catch (error) {
      notifyIfLive(ctx, `Failed to list sessions: ${getErrorMessage(error)}`, "error", generation);
      return;
    }
    const currentSession = sessions.find((session) => session.id === pickerClient.sessionId);
    if (!currentSession) {
      notifyIfLive(ctx, "Current session is missing from intercom session list", "error", generation);
      return;
    }
    if (!getLiveContext(ctx, generation)) return;

    const discoveryDeps = { run: runCommand, herdrBin: process.env.HERDR_BIN_PATH ?? "herdr" };
    const lister: RemoteSessionLister = {
      listMachines: () => listSavedMachines(discoveryDeps),
      listAgents: (machine) => listMachineAgents(machine, discoveryDeps),
    };
    const picked = await ctx.ui.custom<HandoverPickerResult | undefined>(
      (tui, theme, keybindings, done) => new HandoverPicker(tui, theme, keybindings, { currentSession, sessions, lister, preselectSessionId }, done),
      { overlay: true, overlayOptions: { width: 88 } },
    ).catch(() => undefined);
    if (!picked || !getLiveContext(ctx, generation)) return;

    const { target, goal } = picked;
    if (target.kind === "local") {
      await performHandover(ctx, generation, { to: target.session.id }, { goal, crossMachine: false });
      return;
    }
    if (target.kind === "remote") {
      await performHandover(ctx, generation, { to: target.target }, { goal, crossMachine: true });
      return;
    }
    const path = (await ctx.ui.input("Project path for the new session", "~/dev/project"))?.trim();
    if (!getLiveContext(ctx, generation)) return;
    if (!path) {
      notifyIfLive(ctx, "Handover cancelled", "info", generation);
      return;
    }
    await performHandover(ctx, generation, { cwd: expandHomePath(path), openProjectPaneIfMissing: true }, { goal, crossMachine: false });
  }

  async function performHandover(
    ctx: ExtensionContext,
    generation: number,
    request: Pick<DeliveryRequest, "to" | "cwd" | "openProjectPaneIfMissing">,
    options: { goal?: string; crossMachine: boolean },
  ): Promise<void> {
    let handoverClient: IntercomClient;
    try {
      handoverClient = await ensureConnected("tool");
    } catch (error) {
      notifyIfLive(ctx, `Intercom unavailable: ${getErrorMessage(error)}`, "error", generation);
      return;
    }
    if (!getLiveContext(ctx, generation)) return;

    const generated = await ctx.ui.custom<{ text: string } | { error: string } | null>((tui, theme, _keybindings, done) => {
      const loader = new BorderedLoader(tui, theme, "Generating handover...");
      loader.onAbort = () => done(null);
      buildHandoverText(handoverClient, ctx, options, loader.signal).then(
        (text) => done({ text }),
        (error) => done(loader.signal.aborted ? null : { error: getErrorMessage(error) }),
      );
      return loader;
    });
    if (!getLiveContext(ctx, generation)) return;
    if (!generated) {
      notifyIfLive(ctx, "Handover cancelled", "info", generation);
      return;
    }
    if ("error" in generated) {
      notifyIfLive(ctx, `Handover failed: ${generated.error}`, "error", generation);
      return;
    }

    const edited = await ctx.ui.editor("Edit handover", generated.text);
    if (!getLiveContext(ctx, generation)) return;
    if (edited === undefined || !edited.trim()) {
      notifyIfLive(ctx, "Handover cancelled", "info", generation);
      return;
    }

    try {
      handoverClient = await ensureConnected("tool");
    } catch (error) {
      notifyIfLive(ctx, `Intercom unavailable: ${getErrorMessage(error)}`, "error", generation);
      return;
    }
    const result = await deliverMessage(handoverClient, ctx, undefined, { ...request, message: edited, handover: true });
    const failed = result.details.error === true || result.details.delivered === false;
    notifyIfLive(ctx, failed ? firstTextContent(result) : `Handover: ${firstTextContent(result)}`, failed ? "error" : "info", generation);
  }

  async function openIntercomOverlay(ctx: ExtensionContext): Promise<void> {
    const overlayGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, overlayGeneration);
    if (!liveContext?.hasUI || (liveContext as ExtensionContext & { mode?: string }).mode !== "tui") return;

    let overlayClient: IntercomClient;
    try {
      overlayClient = await ensureConnected("overlay");
    } catch (error) {
      notifyIfLive(ctx, `Intercom unavailable: ${getErrorMessage(error)}`, "error", overlayGeneration);
      return;
    }
    if (!getLiveContext(ctx, overlayGeneration)) return;

    syncPresenceIdentity(ctx.sessionManager.getSessionId());

    let currentSession: SessionInfo;
    let sessions: SessionInfo[];
    let duplicates: Set<string>;
    try {
      const mySessionId = overlayClient.sessionId;
      const allSessions = await overlayClient.listSessions();
      if (!getLiveContext(ctx, overlayGeneration)) return;
      const foundCurrentSession = allSessions.find(s => s.id === mySessionId);
      if (!foundCurrentSession) {
        notifyIfLive(ctx, "Current session is missing from intercom session list", "error", overlayGeneration);
        return;
      }
      currentSession = foundCurrentSession;
      duplicates = duplicateSessionNames(allSessions);
      sessions = allSessions.filter(s => s.id !== mySessionId);
    } catch (error) {
      notifyIfLive(ctx, `Failed to list sessions: ${getErrorMessage(error)}`, "error", overlayGeneration);
      return;
    }

    const selection = await ctx.ui.custom<SessionListSelection | undefined>(
      (_tui, theme, keybindings, done) => new SessionListOverlay(theme, keybindings, currentSession, sessions, done, getIntercomScopeId()),
      { overlay: true, overlayOptions: { width: 88 } }
    ).catch(() => undefined);

    if (!selection || !getLiveContext(ctx, overlayGeneration)) return;
    if (selection.action === "handover") {
      await openHandoverPicker(ctx, overlayGeneration, selection.session.id);
      return;
    }
    const selectedSession = selection.session;

    try {
      overlayClient = await ensureConnected("overlay");
    } catch (error) {
      notifyIfLive(ctx, `Intercom unavailable: ${getErrorMessage(error)}`, "error", overlayGeneration);
      return;
    }
    if (!getLiveContext(ctx, overlayGeneration)) return;

    const targetLabel = formatSessionLabel(selectedSession, duplicates);

    const result = await ctx.ui.custom<ComposeResult>(
      (tui, theme, keybindings, done) => new ComposeOverlay(tui, theme, keybindings, selectedSession, targetLabel, overlayClient, done),
      { overlay: true, overlayOptions: { width: 72 } }
    ).catch(() => undefined);

    if (result?.sent && result.messageId && result.text && getLiveContext(ctx, overlayGeneration)) {
      pi.appendEntry("intercom_sent", {
        to: selectedSession.name || selectedSession.id,
        message: { text: result.text },
        messageId: result.messageId,
        timestamp: Date.now(),
      });
      notifyIfLive(ctx, result.queued ? queuedText(targetLabel) : `Message sent to ${targetLabel}`, "info", overlayGeneration);
    }
  }

  pi.registerCommand("intercom", {
    description: "Open session intercom overlay",
    handler: async (_args, ctx) => openIntercomOverlay(ctx),
  });

  pi.registerCommand("intercom-id", {
    description: "Insert a stable pi-intercom handoff snippet for this session into the editor",
    handler: async (_args, ctx) => insertIntercomId(ctx),
  });

  pi.registerCommand("intercom-pool", {
    description: "Show or switch this session's intercom pool (usage: /intercom-pool, /intercom-pool <name>, or /intercom-pool default)",
    handler: async (args, ctx) => runIntercomPoolCommand(args, ctx),
  });

  pi.registerCommand("alias", {
    description: "Set the current session alias (usage: /alias <name> or /alias menu)",
    handler: async (args, ctx) => setIntercomAlias(args, ctx),
  });

  pi.registerCommand("handover", {
    description: "Summarize this session and hand it over to another session (usage: /handover to pick a session, or /handover <target or project path> [next task])",
    handler: async (args, ctx) => runHandoverCommand(args, ctx),
  });

  pi.registerShortcut("alt+m", {
    description: "Open session intercom",
    handler: async (ctx) => openIntercomOverlay(ctx),
  });
}
