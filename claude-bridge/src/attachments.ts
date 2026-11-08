import type { ImportAttachment, JsonlRecord } from "cc-session-io";
import { messageContentToText } from "./convert.js";

const CONTENT_BEARING = new Set(["file"]);

export type CarriedAttachment = {
	attachment: { type: string; [key: string]: unknown };
	userOrdinal: number;
	parentText: string;
};

type Rec = Record<string, unknown>;

function userPromptText(record: Rec): string | undefined {
	if (record.type !== "user") return undefined;
	const content = (record.message as Rec | undefined)?.content;
	if (Array.isArray(content) && content.some((b) => (b as Rec)?.type === "tool_result")) return undefined;
	const text = messageContentToText(content as never);
	return text ? text : undefined;
}

export function collectCarriedAttachments(records: readonly JsonlRecord[]): CarriedAttachment[] {
	const ordinalOf = new Map<string, number>();
	const textOf = new Map<string, string>();
	let ordinal = 0;
	const carried: CarriedAttachment[] = [];

	for (const raw of records) {
		const record = raw as Rec;
		const prompt = userPromptText(record);
		if (prompt !== undefined) {
			ordinalOf.set(record.uuid as string, ordinal++);
			textOf.set(record.uuid as string, prompt);
			continue;
		}
		if (record.type !== "attachment") continue;
		const parent = record.parentUuid as string | null;
		if (parent === null || !ordinalOf.has(parent)) continue;
		const inherited = ordinalOf.get(parent)!;
		ordinalOf.set(record.uuid as string, inherited);
		textOf.set(record.uuid as string, textOf.get(parent)!);

		const attachment = record.attachment as { type: string; [key: string]: unknown } | undefined;
		if (!attachment || !CONTENT_BEARING.has(attachment.type)) continue;
		carried.push({ attachment, userOrdinal: inherited, parentText: textOf.get(parent)! });
	}
	return carried;
}

export function placeCarriedAttachments(
	carried: readonly CarriedAttachment[],
	messages: readonly { role: string; content: unknown }[],
): ImportAttachment[] {
	const prompts: { index: number; text: string }[] = [];
	messages.forEach((msg, index) => {
		if (msg.role !== "user") return;
		if (Array.isArray(msg.content) && msg.content.some((b) => (b as Rec)?.type === "tool_result")) return;
		const text = messageContentToText(msg.content as never);
		if (text) prompts.push({ index, text });
	});

	const attachments: ImportAttachment[] = [];
	for (const item of carried) {
		const candidate = prompts[item.userOrdinal];
		if (!candidate || candidate.text !== item.parentText) continue;
		attachments.push({ afterIndex: candidate.index, attachment: item.attachment });
	}
	return attachments;
}
