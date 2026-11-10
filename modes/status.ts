import type { AgentMode } from "./utils.ts";

const EVERFOREST = {
	fg: "#D3C6AA",
	yellow: "#DBBC7F",
	green: "#A7C080",
	blue: "#7FBBB3",
	purple: "#D699B6",
};

function shine(text: string, stops: [number, number, number][]): string {
	const chars = [...text];
	const paint = chars.filter((c) => c !== " ");
	const n = Math.max(paint.length - 1, 1);
	let i = 0;
	let out = "";
	for (const ch of chars) {
		if (ch === " ") {
			out += ch;
			continue;
		}
		const t = i / n;
		const seg = Math.min(Math.floor(t * (stops.length - 1)), stops.length - 2);
		const local = t * (stops.length - 1) - seg;
		const a = stops[seg]!;
		const b = stops[seg + 1]!;
		const r = Math.round(a[0] + (b[0] - a[0]) * local);
		const g = Math.round(a[1] + (b[1] - a[1]) * local);
		const bl = Math.round(a[2] + (b[2] - a[2]) * local);
		out += `\x1b[38;2;${r};${g};${bl}m${ch}`;
		i++;
	}
	return `${out}\x1b[0m`;
}

function thinkingLabel(level: string): string {
	const labels: Record<string, string> = {
		minimal: "min",
		medium: "med",
	};
	return `think:${labels[level] ?? level}`;
}

export function formatModeStatus(
	mode: AgentMode,
	thinkingLevel?: string,
	themeName?: string,
): { mode: string; thinking: string } {
	const mid: [number, number, number] =
		mode === "learn"
			? [230, 152, 117] // warm peach (learn)
			: mode === "plan"
				? [196, 160, 230] // pastel purple (plan)
				: [173, 210, 203]; // pale teal (build, #add2cb)

	const forest = EVERFOREST;
	let hexStops: string[] | undefined;
	if (themeName === "everforest-dark-medium" || themeName === "everforest-dark-hard") {
		const accent = mode === "learn" ? forest.blue : mode === "plan" ? forest.purple : forest.green;
		hexStops = [forest.fg, accent, forest.yellow];
	}

	const stops: [number, number, number][] = hexStops
		? hexStops.map((hex) => [
				Number.parseInt(hex.slice(1, 3), 16),
				Number.parseInt(hex.slice(3, 5), 16),
				Number.parseInt(hex.slice(5, 7), 16),
			])
		: [[255, 255, 255], mid, [243, 238, 223]];

	const label = mode === "learn" ? "\uF19D  learn mode" : mode === "plan" ? "\uF022  plan mode" : "\uF121  build mode";

	return {
		mode: shine(label, stops),
		thinking: shine(thinkingLabel(thinkingLevel || "off"), stops),
	};
}
