import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IntercomClient, IntercomSessionHeldError } from "./broker/client.ts";
import { spawnBrokerIfNeeded } from "./broker/spawn.ts";
import { unnamedSessionName } from "./format.ts";
import type { SessionRegistration } from "./types.ts";

const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

export class Connection {
	client: IntercomClient | null = null;
	context: ExtensionContext | null = null;

	private readonly pi: ExtensionAPI;
	private readonly attach: (client: IntercomClient) => void;
	private sessionId = "";
	private model = "unknown";
	private startedAt = 0;
	private running = false;
	private readonly activeTools = new Map<string, string>();
	private connecting: Promise<IntercomClient> | null = null;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private reconnectAttempt = 0;
	private held = false;

	constructor(pi: ExtensionAPI, attach: (client: IntercomClient) => void) {
		this.pi = pi;
		this.attach = attach;
	}

	get agentRunning(): boolean {
		return this.running;
	}

	start(context: ExtensionContext): void {
		this.context = context;
		this.sessionId = context.sessionManager.getSessionId();
		this.model = context.model?.id ?? "unknown";
		this.startedAt = Date.now();
		this.connect().catch(() => this.scheduleReconnect());
	}

	async stop(): Promise<void> {
		this.context = null;
		this.clearReconnectTimer();
		const client = this.client;
		this.client = null;
		await client?.disconnect();
	}

	async connect(): Promise<IntercomClient> {
		if (!this.context) {
			throw new Error("Intercom is not running");
		}
		if (this.client?.isConnected()) {
			return this.client;
		}

		this.connecting ??= this.open().finally(() => {
			this.connecting = null;
		});
		return this.connecting;
	}

	disconnected(client: IntercomClient): void {
		if (this.client !== client) {
			return;
		}
		this.client = null;
		this.scheduleReconnect();
	}

	name(): string {
		return this.identity().name;
	}

	notify(message: string, level: "info" | "warning" | "error"): void {
		if (this.context?.hasUI) {
			this.context.ui.notify(message, level);
		}
	}

	setModel(model: string): void {
		this.model = model;
		this.syncPresence();
	}

	agentStarted(): void {
		this.running = true;
		this.activeTools.clear();
		this.syncPresence();
	}

	agentEnded(): void {
		this.running = false;
		this.activeTools.clear();
		this.syncPresence();
	}

	toolStarted(toolCallId: string, toolName: string): void {
		this.activeTools.set(toolCallId, toolName);
		this.syncPresence();
	}

	toolEnded(toolCallId: string): void {
		this.activeTools.delete(toolCallId);
		this.syncPresence();
	}

	syncPresence(): void {
		if (!this.context) {
			return;
		}

		this.client?.updatePresence({
			...this.identity(),
			model: this.model,
			status: this.status(),
			...this.contextUsage(this.context),
		});
	}

	private async open(): Promise<IntercomClient> {
		this.clearReconnectTimer();
		const client = new IntercomClient();
		this.client = client;
		this.attach(client);

		try {
			await spawnBrokerIfNeeded();
			await client.connect(this.registration(), this.sessionId);
		} catch (error) {
			if (this.client === client) {
				this.client = null;
			}
			if (error instanceof IntercomSessionHeldError) {
				this.reportHeld(error);
			}
			throw error;
		}

		if (!this.context) {
			await client.disconnect();
			throw new Error("Intercom stopped while connecting");
		}

		this.reconnectAttempt = 0;
		this.held = false;
		return client;
	}

	private registration(): SessionRegistration {
		if (!this.context) {
			throw new Error("Intercom stopped while connecting");
		}

		const tmuxPane = process.env.TMUX_PANE?.trim();
		const herdrPaneId = process.env.HERDR_PANE_ID?.trim();
		const herdrSessionPath = herdrPaneId ? this.context.sessionManager.getSessionFile() : undefined;
		return {
			...this.identity(),
			cwd: this.context.cwd,
			model: this.model,
			pid: process.pid,
			startedAt: this.startedAt,
			lastActivity: Date.now(),
			status: this.status(),
			...(tmuxPane ? { tmuxPane } : {}),
			...(herdrPaneId ? { herdrPaneId } : {}),
			...(herdrSessionPath ? { herdrSessionPath } : {}),
			acknowledgesReceipts: true,
		};
	}

	private identity(): { name: string; runtimeFallbackAlias: boolean } {
		const sessionName = this.pi.getSessionName()?.trim();
		return { name: sessionName || unnamedSessionName(this.sessionId), runtimeFallbackAlias: !sessionName };
	}

	private status(): string {
		const activeTool = this.activeTools.values().next().value;
		if (activeTool) return `tool:${activeTool}`;
		return this.running ? "thinking" : "idle";
	}

	private contextUsage(context: ExtensionContext): {
		contextPct?: number | null;
		contextTokens?: number | null;
		contextWindow?: number;
	} {
		const usage = context.getContextUsage();
		if (!usage) {
			return {};
		}

		return {
			contextPct: usage.percent === null ? null : Math.round(usage.percent),
			contextTokens: usage.tokens,
			...(usage.contextWindow > 0 ? { contextWindow: usage.contextWindow } : {}),
		};
	}

	private scheduleReconnect(): void {
		if (!this.context || this.held || this.reconnectTimer || this.connecting) {
			return;
		}

		const delay = RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.reconnectAttempt += 1;
			this.connect().catch(() => this.scheduleReconnect());
		}, delay);
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
		}
		this.reconnectTimer = null;
	}

	private reportHeld(error: IntercomSessionHeldError): void {
		if (this.held) {
			return;
		}

		this.held = true;
		this.notify(
			`Intercom is offline: session id ${this.sessionId} is held by process ${error.holder.pid} in ${error.holder.cwd}. Close that session and run /reload.`,
			"warning",
		);
	}
}
