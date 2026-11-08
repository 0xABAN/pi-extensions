import { CURSOR_MARKER, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface RenderInlineInputOptions {
	buffer: string;
	cursorOffset: number | undefined;
	rowPrefix: string;
	continuationPrefix: string;
	contentWidth: number;
	selectedText: (text: string) => string;
}

function resolveCursorOffset(buffer: string, requested: number | undefined): number {
	if (requested !== undefined && requested >= 0 && requested <= buffer.length) return requested;
	return buffer.length;
}

function buildCursorRaw(buffer: string, offset: number): string {
	const before = buffer.slice(0, offset);
	const [firstGrapheme] = graphemeSegmenter.segment(buffer.slice(offset));
	const rawAt = firstGrapheme ? firstGrapheme.segment : "";
	const cursorAtLineEnd = rawAt === "\n";
	const atCursor = rawAt === "" || rawAt === " " || cursorAtLineEnd ? "\xa0" : rawAt;
	const after = buffer.slice(offset + (cursorAtLineEnd ? 0 : rawAt.length));
	return `${before}${CURSOR_MARKER}\x1b[7m${atCursor}\x1b[27m${after}`;
}

export function renderInlineInputRow(opts: RenderInlineInputOptions): string[] {
	const { buffer, cursorOffset, rowPrefix, continuationPrefix, contentWidth, selectedText } = opts;
	const raw = buildCursorRaw(buffer, resolveCursorOffset(buffer, cursorOffset));
	return wrapTextWithAnsi(raw, contentWidth).map((segment, index) => {
		const prefix = index === 0 ? rowPrefix : continuationPrefix;
		return selectedText(`${prefix}${segment}`);
	});
}
