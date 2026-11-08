import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IntercomClient } from "./broker/client.ts";
import type { Connection } from "./connection.ts";
import { formatAttachments, formatDeliveryMetadata } from "./format.ts";
import { ReplyTracker } from "./reply-tracker.ts";
import { ASK_TIMEOUT_MS, type Message, type MessageControl, type MessageReceiptStatus, type SessionInfo } from "./types.ts";

const SEEN_MESSAGES_MAX = 1000;
const SEEN_MESSAGES_RETENTION_MS = 60 * 60 * 1000;
const HELD_FLUSH_INTERVAL_MS = 100;

export interface InboundEntry {
  from: SessionInfo;
  message: Message;
  replyCommand?: string;
  bodyText: string;
}

interface ReplyWaiter {
  from: string;
  replyTo: string;
  resolve: (message: Message) => void;
  reject: (error: Error) => void;
}

export class Inbound {
  readonly replies = new ReplyTracker();

  private readonly pi: ExtensionAPI;
  private readonly connection: Connection;
  private readonly held: InboundEntry[] = [];
  private heldTimer: NodeJS.Timeout | null = null;
  private readonly seen = new Map<string, number>();
  private readonly receipts = new Map<string, MessageReceiptStatus>();
  private waiter: ReplyWaiter | null = null;

  constructor(pi: ExtensionAPI, connection: Connection) {
    this.pi = pi;
    this.connection = connection;
  }

  get waiting(): boolean {
    return this.waiter !== null;
  }

  attach(client: IntercomClient): void {
    client.onBrokerMessage((message) => {
      if (this.connection.client !== client) return;
      if (message.type === "message_receipt") {
        this.receipts.set(message.receipt.messageId, message.receipt.status);
      } else if (message.type === "message_control") {
        this.control(message.control);
      }
    });

    client.on("message", (from: SessionInfo, message: Message) => {
      if (this.connection.client === client) {
        this.receive(from, message);
      }
    });

    client.on("disconnected", (error: Error) => {
      if (this.connection.client !== client) return;
      this.waiter?.reject(new Error(`Disconnected while waiting for reply: ${error.message}`, { cause: error }));
      this.connection.disconnected(client);
    });

    client.on("error", () => {});
  }

  stop(): void {
    this.waiter?.reject(new Error("Session shutting down"));
    this.replies.reset();
    for (const entry of this.held.splice(0)) {
      this.receipt(entry.message.id, "expired", "session shut down before injection");
    }
    this.clearHeldTimer();
  }

  flush(): void {
    const context = this.connection.context;
    while (this.held.length > 0 && context && (context.isIdle() || this.connection.agentRunning)) {
      this.deliver(this.held.shift()!);
    }
    if (this.held.length === 0) {
      this.clearHeldTimer();
    }
  }

  dismiss(messageId: string): void {
    this.replies.dismissPendingAsk(messageId);
    this.drop(messageId, "acknowledged", "answered before injection");
  }

  deliveryState(messageId: string | null, fallback: string): string {
    return (messageId && this.receipts.get(messageId)) || fallback;
  }

  waitForReply(from: string, replyTo: string, signal: AbortSignal | undefined, cancel: () => void, deliveryState: () => string): Promise<Message> {
    if (this.waiter) {
      return Promise.reject(new Error("Already waiting for a reply"));
    }
    if (signal?.aborted) {
      return Promise.reject(new Error("Cancelled"));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiter?.reject(new Error(`No reply from "${from}" for message ${replyTo} within ${ASK_TIMEOUT_MS / 60000} minutes. Last known delivery state: ${deliveryState()}. This waiter timeout is not cancellation; the delivered message may still be queued or actionable in the recipient session.`));
      }, ASK_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        if (this.waiter?.replyTo === replyTo) {
          this.waiter = null;
        }
      };

      const onAbort = () => {
        cancel();
        cleanup();
        reject(new Error("Cancelled"));
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiter = {
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

  cancelWait(error: Error): void {
    this.waiter?.reject(error);
  }

  private receive(from: SessionInfo, message: Message): void {
    const context = this.connection.context;
    if (!context) {
      this.receipt(message.id, "expired", "session context no longer active on receipt");
      return;
    }

    const receivedAt = Date.now();
    if (this.isDuplicate(from, message, receivedAt)) {
      this.receipt(message.id, "acknowledged", "duplicate message id suppressed");
      return;
    }

    const received = { ...message, receiverReceivedAt: receivedAt };
    this.receipt(received.id, "receiver_received");

    if (this.waiter && this.answersWaiter(this.waiter, from, received)) {
      this.receipt(received.id, "acknowledged", "matched reply waiter");
      this.waiter.resolve(received);
      return;
    }

    this.replies.recordIncomingMessage(from, received, receivedAt);
    this.receipt(received.id, "acknowledged", "accepted by receiver");

    const entry: InboundEntry = {
      from,
      message: received,
      replyCommand: received.expectsReply ? `intercom({ action: "reply", message: "..." })` : undefined,
      bodyText: `${received.content.text}${formatAttachments(received.content.attachments)}`,
    };
    if (this.held.length > 0 || (!context.isIdle() && !this.connection.agentRunning)) {
      this.hold(entry);
    } else {
      this.deliver(entry);
    }
  }

  private answersWaiter(waiter: ReplyWaiter, from: SessionInfo, message: Message): boolean {
    const sender = (from.name || from.id).toLowerCase();
    const fromMatches = sender === waiter.from.toLowerCase() || from.id === waiter.from;
    return fromMatches && message.replyTo === waiter.replyTo;
  }

  private isDuplicate(from: SessionInfo, message: Message, now: number): boolean {
    for (const [key, seenAt] of this.seen) {
      if (now - seenAt > SEEN_MESSAGES_RETENTION_MS) {
        this.seen.delete(key);
      }
    }

    const key = `${from.id}\0${message.id}`;
    if (this.seen.has(key)) {
      return true;
    }

    this.seen.set(key, now);
    while (this.seen.size > SEEN_MESSAGES_MAX) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return false;
  }

  private hold(entry: InboundEntry): void {
    this.held.push(entry);
    this.receipt(entry.message.id, "queued", "held until delivery is safe");
    if (!this.heldTimer) {
      this.heldTimer = setInterval(() => this.flush(), HELD_FLUSH_INTERVAL_MS);
      this.heldTimer.unref();
    }
  }

  private clearHeldTimer(): void {
    if (this.heldTimer) {
      clearInterval(this.heldTimer);
    }
    this.heldTimer = null;
  }

  private drop(messageId: string, status: MessageReceiptStatus, detail?: string): boolean {
    const index = this.held.findIndex((entry) => entry.message.id === messageId);
    if (index < 0) {
      return false;
    }

    this.held.splice(index, 1);
    if (this.held.length === 0) {
      this.clearHeldTimer();
    }
    this.receipt(messageId, status, detail);
    return true;
  }

  private control(control: MessageControl): void {
    this.replies.dismissPendingAsk(control.messageId);

    if (control.action === "cancel") {
      if (!this.drop(control.messageId, "cancelled", "dropped before injection")) {
        this.receipt(control.messageId, "cancellation_requested", "message may already be injected or processed");
      }
      return;
    }

    const detail = control.supersededBy ? `superseded by ${control.supersededBy}` : undefined;
    if (!this.drop(control.messageId, "superseded", detail)) {
      this.receipt(control.messageId, "superseded", detail);
    }
  }

  private deliver(entry: InboundEntry): void {
    const context = this.connection.context;
    if (!context) {
      this.receipt(entry.message.id, "expired", "session context no longer active before injection");
      return;
    }

    const steer = !context.isIdle();
    const message = { ...entry.message, injectedAt: Date.now() };
    const replyCommand = steer && entry.replyCommand
      ? `intercom({ action: "reply", replyTo: ${JSON.stringify(message.id)}, message: "..." })`
      : entry.replyCommand;
    this.replies.queueTurnContext({ from: entry.from, message, receivedAt: Date.now() });

    const sender = entry.from.name || entry.from.id.slice(0, 8);
    const replyInstruction = replyCommand ? `\n\nTo reply, use the intercom tool: ${replyCommand}` : "";
    this.pi.sendMessage(
      {
        customType: "intercom_message",
        content: `**From ${sender}** (${entry.from.cwd})${replyInstruction}\n\n_${formatDeliveryMetadata(message)}_\n\n${entry.bodyText}`,
        display: true,
        details: { ...entry, message, replyCommand },
      },
      steer ? { deliverAs: "steer" } : { triggerTurn: true },
    );
    this.receipt(message.id, "injected");
  }

  private receipt(messageId: string, status: MessageReceiptStatus, detail?: string): void {
    this.connection.client?.sendMessageReceipt({
      messageId,
      status,
      timestamp: Date.now(),
      ...(detail ? { detail } : {}),
    });
  }
}
