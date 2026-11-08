import { getCurrentSystemPrompt, getCurrentTools, type Context } from "@earendil-works/pi-ai";

export function toBridgeContext(context: Context): Context {
	if (!context.messages.some((message) => message.role === "system")) return context;
	const tools = getCurrentTools(context.messages);
	return {
		...context,
		systemPrompt: getCurrentSystemPrompt(context.messages) || undefined,
		tools: tools.length > 0 ? tools : undefined,
		messages: nonSystemMessages(context.messages),
	};
}

export function nonSystemMessages<T extends { role: string }>(messages: readonly T[]): T[] {
	return messages.filter((message) => message.role !== "system");
}
