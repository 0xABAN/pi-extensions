import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "child_process";
import { createMessageReader, writeMessage } from "./framing.ts";
import {
	ensureIntercomRuntimeDir,
	getAgentDirPath,
	getBrokerSocketPath,
	getIntercomDirPath,
	INTERCOM_PROTOCOL_NAME,
	INTERCOM_PROTOCOL_VERSION,
	INTERCOM_RUNTIME_FILE_MODE,
	restrictIntercomRuntimeFile,
} from "./paths.ts";

const BROKER_PATH = join(dirname(fileURLToPath(import.meta.url)), "broker.ts");
const BROKER_STARTUP_TIMEOUT_MS = 5000;
const BROKER_STDERR_LIMIT = 4000;
const HEALTH_CHECK_TIMEOUT_MS = 1000;
const SPAWN_LOCK_STALE_MS = 10_000;

export async function spawnBrokerIfNeeded(): Promise<void> {
	const intercomDir = getIntercomDirPath();
	ensureIntercomRuntimeDir(intercomDir);
	if (await isBrokerHealthy()) {
		return;
	}

	const lockPath = join(intercomDir, "broker.spawn.lock");
	if (!acquireSpawnLock(lockPath)) {
		await waitForBroker();
		return;
	}

	try {
		if (!(await isBrokerHealthy())) {
			await startBroker(intercomDir);
		}
	} finally {
		rmSync(lockPath, { force: true });
	}
}

async function startBroker(intercomDir: string): Promise<void> {
	const logPath = join(intercomDir, "broker.log");
	const log = openSync(logPath, "w", INTERCOM_RUNTIME_FILE_MODE);
	restrictIntercomRuntimeFile(logPath);

	const child = spawn(process.execPath, [BROKER_PATH], {
		detached: true,
		stdio: ["ignore", "ignore", log],
		cwd: intercomDir,
		env: { ...process.env, PI_CODING_AGENT_DIR: getAgentDirPath(), NODE_NO_WARNINGS: "1" },
	});
	closeSync(log);
	child.unref();

	const exited = new Promise<never>((_, reject) => {
		child.once("error", (error) =>
			reject(new Error(`Failed to spawn intercom broker: ${error.message}`, { cause: error })),
		);
		child.once("exit", (code, signal) =>
			reject(
				new Error(`Intercom broker exited before startup with ${signal ? `signal ${signal}` : `code ${code}`}`),
			),
		);
	});

	try {
		await Promise.race([waitForBroker(), exited]);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const stderr = readFileSync(logPath, "utf8").trim().slice(-BROKER_STDERR_LIMIT);
		throw new Error(stderr ? `${message}\nBroker stderr:\n${stderr}` : message, { cause: error });
	} finally {
		child.removeAllListeners();
	}
}

async function waitForBroker(): Promise<void> {
	const deadline = Date.now() + BROKER_STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await isBrokerHealthy()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("Broker failed to start within timeout");
}

function isBrokerHealthy(): Promise<boolean> {
	const socketPath = getBrokerSocketPath();
	if (!existsSync(socketPath)) {
		return Promise.resolve(false);
	}

	return new Promise((resolve) => {
		const socket = net.connect(socketPath);
		const requestId = randomUUID();
		const finish = (healthy: boolean) => {
			clearTimeout(timeout);
			socket.removeAllListeners();
			socket.destroy();
			resolve(healthy);
		};
		const timeout = setTimeout(() => finish(false), HEALTH_CHECK_TIMEOUT_MS);

		socket.on("connect", () => writeMessage(socket, { type: "health", requestId }));
		socket.on("error", () => finish(false));
		socket.on(
			"data",
			createMessageReader(
				(message) => {
					const response = message as Record<string, unknown>;
					finish(
						response.type === "health_ok" &&
							response.requestId === requestId &&
							response.protocol === INTERCOM_PROTOCOL_NAME &&
							response.version === INTERCOM_PROTOCOL_VERSION,
					);
				},
				() => finish(false),
			),
		);
	});
}

function acquireSpawnLock(lockPath: string): boolean {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, { flag: "wx", mode: INTERCOM_RUNTIME_FILE_MODE });
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw error;
			}
			if (!isSpawnLockStale(lockPath)) {
				return false;
			}
			rmSync(lockPath, { force: true });
		}
	}
	return false;
}

function isSpawnLockStale(lockPath: string): boolean {
	let lock: string;
	try {
		lock = readFileSync(lockPath, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return true;
		}
		throw error;
	}

	const [pidLine = "", createdAtLine = "0"] = lock.trim().split("\n");
	const pid = Number.parseInt(pidLine, 10);
	const createdAt = Number.parseInt(createdAtLine, 10);
	if (!Number.isFinite(createdAt) || Date.now() - createdAt > SPAWN_LOCK_STALE_MS) {
		return true;
	}

	try {
		process.kill(pid, 0);
		return false;
	} catch {
		return true;
	}
}
