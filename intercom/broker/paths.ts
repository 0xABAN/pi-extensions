import { chmodSync, mkdirSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";

export const INTERCOM_DIR_MODE = 0o700;
export const INTERCOM_RUNTIME_FILE_MODE = 0o600;
export const INTERCOM_PROTOCOL_NAME = "pi-intercom";
export const INTERCOM_PROTOCOL_VERSION = 1;

export function getAgentDirPath(
	env: NodeJS.ProcessEnv = process.env,
	homeDir: string = homedir(),
	cwd: string = process.cwd(),
): string {
	const configured = env.PI_CODING_AGENT_DIR?.trim();
	if (!configured) {
		return join(homeDir, ".pi/agent");
	}

	return isAbsolute(configured) ? configured : resolve(cwd, configured);
}

export function getIntercomDirPath(agentDir: string = getAgentDirPath()): string {
	return join(agentDir, "intercom");
}

export function getBrokerSocketPath(agentDir: string = getAgentDirPath()): string {
	return join(getIntercomDirPath(agentDir), "broker.sock");
}

export function ensureIntercomRuntimeDir(intercomDir: string = getIntercomDirPath()): void {
	mkdirSync(intercomDir, { recursive: true, mode: INTERCOM_DIR_MODE });
	chmodSync(intercomDir, INTERCOM_DIR_MODE);
}

export function restrictIntercomRuntimeFile(filePath: string): void {
	chmodSync(filePath, INTERCOM_RUNTIME_FILE_MODE);
}
