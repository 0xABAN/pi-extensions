import { formatToolDuration } from "@earendil-works/pi-coding-agent";

export class ResponseTimer {
  private startedAt: number | undefined;
  private lastDuration: number | undefined;

  start(now: number): void {
    this.startedAt = now;
  }

  finish(now: number, completed: boolean): void {
    if (this.startedAt !== undefined && completed) {
      this.lastDuration = now - this.startedAt;
    }
    this.startedAt = undefined;
  }

  reset(): void {
    this.startedAt = undefined;
    this.lastDuration = undefined;
  }

  text(now: number): string | undefined {
    const duration = this.startedAt === undefined ? this.lastDuration : now - this.startedAt;
    return duration === undefined ? undefined : formatToolDuration(duration);
  }
}
