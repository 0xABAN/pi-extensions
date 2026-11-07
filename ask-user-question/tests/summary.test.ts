import { expect, test } from "bun:test";
import { summarizeAsk } from "../view/transcript.ts";

test("names the questions by their headers", () => {
  const args = {
    questions: [
      { question: "Which format?", header: "Format", options: [] },
      { question: "Migrate now?", header: "Migration", options: [] },
    ],
  };

  expect(summarizeAsk(args)).toEqual({ label: "Ask", icon: "◇", target: "Format · Migration" });
});

test("shows only the label while arguments stream in", () => {
  expect(summarizeAsk(undefined)).toEqual({ label: "Ask", icon: "◇", target: "" });
  expect(summarizeAsk({ questions: [undefined as never] })).toEqual({ label: "Ask", icon: "◇", target: "" });
});
