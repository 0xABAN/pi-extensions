import { BorderedLoader, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Connection } from "./connection.ts";
import { queuedText, sendMessage, type TargetRequest } from "./delivery.ts";
import { errorMessage, expandHomePath, firstTextContent, formatSessionLabel } from "./format.ts";
import { buildHandoverText } from "./handover.ts";
import type { Inbound } from "./inbound.ts";
import { ComposeOverlay, type ComposeResult } from "./ui/compose.ts";
import { HandoverPicker, type HandoverPickerResult } from "./ui/handover-picker.ts";
import { SessionListOverlay, type SessionListSelection } from "./ui/session-list.ts";

type HandoverDraft = { text: string } | { error: string } | null;

export function registerCommands(pi: ExtensionAPI, connection: Connection, inbound: Inbound): void {
  async function listOwnSessions() {
    const client = await connection.connect();
    const sessions = await client.listSessions();
    const currentSession = sessions.find((session) => session.id === client.sessionId);
    if (!currentSession) {
      throw new Error("Current session is missing from intercom session list");
    }
    return { client, sessions, currentSession };
  }

  async function performHandover(ctx: ExtensionContext, request: TargetRequest, goal: string | undefined): Promise<void> {
    await connection.connect();
    if (!connection.context) return;

    const draft = await ctx.ui.custom<HandoverDraft>((tui, theme, _keybindings, done) => {
      const loader = new BorderedLoader(tui, theme, "Generating handover...");
      loader.onAbort = () => done(null);
      buildHandoverText(ctx, connection.name(), goal, loader.signal).then(
        (text) => done({ text }),
        (error) => done(loader.signal.aborted ? null : { error: errorMessage(error) }),
      );
      return loader;
    });
    if (!connection.context) return;
    if (!draft) {
      connection.notify("Handover cancelled", "info");
      return;
    }
    if ("error" in draft) {
      connection.notify(`Handover failed: ${draft.error}`, "error");
      return;
    }

    const edited = await ctx.ui.editor("Edit handover", draft.text);
    if (!connection.context) return;
    if (!edited?.trim()) {
      connection.notify("Handover cancelled", "info");
      return;
    }

    const client = await connection.connect();
    const result = await sendMessage(client, inbound, { ...request, message: edited, handover: true }, undefined);
    const failed = result.details.error === true || result.details.delivered === false;
    connection.notify(failed ? firstTextContent(result) : `Handover: ${firstTextContent(result)}`, failed ? "error" : "info");
  }

  async function openHandoverPicker(ctx: ExtensionContext, preselectSessionId?: string): Promise<void> {
    const { sessions, currentSession } = await listOwnSessions();
    if (!connection.context) return;

    const picked = await ctx.ui.custom<HandoverPickerResult | undefined>(
      (tui, theme, keybindings, done) => new HandoverPicker(tui, theme, keybindings, { currentSession, sessions, preselectSessionId }, done),
      { overlay: true, overlayOptions: { width: 88 } },
    );
    if (!picked || !connection.context) return;

    if (picked.target.kind === "local") {
      await performHandover(ctx, { to: picked.target.session.id }, picked.goal);
      return;
    }

    const path = (await ctx.ui.input("Project path for the new session", "~/dev/project"))?.trim();
    if (!connection.context) return;
    if (!path) {
      connection.notify("Handover cancelled", "info");
      return;
    }
    await performHandover(ctx, { cwd: expandHomePath(path), openProjectPaneIfMissing: true }, picked.goal);
  }

  async function runHandoverCommand(args: string, ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") {
      throw new Error("/handover requires the interactive terminal UI; use the intercom tool's handover action instead.");
    }

    const input = args.trim();
    if (!input) {
      await openHandoverPicker(ctx);
      return;
    }

    const target = input.split(/\s+/, 1)[0]!;
    const goal = input.slice(target.length).trim() || undefined;
    const isPath = /^(\/|\.\.?\/|~(\/|$))/.test(target);
    await performHandover(ctx, isPath ? { cwd: expandHomePath(target), openProjectPaneIfMissing: true } : { to: target }, goal);
  }

  async function openIntercomOverlay(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") return;

    const { sessions, currentSession } = await listOwnSessions();
    if (!connection.context) return;

    const others = sessions.filter((session) => session.id !== currentSession.id);
    const selection = await ctx.ui.custom<SessionListSelection | undefined>(
      (_tui, theme, keybindings, done) => new SessionListOverlay(theme, keybindings, currentSession, others, done),
      { overlay: true, overlayOptions: { width: 88 } },
    );
    if (!selection || !connection.context) return;

    if (selection.action === "handover") {
      await openHandoverPicker(ctx, selection.session.id);
      return;
    }

    const client = await connection.connect();
    const target = selection.session;
    const targetLabel = formatSessionLabel(target, sessions);
    const result = await ctx.ui.custom<ComposeResult>(
      (tui, theme, keybindings, done) => new ComposeOverlay(tui, theme, keybindings, target, targetLabel, client, done),
      { overlay: true, overlayOptions: { width: 72 } },
    );
    if (result?.sent && connection.context) {
      connection.notify(result.queued ? queuedText(targetLabel) : `Message sent to ${targetLabel}`, "info");
    }
  }

  pi.registerCommand("intercom", {
    description: "Open session intercom overlay",
    handler: (_args, ctx) => openIntercomOverlay(ctx),
  });

  pi.registerCommand("handover", {
    description: "Summarize this session and hand it over to another session (usage: /handover to pick a session, or /handover <target or project path> [next task])",
    handler: (args, ctx) => runHandoverCommand(args, ctx),
  });

  pi.registerShortcut("alt+m", {
    description: "Open session intercom",
    handler: (ctx) => openIntercomOverlay(ctx),
  });
}
