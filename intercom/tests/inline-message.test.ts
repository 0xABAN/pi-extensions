import { beforeAll, expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { InlineMessageComponent } from "../ui/inline-message.ts";

const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
const from = { id: "a1b2c3d4e5f6", name: "planner", cwd: "/repo" } as never;
const message = { id: "m-1", timestamp: 0, content: { text: "Review the\nparser changes" } } as never;

function render(expanded: boolean, width: number): string[] {
  const component = new InlineMessageComponent(from, message, theme, "intercom reply", undefined, !expanded, { expanded }, 1);
  return component.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
}

beforeAll(() => initTheme("dark"));

test("shows a collapsed message as a chat row with a one-line preview", () => {
  expect(render(false, 100).slice(0, 2)).toEqual(["   ✓ ⇄ Chat   From planner", "     Review the parser changes"]);
});

test("expands to the full body and its delivery details", () => {
  expect(render(true, 100)).toEqual([
    "   ✓ ⇄ Chat   From planner",
    "     Review the",
    "     parser changes",
    "     Sender: a1b2c3d4e5f6 · /repo",
    "     Message: m-1",
    "     To reply: intercom reply",
  ]);
});

test("uses the transcript's narrow padding below 80 columns", () => {
  expect(render(false, 60)[0]).toBe(" ✓ ⇄ Chat   From planner");
});
