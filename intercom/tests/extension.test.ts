import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { InboundEntry } from "../inbound.ts";

const agentDir = mkdtempSync("/tmp/pi-ic-ext-");
process.env.PI_CODING_AGENT_DIR = agentDir;

const { default: intercom } = await import("../index.ts");

interface Delivered {
	message: { content: string; details: InboundEntry };
	options: unknown;
}

type ToolResult = { content: Array<{ text: string }>; details: Record<string, unknown> };

function fakeSession(name: string, sessionId: string) {
	const handlers = new Map<string, Function>();
	const tools = new Map<string, { execute: Function }>();
	const delivered: Delivered[] = [];
	let idle = true;

	const ctx = {
		cwd: "/tmp/project",
		mode: "print",
		hasUI: false,
		model: { id: "test-model" },
		sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
		ui: { notify: () => {} },
		isIdle: () => idle,
		getContextUsage: () => undefined,
	};
	const pi = {
		on: (event: string, handler: Function) => handlers.set(event, handler),
		registerTool: (tool: { name: string; execute: Function }) => tools.set(tool.name, tool),
		registerCommand: () => {},
		registerShortcut: () => {},
		registerMessageRenderer: () => {},
		getSessionName: () => name,
		sendMessage: (message: Delivered["message"], options: unknown) => delivered.push({ message, options }),
	};
	intercom(pi as never);

	const emit = (event: string, payload: Record<string, unknown> = {}) => handlers.get(event)!(payload, ctx);
	const call = (params: Record<string, unknown>): Promise<ToolResult> => tools.get("intercom")!.execute("call", params, undefined, undefined, ctx);
	const setIdle = (value: boolean) => {
		idle = value;
	};
	return { emit, call, delivered, setIdle };
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (await check()) return;
		await sleep(20);
	}
	throw new Error("timed out");
}

const alpha = fakeSession("alpha", "aaaaaaaa-0000-4000-8000-000000000001");
const beta = fakeSession("beta", "bbbbbbbb-0000-4000-8000-000000000002");

beforeAll(async () => {
	alpha.emit("session_start");
	beta.emit("session_start");
	await waitFor(async () => {
		const list = await alpha.call({ action: "list" });
		return list.details.error !== true && list.content[0]!.text.includes("beta");
	});
});

afterAll(async () => {
	await alpha.emit("session_shutdown");
	await beta.emit("session_shutdown");
	const pid = Number(readFileSync(join(agentDir, "intercom", "broker.pid"), "utf8"));
	process.kill(pid, "SIGTERM");
	rmSync(agentDir, { recursive: true, force: true });
});

test("starts a turn in an idle receiver", async () => {
	const before = beta.delivered.length;
	const result = await alpha.call({ action: "send", to: "beta", message: "hello there" });
	expect(result.content[0]!.text).toBe("Message sent to beta");

	await waitFor(() => beta.delivered.length > before);
	const { message, options } = beta.delivered.at(-1)!;
	expect(options).toEqual({ triggerTurn: true });
	expect(message.content).toContain("**From alpha**");
	expect(message.content).toEndWith("hello there");
});

test("steers a message into a running turn", async () => {
	beta.setIdle(false);
	beta.emit("agent_start");
	const before = beta.delivered.length;
	await alpha.call({ action: "send", to: "beta", message: "while you work" });

	await waitFor(() => beta.delivered.length > before);
	expect(beta.delivered.at(-1)!.options).toEqual({ deliverAs: "steer" });

	beta.emit("agent_end");
	beta.setIdle(true);
});

test("holds a message while the receiver is busy outside a turn", async () => {
	beta.setIdle(false);
	const before = beta.delivered.length;
	await alpha.call({ action: "send", to: "beta", message: "held" });
	await sleep(200);
	expect(beta.delivered.length).toBe(before);

	beta.emit("agent_start");
	expect(beta.delivered.length).toBe(before + 1);
	expect(beta.delivered.at(-1)!.options).toEqual({ deliverAs: "steer" });

	beta.emit("agent_end");
	beta.setIdle(true);
});

test("returns the receiver's reply to an ask", async () => {
	const before = beta.delivered.length;
	const asked = alpha.call({ action: "ask", to: "beta", message: "ready?" });

	await waitFor(() => beta.delivered.length > before);
	expect(beta.delivered.at(-1)!.message.details.message.expectsReply).toBe(true);

	const reply = await beta.call({ action: "reply", message: "yes" });
	expect(reply.content[0]!.text).toBe("Reply sent to alpha");
	expect((await asked).content[0]!.text).toBe("**Reply from beta:**\nyes");
	expect((await beta.call({ action: "pending" })).content[0]!.text).toBe("No unresolved inbound asks.");
});

test("refuses to message itself", async () => {
	const result = await alpha.call({ action: "send", to: "alpha", message: "me" });
	expect(result.content[0]!.text).toBe("Cannot message the current session");
	expect(result.details.error).toBe(true);
});
