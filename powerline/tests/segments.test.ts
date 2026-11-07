import { expect, test } from "bun:test";
import { renderSegment } from "../segments.ts";
import type { SegmentContext } from "../types.ts";

function context(contextPercent: number | null, contextApproximate = false): SegmentContext {
  return {
    contextTokens: contextPercent === null ? null : 1000,
    contextPercent,
    contextWindow: 100_000,
    contextApproximate,
    options: { context: { format: "meter" } },
    theme: { fg: (_color: string, text: string) => text },
  } as unknown as SegmentContext;
}

test("draws context usage as a five-cell meter", () => {
  expect(renderSegment("context_pct", context(43)).content).toBe("● [▰▰▱▱▱] 43% context");
  expect(renderSegment("context_pct", context(100, true)).content).toBe("● [▰▰▰▰▰] ~100% context");
  expect(renderSegment("context_pct", context(null)).content).toBe("● [-----] ? context");
});
