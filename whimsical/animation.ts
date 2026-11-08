import { COLORS, messages, SYMBOLS } from "./catalog.ts";

const RESET = "\x1b[39m";

export const INTERVAL_MS = 90;

function paint(text: string, color: string): string {
	return `${color}${text}${RESET}`;
}

export function sparkleFrames(message: string): string[] {
	return Array.from({ length: SYMBOLS.length }, (_, i) => {
		const s1 = SYMBOLS[i]!;
		const s2 = SYMBOLS[(i + 3) % SYMBOLS.length]!;
		const s3 = SYMBOLS[(i + 5) % SYMBOLS.length]!;
		const c1 = COLORS[i % COLORS.length]!;
		const c2 = COLORS[(i + 2) % COLORS.length]!;
		const c3 = COLORS[(i + 4) % COLORS.length]!;
		const ct = COLORS[(i + 1) % COLORS.length]!;
		return `${paint(s1, c1)} ${paint(s2, c2)} ${paint(message, ct)} ${paint(s3, c3)}`;
	});
}

export function randomMessage(): string {
	return messages[Math.floor(Math.random() * messages.length)]!;
}
