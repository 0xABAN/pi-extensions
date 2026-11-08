import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { IntercomClient, SendResult } from "./broker/client.ts";
import { errorMessage, formatAttachments, sessionIdPrefixes } from "./format.ts";
import type { Inbound } from "./inbound.ts";
import { openProjectPane, type ProjectPaneLaunch, resolveTargetInCwd, waitForProjectSession } from "./project-agent.ts";
import type { Attachment, Message, SessionInfo } from "./types.ts";

const BLOCKING_ASK_GUIDANCE =
	"Blocking asks are not queued; use send for a non-blocking mailbox delivery or retry after the session reconnects.";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

export interface TargetRequest {
	to?: string;
	cwd?: string;
	openProjectPaneIfMissing?: boolean;
	focus?: boolean;
}

export interface SendRequest extends TargetRequest {
	message: string;
	attachments?: Attachment[];
	replyTo?: string;
	supersedes?: string;
	retryOf?: string;
	handover?: boolean;
}

interface DeliveryTarget {
	id: string;
	label: string;
	projectPane?: ProjectPaneLaunch;
}

interface PrefixSend {
	result: SendResult;
	display: string;
	resolution: string;
	noMatchText?: string;
}

export function textResult(text: string, details: Record<string, unknown> = {}): ToolResult {
	return { content: [{ type: "text", text }], details };
}

export function errorResult(text: string, details: Record<string, unknown> = {}): ToolResult {
	return textResult(text, { error: true, ...details });
}

export function queuedText(target: string, what = "message"): string {
	return `Session "${target}" is not connected. The ${what} is waiting in the broker mailbox until that session reconnects.`;
}

function undeliveredText(target: string, result: SendResult): string {
	const reason = result.reason ?? "Session may not exist or has disconnected.";
	return result.outcomeKnown
		? `Message to "${target}" was not delivered: ${reason}`
		: `Delivery to "${target}" could not be confirmed: ${reason}. The message may still arrive, so sending it again could duplicate it.`;
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

function projectPaneDetails(target: DeliveryTarget): Record<string, unknown> {
	if (!target.projectPane) {
		return {};
	}
	return { openedProjectPane: true, paneId: target.projectPane.paneId, projectRoot: target.projectPane.projectRoot };
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
	if (!nearest?.name) {
		return `No connected session matches "${to}". Run intercom list for connected sessions.`;
	}

	const prefix = sessionIdPrefixes(sessions).get(nearest.id)!;
	return `No connected session matches "${to}". Nearest name: "${nearest.name}" (${prefix}). Run intercom list and address the session by its full name or the id shown in parentheses.`;
}

async function resolveSessionTarget(client: IntercomClient, nameOrId: string): Promise<string | null> {
	const sessions = await client.listSessions();
	const byId = sessions.find((session) => session.id === nameOrId);
	if (byId) {
		return byId.id;
	}

	const lowerName = nameOrId.toLowerCase();
	const byName = sessions.filter((session) => session.name?.toLowerCase() === lowerName);
	if (byName.length > 1) {
		const prefixes = sessionIdPrefixes(sessions);
		const ids = byName.map((session) => prefixes.get(session.id)!).join(", ");
		throw new Error(
			`Multiple sessions named "${nameOrId}" are connected. Address one by the id shown in parentheses by "list" (${ids}).`,
		);
	}
	if (byName.length === 1) {
		return byName[0]!.id;
	}

	const byIdPrefix = sessions.filter((session) => session.id.startsWith(nameOrId));
	if (byIdPrefix.length > 1) {
		throw new Error(`Multiple sessions match ID prefix "${nameOrId}". Use a longer session ID prefix.`);
	}
	return byIdPrefix[0]?.id ?? null;
}

async function resolveCwdTarget(
	client: IntercomClient,
	request: TargetRequest & { cwd: string },
	signal: AbortSignal | undefined,
): Promise<DeliveryTarget> {
	const sessions = await client.listSessions();
	const currentSessionId = client.sessionId;
	const currentSession = sessions.find((session) => session.id === currentSessionId);
	if (!currentSessionId || !currentSession) {
		throw new Error("Current session is missing from intercom session list.");
	}

	const targetCwd = request.cwd !== "." ? resolve(currentSession.cwd, request.cwd) : currentSession.cwd;
	const existing = resolveTargetInCwd({
		sessions,
		currentSessionId,
		targetCwd,
		...(request.to ? { to: request.to } : {}),
	});
	if (existing.kind === "found" && existing.session) {
		return { id: existing.session.id, label: request.to || existing.session.name || existing.session.id };
	}
	if (!request.openProjectPaneIfMissing) {
		throw new Error(
			`${existing.reason ?? `No intercom session is connected in ${targetCwd}.`} Pass openProjectPaneIfMissing: true to open a Herdr project pane and start Pi there.`,
		);
	}

	const beforeSessionIds = new Set(sessions.map((session) => session.id));
	const projectPane = await openProjectPane({ cwd: targetCwd, focus: request.focus, signal });
	const session = await waitForProjectSession(client, {
		projectRoot: projectPane.projectRoot,
		currentSessionId,
		beforeSessionIds,
		...(request.to ? { to: request.to } : {}),
		signal,
	});
	return { id: session.id, label: session.name || session.id, projectPane };
}

async function resolveTarget(
	client: IntercomClient,
	request: TargetRequest,
	signal: AbortSignal | undefined,
): Promise<DeliveryTarget> {
	if (request.cwd) {
		return resolveCwdTarget(client, { ...request, cwd: request.cwd }, signal);
	}
	if (request.openProjectPaneIfMissing) {
		throw new Error("openProjectPaneIfMissing requires a target cwd.");
	}

	const to = request.to!;
	return { id: (await resolveSessionTarget(client, to)) ?? to, label: to };
}

async function sendWithNamePrefixFallback(
	client: IntercomClient,
	request: TargetRequest,
	target: DeliveryTarget,
	attempt: (to: string) => Promise<SendResult>,
): Promise<PrefixSend> {
	const result = await attempt(target.id);
	const rawTo = request.cwd ? undefined : request.to;
	if (result.delivered || target.id !== rawTo || result.code !== "E_TARGET_NOT_FOUND") {
		return { result, display: target.label, resolution: "" };
	}

	const sessions = await client.listSessions();
	const lowerName = rawTo.toLowerCase();
	const byNamePrefix = sessions.filter((session) => session.name?.toLowerCase().startsWith(lowerName) ?? false);
	if (byNamePrefix.length > 1) {
		const prefixes = sessionIdPrefixes(sessions);
		const candidates = byNamePrefix.map((session) => `"${session.name}" (${prefixes.get(session.id)!})`).join(", ");
		throw new Error(
			`Multiple session names start with "${rawTo}": ${candidates}. Use the full name or the id shown in parentheses by "list".`,
		);
	}

	const match = byNamePrefix[0];
	if (!match || match.id === client.sessionId) {
		return { result, display: target.label, resolution: "", noMatchText: describeNoSessionMatch(sessions, rawTo) };
	}
	return {
		result: await attempt(match.id),
		display: match.name!,
		resolution: ` ("${rawTo}" resolved to "${match.name}")`,
	};
}

export async function sendMessage(
	client: IntercomClient,
	inbound: Inbound,
	request: SendRequest,
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	try {
		const target = await resolveTarget(client, request, signal);
		if (target.id === client.sessionId) {
			return errorResult("Cannot message the current session");
		}

		const mismatch = request.replyTo ? null : inbound.replies.findActiveReplyTargetMismatch(target.id);
		if (mismatch) {
			const sender = mismatch.from.name || mismatch.from.id;
			return errorResult(
				`This turn is responding to an intercom ask from "${sender}". Use intercom({ action: "reply", message: "..." }) or set replyTo: "${mismatch.message.id}". Refusing non-reply send to "${target.label}" to avoid a misdirected reply.`,
				{ replyTo: mismatch.message.id },
			);
		}

		const inferredAsk =
			request.replyTo || request.handover ? null : inbound.replies.findUniquePendingAskFrom(target.id);
		const replyTo = request.replyTo ?? inferredAsk?.message.id;
		if (request.handover && signal?.aborted) {
			return errorResult("Handover was cancelled before delivery.");
		}

		const sent = await sendWithNamePrefixFallback(client, request, target, (to) =>
			client.send(to, {
				text: request.message,
				attachments: request.attachments,
				replyTo,
				supersedes: request.supersedes,
				retryOf: request.retryOf,
			}),
		);
		if (!sent.result.delivered) {
			return textResult(sent.noMatchText ?? `${undeliveredText(sent.display, sent.result)}${sent.resolution}`, {
				...deliveryDetails(sent.result),
				...(sent.noMatchText ? { error: true } : {}),
			});
		}

		if (replyTo) {
			inbound.dismiss(replyTo);
		}

		let text = inferredAsk
			? `Reply sent to ${target.label} (inferred from pending ask)`
			: `Message sent to ${sent.display}${sent.resolution}`;
		if (target.projectPane) {
			text = `Opened Herdr project pane ${target.projectPane.paneId} for ${target.projectPane.projectRoot} and sent message to ${target.label}`;
		}
		if (sent.result.delivery === "queued") {
			text = queuedText(sent.display, inferredAsk ? "reply (inferred from pending ask)" : "message");
		}
		return textResult(text, {
			...deliveryDetails(sent.result),
			...(replyTo ? { replyTo } : {}),
			...projectPaneDetails(target),
		});
	} catch (error) {
		return errorResult(`Failed to send: ${errorMessage(error)}`);
	}
}

export async function askSession(
	client: IntercomClient,
	inbound: Inbound,
	request: SendRequest,
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	if (inbound.waiting) {
		return errorResult("Already waiting for a reply");
	}
	if (signal?.aborted) {
		return errorResult("Cancelled");
	}

	let deliveryState = "created";
	let questionId: string | null = null;
	try {
		const target = await resolveTarget(client, request, signal);
		if (signal?.aborted) {
			return errorResult("Cancelled");
		}
		if (target.id === client.sessionId) {
			return errorResult("Cannot message the current session");
		}
		if (inbound.waiting) {
			return errorResult("Already waiting for a reply");
		}

		let reply!: Promise<Message>;
		const sent = await sendWithNamePrefixFallback(client, request, target, async (to) => {
			if (signal?.aborted) {
				throw new Error("Cancelled");
			}

			const askId = randomUUID();
			questionId = askId;
			reply = inbound.waitForReply(
				to,
				askId,
				signal,
				() => client.cancelAsk(askId),
				() => inbound.deliveryState(askId, deliveryState),
			);
			reply.catch(() => undefined);

			const result = await client.send(to, {
				text: request.message,
				attachments: request.attachments,
				replyTo: request.replyTo,
				supersedes: request.supersedes,
				retryOf: request.retryOf,
				messageId: askId,
				expectsReply: true,
			});
			if (!result.delivered) {
				inbound.cancelWait(new Error(undeliveredText(to, result)));
				await reply.catch(() => undefined);
			}
			return result;
		});

		deliveryState = sent.result.delivery;
		if (!sent.result.delivered) {
			let text = `${undeliveredText(sent.display, sent.result)}${sent.resolution}`;
			if (sent.result.code === "E_TARGET_DISCONNECTED") {
				text = `Session "${sent.display}" is not currently connected. ${BLOCKING_ASK_GUIDANCE}`;
			}
			if (sent.noMatchText) {
				text = `${sent.noMatchText} ${BLOCKING_ASK_GUIDANCE}`;
			}
			return errorResult(text, deliveryDetails(sent.result));
		}

		const answer = await reply;
		return textResult(
			`**Reply from ${sent.display}${sent.resolution}:**\n${answer.content.text}${formatAttachments(answer.content.attachments)}`,
			projectPaneDetails(target),
		);
	} catch (error) {
		inbound.cancelWait(error instanceof Error ? error : new Error(String(error)));
		const details = questionId
			? { messageId: questionId, deliveryState: inbound.deliveryState(questionId, deliveryState) }
			: {};
		return errorResult(`Failed: ${errorMessage(error)}`, details);
	}
}

export async function replyToAsk(
	client: IntercomClient,
	inbound: Inbound,
	request: { to?: string; replyTo?: string; message: string; attachments?: Attachment[] },
): Promise<ToolResult> {
	try {
		const target = inbound.replies.resolveReplyTarget({ to: request.to, replyTo: request.replyTo });
		if (target.from.id === client.sessionId) {
			return errorResult("Cannot message the current session");
		}

		const label = target.from.name || target.from.id;
		const result = await client.send(target.from.id, {
			text: request.message,
			attachments: request.attachments,
			replyTo: target.message.id,
		});
		if (!result.delivered) {
			if (result.reason === "Session not found") {
				inbound.dismiss(target.message.id);
			}
			return textResult(undeliveredText(label, result), deliveryDetails(result));
		}

		inbound.dismiss(target.message.id);
		return textResult(result.delivery === "queued" ? queuedText(label, "reply") : `Reply sent to ${label}`, {
			...deliveryDetails(result),
			replyTo: target.message.id,
		});
	} catch (error) {
		return errorResult(`Failed to reply: ${errorMessage(error)}`);
	}
}
