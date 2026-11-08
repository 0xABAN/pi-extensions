import { resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { IntercomClient } from "./broker/client.ts";
import type { Connection } from "./connection.ts";
import { sameCwd } from "./cwd.ts";
import { askSession, errorResult, replyToAsk, sendMessage, textResult, type ToolResult } from "./delivery.ts";
import { errorMessage, firstTextContent, formatSessionListRow, previewText, sessionIdPrefixes } from "./format.ts";
import { buildHandoverText } from "./handover.ts";
import type { Inbound } from "./inbound.ts";
import type { SessionInfo } from "./types.ts";

const DESCRIPTION = `Send a message to another pi session running on this machine.
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
  intercom({ action: "status" })                  → Show connection status`;

const PARAMETERS = Type.Object({
	action: StringEnum(
		["list", "list-cwd", "send", "ask", "handover", "reply", "pending", "status", "cancel"] as const,
		{
			description:
				"Action: 'list', 'list-cwd', 'send', 'ask', 'handover', 'reply', 'pending', 'status', or 'cancel'. 'handover' summarizes this session with the current model and sends it to the target, which acts on it; 'message' is the optional next task.",
		},
	),
	to: Type.Optional(
		Type.String({
			description:
				"Target session: name, full session ID, or the short id shown in parentheses by 'list' (a leading ID prefix resolves; when no session has this exact name or ID, a leading name prefix shared by exactly one connected session also resolves, otherwise use the full name). For send/ask/handover with cwd, omit to target the sole live session in that cwd or the newly opened project-pane session. For 'reply', disambiguates the pending ask.",
		}),
	),
	message: Type.Optional(
		Type.String({
			description:
				"Message to send (for 'send', 'ask', or 'reply' action). For 'handover', the optional next task for the receiver.",
		}),
	),
	attachments: Type.Optional(
		Type.Array(
			Type.Object({
				type: StringEnum(["file", "snippet", "context"] as const),
				name: Type.String(),
				content: Type.String(),
				language: Type.Optional(Type.String()),
			}),
		),
	),
	replyTo: Type.Optional(
		Type.String({
			description: "Message ID to reply to (for threading or responding to an 'ask')",
		}),
	),
	messageId: Type.Optional(
		Type.String({
			description: "Message ID for actions that operate on an existing message, such as 'cancel'.",
		}),
	),
	supersedes: Type.Optional(
		Type.String({
			description:
				"Previous message ID this send/ask explicitly supersedes. Only works for the same sender and receiver.",
		}),
	),
	retryOf: Type.Optional(
		Type.String({
			description:
				"Previous message ID this send/ask is a user-authored retry of. Retries always send a new message ID.",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description:
				"Working directory filter for 'list-cwd'. For send/ask/handover, scopes target lookup to that directory; omit 'to' to target the sole live peer there. Absolute, or relative to the current session's cwd; '.' means the current cwd.",
		}),
	),
	openProjectPaneIfMissing: Type.Optional(
		Type.Boolean({
			description:
				"For send/ask/handover with cwd, open a visible Herdr project pane and launch Pi there when no matching live session is connected.",
		}),
	),
	focus: Type.Optional(
		Type.Boolean({
			description: "For openProjectPaneIfMissing, focus the new Herdr pane. Defaults to true.",
		}),
	),
});

async function listSessions(client: IntercomClient, scope: { cwd?: string } | null): Promise<ToolResult> {
	const sessions = await client.listSessions();
	const current = sessions.find((session) => session.id === client.sessionId);
	if (!current) {
		return errorResult("Current session is missing from intercom session list.");
	}

	const filterCwd = scope?.cwd && scope.cwd !== "." ? resolve(current.cwd, scope.cwd) : current.cwd;
	const others = sessions.filter(
		(session) => session.id !== current.id && (!scope || sameCwd(session.cwd, filterCwd)),
	);
	const prefixes = sessionIdPrefixes(sessions);
	const row = (session: SessionInfo, isSelf: boolean) =>
		formatSessionListRow(session, current.cwd, isSelf, prefixes.get(session.id)!);

	let othersText = others.map((session) => row(session, false)).join("\n");
	if (others.length === 0 && !scope) {
		othersText = "No other sessions connected.";
	}
	if (others.length === 0 && scope) {
		othersText = "No other sessions in this directory.";
		const here = sessions.filter((session) => session.id !== current.id && sameCwd(session.cwd, current.cwd)).length;
		if (here > 0 && !sameCwd(filterCwd, current.cwd)) {
			othersText += ` Your session's cwd is ${current.cwd} (${here} peer${here === 1 ? "" : "s"} there) — call list-cwd without a cwd argument to list them.`;
		}
	}

	const heading = scope ? `**Other sessions (cwd: ${filterCwd}):**` : "**Other sessions:**";
	return textResult(`**Current session:**\n${row(current, true)}\n\n${heading}\n${othersText}`, {
		roster: { peers: others.length, total: sessions.length, ...(scope ? { cwd: filterCwd } : {}) },
	});
}

function listPending(inbound: Inbound): ToolResult {
	const pending = inbound.replies.listPending();
	if (pending.length === 0) {
		return textResult("No unresolved inbound asks.");
	}

	const now = Date.now();
	const lines = pending.map(({ from, message, receivedAt }) => {
		const preview = message.content.text.replace(/\s+/g, " ").slice(0, 80);
		const elapsedSeconds = Math.max(0, Math.floor((now - receivedAt) / 1000));
		return `- ${from.name || from.id} · ${message.id} · ${elapsedSeconds}s ago · ${preview}`;
	});
	return textResult(`**Pending asks:**\n${lines.join("\n")}`);
}

async function cancelMessage(client: IntercomClient, messageId: string): Promise<ToolResult> {
	const result = await client.cancelMessage(messageId);
	if (!result.delivered) {
		const reason = result.reason ?? "Message may not exist or may belong to another sender.";
		return textResult(`Cancellation for ${messageId} was not delivered: ${reason}`, {
			messageId,
			delivered: false,
			reason: result.reason,
		});
	}
	return textResult(`Cancellation requested for ${messageId}`, { messageId, delivered: true });
}

async function connectionStatus(client: IntercomClient): Promise<ToolResult> {
	const sessions = await client.listSessions();
	const self = sessions.find((session) => session.id === client.sessionId);
	const shortId = sessionIdPrefixes(sessions).get(client.sessionId ?? "") ?? "unknown";
	return textResult(
		`**Intercom status:**\nConnected: Yes\nSession ID: ${client.sessionId}\nSession name: ${self?.name ?? "(unnamed)"} (short id: ${shortId})\nActive sessions: ${sessions.length}`,
	);
}

export function registerIntercomTool(pi: ExtensionAPI, connection: Connection, inbound: Inbound): void {
	pi.registerTool(
		defineTool({
			name: "intercom",
			label: "Intercom",
			description: DESCRIPTION,
			promptSnippet:
				"Use to coordinate with other local pi sessions: list peers, send updates, ask for help, or check intercom connectivity.",
			parameters: PARAMETERS,

			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const {
					action,
					to,
					message,
					attachments,
					replyTo,
					messageId,
					supersedes,
					retryOf,
					cwd,
					openProjectPaneIfMissing,
					focus,
				} = params;
				try {
					const client = await connection.connect();
					switch (action) {
						case "list":
							return await listSessions(client, null);

						case "list-cwd":
							return await listSessions(client, { cwd });

						case "pending":
							return listPending(inbound);

						case "status":
							return await connectionStatus(client);

						case "cancel":
							if (!messageId) {
								return errorResult("Missing 'messageId' parameter");
							}
							return await cancelMessage(client, messageId);

						case "send":
							if ((!to && !cwd) || !message) {
								return errorResult("Missing 'to' or 'cwd', or missing 'message' parameter");
							}
							return await sendMessage(
								client,
								inbound,
								{
									to,
									cwd,
									openProjectPaneIfMissing,
									focus,
									message,
									attachments,
									replyTo,
									supersedes,
									retryOf,
								},
								signal,
							);

						case "ask":
							if ((!to && !cwd) || !message) {
								return errorResult("Missing 'to' or 'cwd', or missing 'message' parameter");
							}
							return await askSession(
								client,
								inbound,
								{
									to,
									cwd,
									openProjectPaneIfMissing,
									focus,
									message,
									attachments,
									replyTo,
									supersedes,
									retryOf,
								},
								signal,
							);

						case "reply":
							if (!message) {
								return errorResult("Missing 'message' parameter");
							}
							return await replyToAsk(client, inbound, { to, replyTo, message, attachments });

						case "handover": {
							if (!to && !cwd) {
								return errorResult("Missing 'to' or 'cwd' parameter");
							}
							if (replyTo || supersedes || retryOf || attachments?.length) {
								return errorResult(
									"Handover always sends a new message; replyTo, supersedes, retryOf, and attachments are not supported.",
								);
							}
							const handoverText = await buildHandoverText(ctx, connection.name(), message, signal);
							return await sendMessage(
								client,
								inbound,
								{ to, cwd, openProjectPaneIfMissing, focus, message: handoverText, handover: true },
								signal,
							);
						}
					}
				} catch (error) {
					return errorResult(`Intercom ${action} failed: ${errorMessage(error)}`);
				}
			},

			summarize(args) {
				return { label: "Chat", icon: "⇄", target: [args.action, args.to?.trim()].filter(Boolean).join(" → ") };
			},

			renderCall(args, theme, context) {
				const action = typeof args.action === "string" ? args.action : "intercom";
				const target = typeof args.to === "string" && args.to.trim() ? args.to.trim() : undefined;
				const messageText =
					context.expanded && typeof args.message === "string" ? args.message : previewText(args.message, 96);
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

				const details = result.details as
					| {
							delivered?: boolean;
							error?: boolean;
							messageId?: string;
							reason?: string;
							roster?: { peers: number; total: number; cwd?: string };
					  }
					| undefined;
				const failed = Boolean(context.isError || details?.error === true || details?.delivered === false);
				let text = failed ? theme.fg("error", "✗ ") : theme.fg("success", "✓ ");
				if (details?.roster && !failed && !context.expanded) {
					const { peers, total, cwd } = details.roster;
					const where = cwd ? ` in ${cwd}` : "";
					text += theme.fg(
						"text",
						peers === 0 ? `no other sessions${where}` : `${peers} other session${peers === 1 ? "" : "s"}${where}`,
					);
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
		}),
	);

	pi.on("tool_result", (event) => {
		if (event.toolName !== "intercom" || !event.details || typeof event.details !== "object") {
			return;
		}

		const details = event.details as { error?: unknown; delivered?: unknown };
		if (details.error === true || details.delivered === false) {
			return { isError: true };
		}
	});
}
