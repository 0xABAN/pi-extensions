import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export function formatDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return "—";
	const tenths = Math.round(seconds * 10) / 10;
	if (tenths < 10) return `${tenths.toFixed(1)}s`;

	const wholeSeconds = Math.round(seconds);
	if (wholeSeconds < 60) return `${wholeSeconds}s`;
	const minutes = Math.floor(wholeSeconds / 60);
	if (minutes < 60) return `${minutes}m ${String(wholeSeconds % 60).padStart(2, "0")}s`;

	const totalMinutes = Math.round(wholeSeconds / 60);
	return `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, "0")}m`;
}

/** Latest main-agent response duration, including tools and queued continuations. */
export default function responseTime(pi: ExtensionAPI): void {
	let startedAt: number | undefined;
	let lastDuration = "—";
	let lastStopReason: string | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;

	function clearTicker(): void {
		if (ticker === undefined) return;
		clearInterval(ticker);
		ticker = undefined;
	}

	function elapsedMilliseconds(): number | undefined {
		if (startedAt === undefined) return undefined;
		const elapsed = performance.now() - startedAt;
		return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined;
	}

	function displayDuration(): string {
		const elapsed = elapsedMilliseconds();
		if (elapsed === undefined) return startedAt === undefined ? lastDuration : "—";
		return elapsed === 0 ? "0.0s" : formatDuration(elapsed / 1000);
	}

	function update(ctx: ExtensionContext): void {
		if (ctx.hasUI) ctx.ui.setStatus("agent-response-time", displayDuration());
	}

	function reset(_event: unknown, ctx: ExtensionContext): void {
		startedAt = undefined;
		lastStopReason = undefined;
		lastDuration = "—";
		clearTicker();
		if (ctx.hasUI) ctx.ui.setStatus("agent-response-time", lastDuration);
	}

	pi.on("session_start", reset);
	pi.on("session_tree", reset);

	pi.on("before_agent_start", (_event, ctx) => {
		clearTicker();
		startedAt = performance.now();
		lastStopReason = undefined;
		update(ctx);
		if (ctx.hasUI) ticker = setInterval(() => update(ctx), 1000);
	});

	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") lastStopReason = event.message.stopReason;
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (startedAt === undefined) return;
		const elapsed = elapsedMilliseconds();
		startedAt = undefined;
		clearTicker();

		// Failed, cancelled and deferred attempts do not replace the last completion.
		if (elapsed !== undefined && ["stop", "length", "toolUse"].includes(lastStopReason ?? "")) {
			lastDuration = formatDuration(elapsed / 1000);
		}
		update(ctx);
		lastStopReason = undefined;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		startedAt = undefined;
		lastStopReason = undefined;
		clearTicker();
		if (ctx.hasUI) ctx.ui.setStatus("agent-response-time", undefined);
	});
}
