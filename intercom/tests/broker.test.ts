import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Message, SessionInfo, SessionRegistration } from "../types.ts";

const agentDir = mkdtempSync("/tmp/pi-ic-");
process.env.PI_CODING_AGENT_DIR = agentDir;

const { IntercomClient } = await import("../broker/client.ts");
const { spawnBrokerIfNeeded } = await import("../broker/spawn.ts");

type Client = InstanceType<typeof IntercomClient>;
const clients: Client[] = [];

function registration(name: string): SessionRegistration {
	const now = Date.now();
	return { name, cwd: "/tmp/project", model: "test", pid: process.pid, startedAt: now, lastActivity: now };
}

async function connect(name: string, sessionId?: string): Promise<Client> {
	const client = new IntercomClient();
	await client.connect(registration(name), sessionId);
	clients.push(client);
	return client;
}

function nextMessage(client: Client): Promise<{ from: SessionInfo; message: Message }> {
	return new Promise((resolve) => client.once("message", (from: SessionInfo, message: Message) => resolve({ from, message })));
}

beforeAll(async () => {
	await spawnBrokerIfNeeded(process.execPath, []);
});

afterAll(async () => {
	for (const client of clients) await client.disconnect();
	const pid = Number(readFileSync(join(agentDir, "intercom", "broker.pid"), "utf8"));
	process.kill(pid, "SIGTERM");
	rmSync(agentDir, { recursive: true, force: true });
});

test("lists sessions and delivers a message between them", async () => {
	const planner = await connect("planner");
	const worker = await connect("worker");

	const names = (await planner.listSessions()).map((session) => session.name).sort();
	expect(names).toEqual(["planner", "worker"]);

	const received = nextMessage(worker);
	const result = await planner.send("worker", { text: "start on the parser" });
	const { from, message } = await received;

	expect(result).toMatchObject({ delivered: true, delivery: "socket_delivered" });
	expect(from.name).toBe("planner");
	expect(message.content.text).toBe("start on the parser");
});

test("routes a reply back to the session that asked", async () => {
	const asker = await connect("asker");
	const answerer = await connect("answerer");

	const question = nextMessage(answerer);
	const sent = await asker.send("answerer", { text: "which branch?", expectsReply: true });
	const { message } = await question;
	expect(message.expectsReply).toBe(true);

	const reply = nextMessage(asker);
	await answerer.send(asker.sessionId!, { text: "main", replyTo: message.id });
	const answer = await reply;

	expect(answer.message.replyTo).toBe(sent.id);
	expect(answer.message.content.text).toBe("main");
});

test("keeps a message for a disconnected session until it reconnects", async () => {
	const sender = await connect("sender");
	const sleeper = await connect("sleeper");
	const sleeperId = sleeper.sessionId!;
	await sleeper.disconnect();

	const queued = await sender.send(sleeperId, { text: "while you were away" });
	expect(queued).toMatchObject({ delivered: true, delivery: "queued" });

	const woken = new IntercomClient();
	clients.push(woken);
	const received = nextMessage(woken);
	await woken.connect(registration("sleeper"), sleeperId);

	expect((await received).message.content.text).toBe("while you were away");
});
