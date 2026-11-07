import { expect, test } from "bun:test";
import { ResponseTimer } from "../response-timer.ts";

test("shows nothing before the first response", () => {
  expect(new ResponseTimer().text(1_000)).toBeUndefined();
});

test("counts up while the agent works and keeps the finished duration", () => {
  const timer = new ResponseTimer();
  timer.start(1_000);
  expect(timer.text(5_200)).toBe("4.2s");

  timer.finish(66_000, true);
  expect(timer.text(90_000)).toBe("1m 5s");
});

test("keeps the previous duration when a response fails or is cancelled", () => {
  const timer = new ResponseTimer();
  timer.start(0);
  timer.finish(3_000, true);

  timer.start(10_000);
  expect(timer.text(12_500)).toBe("2.5s");
  timer.finish(20_000, false);
  expect(timer.text(30_000)).toBe("3.0s");
});

test("forgets the last duration on reset", () => {
  const timer = new ResponseTimer();
  timer.start(0);
  timer.finish(3_000, true);
  timer.reset();
  expect(timer.text(4_000)).toBeUndefined();
});
