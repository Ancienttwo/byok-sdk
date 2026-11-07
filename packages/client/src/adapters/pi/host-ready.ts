/** Local readiness receipt for memory-lane admission; never tool authority. */
export interface PiHostReadyEvent {
  readonly type: 'byok_host_ready';
  readonly sessionId: string;
}

export function parsePiHostReadyEvent(value: unknown): PiHostReadyEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid Pi host ready event');
  const raw = value as Record<string, unknown>;
  if (raw.type !== 'byok_host_ready' || Object.keys(raw).length !== 2 || typeof raw.sessionId !== 'string' || raw.sessionId.length === 0) {
    throw new TypeError('invalid Pi host ready event');
  }
  return Object.freeze({ type: 'byok_host_ready', sessionId: raw.sessionId });
}

