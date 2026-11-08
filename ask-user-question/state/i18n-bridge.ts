import { ROW_INTENT_META, type SentinelKind } from "./row-intent.ts";

export const I18N_NAMESPACE = "@juicesharp/rpiv-ask-user-question";

type ScopeFn = (key: string, fallback: string) => string;
type I18nSDK = { scope: (namespace: string) => ScopeFn };

let scopeImpl: ScopeFn;
try {
	const sdk = (await import("@juicesharp/rpiv-i18n")) as I18nSDK;
	scopeImpl = sdk.scope(I18N_NAMESPACE);
} catch {
	scopeImpl = (_key, fallback) => fallback;
}

export const t: ScopeFn = scopeImpl;

export function displayLabel(kind: SentinelKind): string {
	return t(`sentinel.${kind}`, ROW_INTENT_META[kind].label);
}
