import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const normalizeCache = new Map<string, string>();

export function normalizeCwd(cwd: string): string {
	const cached = normalizeCache.get(cwd);
	if (cached !== undefined) {
		return cached;
	}
	const resolved = resolve(cwd);
	let normalized: string;
	try {
		normalized = realpathSync(resolved);
	} catch {
		normalized = resolved;
	}
	normalizeCache.set(cwd, normalized);
	return normalized;
}

export function sameCwd(a: string, b: string): boolean {
	return normalizeCwd(a) === normalizeCwd(b);
}
