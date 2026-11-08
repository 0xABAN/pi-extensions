import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { keyHint, renderToolRow, type Theme, transcriptBodyPadding } from "@earendil-works/pi-coding-agent";
import type { SessionInfo, Message } from "../types.ts";
import { relaySenderName } from "../cross-machine-envelope.ts";

export class InlineMessageComponent implements Component {
  private from: SessionInfo;
  private message: Message;
  private theme: Theme;
  private replyCommand?: string;
  private bodyText?: string;
  private outputPad: number;
  private collapsedPreview?: string;
  private wrappedBody?: { width: number; lines: string[] };

  constructor(
    from: SessionInfo,
    message: Message,
    theme: Theme,
    replyCommand?: string,
    bodyText?: string,
    collapsed = false,
    private expansionState: { expanded: boolean } = { expanded: !collapsed },
    outputPad = 1,
  ) {
    this.from = from;
    this.message = message;
    this.theme = theme;
    this.replyCommand = replyCommand;
    this.bodyText = bodyText;
    this.outputPad = outputPad;
  }

  invalidate(): void {}

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.button !== "left"
      || event.shift || event.alt || event.ctrl || (event.clickCount ?? 1) !== 1) {
      return undefined;
    }
    this.expansionState.expanded = !this.expansionState.expanded;
    return { handled: true, render: true };
  }

  render(width: number): string[] {
    const padding = transcriptBodyPadding(this.outputPad, width);
    const indent = " ".repeat(padding);
    const bodyIndent = indent + "  ";
    const bodyWidth = width - bodyIndent.length;

    const remoteSender = this.message.crossMachine && relaySenderName(this.message.crossMachine.origin);
    const senderName = remoteSender
      ? `${remoteSender} · unverified cross-machine`
      : this.from.name || this.from.id.slice(0, 8);
    const replyLabel = remoteSender
      ? `To send a new message to ${remoteSender}:`
      : "To reply:";

    const summary = { label: "Chat", icon: "⇄", target: `From ${senderName}` };
    const lines = renderToolRow(summary, { status: "done" }, width - padding).map((line) => indent + line);
    const add = (text: string) => {
      for (const line of wrapTextWithAnsi(text, bodyWidth)) {
        lines.push(bodyIndent + this.theme.fg("dim", line));
      }
    };

    if (!this.expansionState.expanded) {
      this.collapsedPreview ??= (this.bodyText || this.message.content.text).replace(/\s+/g, " ").trim();
      lines.push(bodyIndent + this.theme.fg("text", truncateToWidth(this.collapsedPreview, bodyWidth, "…")));
      lines.push(bodyIndent + truncateToWidth(keyHint("app.tools.expand", "to expand"), bodyWidth, "…"));
      return lines;
    }

    if (this.wrappedBody?.width !== bodyWidth) {
      this.wrappedBody = {
        width: bodyWidth,
        lines: wrapTextWithAnsi(this.bodyText || this.message.content.text, bodyWidth),
      };
    }
    for (const line of this.wrappedBody.lines) {
      lines.push(bodyIndent + this.theme.fg("text", line));
    }

    add(`Sender: ${this.from.id} · ${this.from.cwd}`);
    add(`Message: ${this.message.id}`);
    if (this.replyCommand) add(`${replyLabel} ${this.replyCommand}`);
    if (this.message.replyTo && !this.message.expectsReply) add(`Reply to ${this.message.replyTo.slice(0, 8)}`);
    if (this.message.provenance?.type === "extension_outbox") add(`Via extension: ${this.message.provenance.extensionName}`);
    for (const attachment of this.message.content.attachments ?? []) {
      add(`Attachment: ${attachment.name}`);
    }
    return lines;
  }
}
