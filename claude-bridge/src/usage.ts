import { calculateCost, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";

export type SdkUsage = {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
	output_tokens_details?: { thinking_tokens?: number | null } | null;
};

type UsageReport = {
	cachePct: number;
	reasoning?: number;
};

export function updateUsage(output: AssistantMessage, usage: SdkUsage, model: Model<Api>): UsageReport {
	if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
	if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
	if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
	if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
	const reasoning = usage.output_tokens_details?.thinking_tokens;
	if (reasoning != null) output.usage.reasoning = reasoning;
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	calculateCost(model, output.usage);
	const promptTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
	const report: UsageReport = { cachePct: promptTokens > 0 ? Math.round(output.usage.cacheRead / promptTokens * 100) : 0 };
	if (reasoning != null) report.reasoning = reasoning;
	return report;
}
