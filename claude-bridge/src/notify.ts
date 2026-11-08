import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

let ui: ExtensionUIContext | null = null;

export function setNotifier(next: ExtensionUIContext): void {
	ui = next;
}

export function notify(message: string, level: "info" | "warning" | "error"): void {
	ui?.notify(message, level);
}
