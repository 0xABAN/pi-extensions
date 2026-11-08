import { spawn } from "node:child_process";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

export class QueryProcess {
	private started = false;
	private child: SpawnedProcess | undefined;
	private closed = false;
	private resolveExit!: () => void;
	private readonly stderr: ((data: string) => void) | undefined;
	readonly exited = new Promise<void>((resolve) => { this.resolveExit = resolve; });

	constructor(stderr?: (data: string) => void) {
		this.stderr = stderr;
	}

	spawn = (options: SpawnOptions): SpawnedProcess => {
		if (this.closed || this.started) throw new Error("Query process spawned after close or more than once");
		const child = spawn(options.command, options.args, {
			cwd: options.cwd, env: options.env, signal: options.signal,
			stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
		});
		this.started = true;
		this.child = child;
		child.stderr.on("data", (data: Buffer) => this.stderr?.(data.toString()));
		child.once("close", () => this.resolveExit());
		return child;
	};
	terminate(): void {
		this.close();
		if (this.child && !this.child.killed) this.child.kill("SIGTERM");
	}
	close(): void {
		this.closed = true;
		if (!this.started) this.resolveExit();
	}
}
