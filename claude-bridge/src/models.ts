const TWO_HUNDRED_K_CONTEXT = 200_000;
const ONE_M_CONTEXT = 1_000_000;

const FAMILY_ORDER = ["fable", "opus", "sonnet", "haiku"];

const MEASURED_ONE_M = new Set([
	"claude-fable-5",
	"claude-fable-5-1",
	"claude-opus-5-5",
	"claude-opus-5",
	"claude-opus-4-8",
	"claude-opus-4-7",
	"claude-sonnet-5",
	"claude-sonnet-5-5",
	"claude-haiku-5-5",
]);

function isDatedAlias(id: string): boolean {
	return /-20\d{6}$/.test(id);
}

function versionRank(id: string): { family: number; major: number; minor: number } {
	const [, family, major, minor] = id.split("-");
	const familyIndex = FAMILY_ORDER.indexOf(family);
	return {
		family: familyIndex === -1 ? FAMILY_ORDER.length : familyIndex,
		major: Number(major) || 0,
		minor: Number(minor) || 0,
	};
}

function compareModels(a: { id: string }, b: { id: string }): number {
	const ra = versionRank(a.id);
	const rb = versionRank(b.id);
	return ra.family - rb.family || rb.major - ra.major || rb.minor - ra.minor || a.id.localeCompare(b.id);
}

export function claudeCodeModelId(model: { id: string }): string {
	return MEASURED_ONE_M.has(model.id) ? `${model.id}[1m]` : model.id;
}

export function buildModels<T extends { id: string; [key: string]: any }>(piAiModels: T[]) {
	return piAiModels
		.filter((model) => !isDatedAlias(model.id))
		.sort(compareModels)
		.map(({ id, name, reasoning, input, maxTokens, thinkingLevelMap }) => {
			const oneM = MEASURED_ONE_M.has(id);
			return {
				id,
				name: oneM && !/\b1M\b/i.test(name) ? `${name} 1M` : name,
				reasoning,
				input,
				contextWindow: oneM ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
				maxTokens,
				thinkingLevelMap,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
		});
}
