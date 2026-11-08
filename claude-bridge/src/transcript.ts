import {
	contentText,
	getCurrentSystemMessage,
	getCurrentTools,
	type Context,
	type SystemMessage,
} from "@earendil-works/pi-ai";

const SECTION_RANK = new Map<string, number>([
	["preamble", 0], ["tools", 1], ["rules", 2], ["docs", 3], ["addendum", 4],
	["project_context", 5], ["skills", 6], ["cwd", 7],
]);

function stableRanked(sections: Map<string, string>, ranks: Map<string, number>): Map<string, string> {
	const customRank = Math.max(...ranks.values()) + 1;
	const ranked = [...sections].map(([name, value]) => {
		const rank = ranks.get(name) ?? customRank;
		return { name, value, rank };
	});
	ranked.sort((a, b) => a.rank - b.rank);
	return new Map(ranked.map(({ name, value }) => [name, value]));
}

function canonicalSystemPrompt(message: SystemMessage | undefined): string | undefined {
	if (!message) return undefined;
	const sections = new Map<string, string>(
		Object.entries(message.sections ?? {}).filter((entry): entry is [string, string] => entry[1] !== null),
	);
	const parts = [contentText(message.content), ...stableRanked(sections, SECTION_RANK).values()]
		.filter((part) => part.length > 0);
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export function toBridgeContext(context: Context): Context {
	if (!context.messages.some((message) => message.role === "system")) return context;
	const tools = getCurrentTools(context.messages);
	return {
		...context,
		systemPrompt: canonicalSystemPrompt(getCurrentSystemMessage(context.messages)),
		tools: tools.length > 0 ? tools : undefined,
		messages: nonSystemMessages(context.messages),
	};
}

export function nonSystemMessages<T extends { role: string }>(messages: readonly T[]): T[] {
	return messages.filter((message) => message.role !== "system");
}
