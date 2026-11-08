import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;
const ANSI_OSC8_RE = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const FENCE_MARKER_RE = /^`{3}/;

export const BORDER_VERTICAL_OVERHEAD = 2;
export const BORDER_HORIZONTAL_OVERHEAD = 2;
export const BORDER_INNER_PADDING_HORIZONTAL = 1;
export const BOX_MIN_CONTENT_WIDTH = 40;

export function stripFenceMarkers(lines: readonly string[]): string[] {
	return lines.filter((line) => {
		const clean = line.replace(ANSI_SGR_RE, "").replace(ANSI_OSC8_RE, "");
		return !FENCE_MARKER_RE.test(clean);
	});
}

export function renderBorderedBox(
	lines: readonly string[],
	width: number,
	colorFn: (s: string) => string,
	hidden = 0,
): string[] {
	const dashSpan = Math.max(1, width - BORDER_HORIZONTAL_OVERHEAD);
	const contentInner = Math.max(1, dashSpan - 2 * BORDER_INNER_PADDING_HORIZONTAL);
	const pad = " ".repeat(BORDER_INNER_PADDING_HORIZONTAL);
	const top = colorFn(`┌${"─".repeat(dashSpan)}┐`);
	const out: string[] = [top];
	for (const line of lines) {
		const padded = truncateToWidth(line, contentInner, "", true);
		out.push(`${colorFn("│")}${pad}${padded}${pad}${colorFn("│")}`);
	}
	if (hidden > 0) {
		const indicator = ` ✂ ── ${hidden} lines hidden ── `;
		const space = dashSpan - indicator.length;
		const leftFill = "─".repeat(Math.max(0, Math.floor(space / 2)));
		const rightFill = "─".repeat(Math.max(0, dashSpan - leftFill.length - indicator.length));
		out.push(colorFn(`└${leftFill}${indicator}${rightFill}┘`));
	} else {
		out.push(colorFn(`└${"─".repeat(dashSpan)}┘`));
	}
	return out;
}

export function computeBoxDimensions(
	contentLines: readonly string[],
	maxInnerWidth: number,
): { innerWidth: number; boxWidth: number } {
	let widest = Math.min(BOX_MIN_CONTENT_WIDTH, maxInnerWidth);
	for (const line of contentLines) {
		const w = visibleWidth(line.replace(/\s+$/, ""));
		if (w > widest) widest = w;
	}
	const innerWidth = Math.min(widest, maxInnerWidth);
	const boxWidth = innerWidth + BORDER_HORIZONTAL_OVERHEAD + 2 * BORDER_INNER_PADDING_HORIZONTAL;
	return { innerWidth, boxWidth };
}
