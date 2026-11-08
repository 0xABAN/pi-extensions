import type { QuestionParams } from "./types.ts";

export function normalizeLineTerminators(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

function normalizeStringFields<T extends object>(obj: T, keys: readonly (keyof T)[]): T {
	const out = { ...obj };
	for (const key of keys) {
		const value = obj[key];
		if (typeof value === "string") out[key] = normalizeLineTerminators(value) as T[typeof key];
	}
	return out;
}

export function normalizeQuestionParams(params: QuestionParams): QuestionParams {
	return {
		...params,
		questions: params.questions.map((q) => ({
			...normalizeStringFields(q, ["question", "header"]),
			options: q.options.map((o) => normalizeStringFields(o, ["label", "description", "preview"])),
		})),
	};
}

export function prepareQuestionArguments(args: unknown): QuestionParams {
	if (!isRecord(args)) return args as QuestionParams;
	const questions = decodeArray(args.questions);
	if (!Array.isArray(questions)) return args as QuestionParams;
	const decoded = questions.map((q) => {
		const question = decodeObject(q);
		if (!isRecord(question)) return question;
		const options = decodeArray(question.options);
		return Array.isArray(options) ? { ...question, options: options.map(decodeObject) } : question;
	});
	return { ...args, questions: decoded } as unknown as QuestionParams;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeArray(value: unknown): unknown {
	const parsed = typeof value === "string" ? parseJson(value) : value;
	return Array.isArray(parsed) ? parsed : value;
}

function decodeObject(value: unknown): unknown {
	const parsed = typeof value === "string" ? parseJson(value) : value;
	return isRecord(parsed) ? parsed : value;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
