import { beforeEach, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import todoExtension from "../index.ts";
import { __resetState } from "../state/store.ts";
import { STATE_ENTRY_TYPE } from "../tool/types.ts";
import { summarizeTodo } from "../view/format.ts";

const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
const state = { tasks: [{ id: 3, subject: "Read notes", status: "pending" as const }], nextId: 4 };

function fakePi() {
  const tools = new Map<string, { execute: Function }>();
  const handlers = new Map<string, Function>();
  const entries: { type: string; data: { tasks: unknown[] } }[] = [];
  const notices: string[] = [];
  const ctx = {
    hasUI: false,
    sessionManager: { getSessionId: () => "session" },
    ui: { theme, notify: (text: string) => notices.push(text) },
  };
  const pi = {
    registerTool: (tool: { name: string; execute: Function }) => tools.set(tool.name, tool),
    registerCommand: () => {},
    registerShortcut: () => {},
    appendEntry: (type: string, data: { tasks: unknown[] }) => entries.push({ type, data }),
    on: (event: string, handler: Function) => handlers.set(event, handler),
  };
  todoExtension(pi as never, async () => ({}) as never);

  const run = async (params: Record<string, unknown>) => {
    await tools.get("todo")!.execute("call", params, undefined, undefined, ctx);
    await handlers.get("tool_execution_end")!({ toolName: "todo", isError: false }, ctx);
  };
  return { run, entries, notices, handlers, ctx };
}

beforeEach(() => __resetState());

test("summarizes each action with the task it acts on", () => {
  expect(summarizeTodo({ action: "create", subject: "Say hi" }, state).target).toBe("create Say hi");
  expect(summarizeTodo({ action: "create", tasks: [{ subject: "a" }, { subject: "b" }] }, state).target).toBe("create 2 tasks");
  expect(summarizeTodo({ action: "update", id: 3, status: "completed" }, state).target).toBe("update Read notes → completed");
  expect(summarizeTodo({ action: "delete", id: 9 }, state).target).toBe("delete #9");
  expect(summarizeTodo({ action: "clear" }, state)).toEqual({ label: "Tasks", icon: "☷", target: "clear" });
  expect(summarizeTodo({}, state).target).toBe("");
});

test("clears the list once every task is completed", async () => {
  const { run, entries, notices } = fakePi();
  await run({ action: "create", tasks: [{ subject: "Read notes" }, { subject: "Say hi" }] });
  await run({ action: "update", id: 1, status: "completed" });
  expect(notices).toEqual([]);

  await run({ action: "update", id: 2, status: "completed" });
  expect(notices).toEqual(["◇ All todos done — cleared"]);
  expect(entries.at(-1)).toEqual({ type: STATE_ENTRY_TYPE, data: expect.objectContaining({ action: "clear", tasks: [] }) });
});

test("reminds the model of open todos before each turn", async () => {
  const { run, handlers, ctx } = fakePi();
  const remind = () => handlers.get("before_agent_start")!({}, ctx);
  expect(await remind()).toBeUndefined();

  await run({ action: "create", subject: "Read notes" });
  const { message } = await remind();
  expect(message.display).toBe(false);
  expect(message.content).toContain("#1 [pending] Read notes");
});
