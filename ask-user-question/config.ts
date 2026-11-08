import type { GuidanceFields } from "@juicesharp/rpiv-config";
import { loadJsonConfigWithLegacyFallback, validateGuidanceFields } from "@juicesharp/rpiv-config";

export type CollapseKeySpec = string;

export const DEFAULT_COLLAPSE_KEY: CollapseKeySpec = "ctrl+]";
export const COLLAPSE_KEY_OFF: CollapseKeySpec = "off";
export const DEFAULT_NOTES_KEY = "n";

export interface AskUserQuestionConfig {
	guidance?: GuidanceFields;
	collapseKey?: CollapseKeySpec;
	notesKey?: string;
}

const SPECIAL_KEYS = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

function isValidCollapseKeySpec(spec: string): boolean {
	if (!spec) return false;
	if (spec.startsWith("+") || spec.endsWith("+") || spec.includes("++")) return false;
	const parts = spec.split("+");
	const base = parts[parts.length - 1] ?? "";
	const modifiers = parts.slice(0, -1);
	if (modifiers.length !== new Set(modifiers).size) return false;
	if (!modifiers.every((m) => MODIFIERS.has(m))) return false;
	return base.length === 1 ? /[a-z0-9_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]/.test(base) : SPECIAL_KEYS.has(base);
}

export function resolveCollapseKey(config: Pick<AskUserQuestionConfig, "collapseKey">): CollapseKeySpec {
	const raw = config.collapseKey?.trim().toLowerCase();
	if (raw === undefined || raw === "") return DEFAULT_COLLAPSE_KEY;
	if (raw === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
	return isValidCollapseKeySpec(raw) ? raw : DEFAULT_COLLAPSE_KEY;
}

const NOTES_KEY_RESERVED = new Set(["space", "enter", "return", "tab", "escape", "esc", "up", "down", "left", "right"]);

export function resolveNotesKey(config: Pick<AskUserQuestionConfig, "notesKey">): string {
	const raw = config.notesKey?.trim();
	if (!raw) return DEFAULT_NOTES_KEY;
	if ([...raw].length === 1) return raw;
	const spec = raw.toLowerCase();
	return isValidCollapseKeySpec(spec) && !NOTES_KEY_RESERVED.has(spec) ? spec : DEFAULT_NOTES_KEY;
}

export function loadConfig(): AskUserQuestionConfig {
	return loadJsonConfigWithLegacyFallback<AskUserQuestionConfig>("rpiv-ask-user-question");
}

export { validateGuidanceFields };
