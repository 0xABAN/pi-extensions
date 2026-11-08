import type { QuestionData } from "../tool/types.ts";
import type { WrappingSelectItem } from "../view/components/wrapping-select.ts";

export type RowKind = WrappingSelectItem["kind"];

export type SentinelKind = Exclude<RowKind, "option">;
export const SENTINEL_KINDS: readonly SentinelKind[] = ["other", "next"];

export interface RowIntentMeta {
	label: string;
	reserved: boolean;
	livesInMainList: boolean;
	numbered: boolean;
	activatesInputMode: boolean;
	blocksMultiToggle: boolean;
	autoSubmitsInMulti: boolean;
	autoAppendOnSingleSelect: boolean;
	autoAppendOnMultiSelect: boolean;
}

export const ROW_INTENT_META: Record<RowKind, RowIntentMeta> = {
	option: {
		label: "",
		reserved: false,
		livesInMainList: true,
		numbered: true,
		activatesInputMode: false,
		blocksMultiToggle: false,
		autoSubmitsInMulti: false,
		autoAppendOnSingleSelect: false,
		autoAppendOnMultiSelect: false,
	},
	other: {
		label: "Type something.",
		reserved: true,
		livesInMainList: true,
		numbered: true,
		activatesInputMode: true,
		blocksMultiToggle: false,
		autoSubmitsInMulti: false,
		autoAppendOnSingleSelect: true,
		autoAppendOnMultiSelect: true,
	},
	next: {
		label: "Next",
		reserved: true,
		livesInMainList: true,
		numbered: false,
		activatesInputMode: false,
		blocksMultiToggle: true,
		autoSubmitsInMulti: true,
		autoAppendOnSingleSelect: false,
		autoAppendOnMultiSelect: true,
	},
};

export const LABELS_BY_KIND: { readonly [K in SentinelKind]: string } = {
	other: ROW_INTENT_META.other.label,
	next: ROW_INTENT_META.next.label,
};

export const RESERVED_LABEL_SET: ReadonlySet<string> = new Set<string>([
	"Other",
	...SENTINEL_KINDS.filter((k) => ROW_INTENT_META[k].reserved).map((k) => ROW_INTENT_META[k].label),
]);

export function sentinelsToAppend(question: QuestionData): SentinelKind[] {
	const out: SentinelKind[] = [];
	for (const k of SENTINEL_KINDS) {
		const meta = ROW_INTENT_META[k];
		if (!meta.livesInMainList) continue;
		if (question.multiSelect === true) {
			if (meta.autoAppendOnMultiSelect) out.push(k);
		} else {
			if (meta.autoAppendOnSingleSelect) out.push(k);
		}
	}
	return out;
}
