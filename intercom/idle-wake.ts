type WakeReservation = { sessionId: string; sentAt?: number };
type SessionRef = { getSessionId(): string };

const WAKE_PENDING_MS = 10_000;
const reservationsKey = Symbol.for("pi.idle-wake.v1");
const wakeGlobal = globalThis as typeof globalThis & { [reservationsKey]?: WeakMap<object, WakeReservation> };
const reservations = wakeGlobal[reservationsKey] ?? (wakeGlobal[reservationsKey] = new WeakMap<object, WakeReservation>());

function reservationFor(sessionManager: SessionRef): WakeReservation {
  const sessionId = sessionManager.getSessionId();
  const current = reservations.get(sessionManager);
  if (current?.sessionId === sessionId) return current;
  const next = { sessionId };
  reservations.set(sessionManager, next);
  return next;
}

export function isIdleWakePending(sessionManager: SessionRef): boolean {
  const { sentAt } = reservationFor(sessionManager);
  return sentAt !== undefined && Date.now() - sentAt < WAKE_PENDING_MS;
}

export function reserveIdleWake(sessionManager: SessionRef): void {
  reservationFor(sessionManager).sentAt = Date.now();
}

export function releaseIdleWake(sessionManager: SessionRef): void {
  reservationFor(sessionManager).sentAt = undefined;
}
