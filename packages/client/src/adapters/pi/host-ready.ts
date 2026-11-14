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


/**
 * Local, non-fatal diagnostic on the Pi RPC stdout channel, written by the Pi
 * host at most once per process:
 * `{"type":"byok_host_diagnostic","code":"pi_jiti_seed_unavailable","message":"<reason>"}`.
 * The reason names files and versions only. The adapter warns once per Host
 * process and the task continues; it is not an AgentEvent (#1927).
 */
export interface PiHostDiagnostic {
  readonly type: 'byok_host_diagnostic';
  readonly code: 'pi_jiti_seed_unavailable';
  readonly message: string;
}

export function createPiHostDiagnostic(message: string): PiHostDiagnostic {
  return Object.freeze({ type: 'byok_host_diagnostic', code: 'pi_jiti_seed_unavailable', message });
}

export function parsePiHostDiagnostic(value: unknown): PiHostDiagnostic {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid Pi host diagnostic');
  const raw = value as Record<string, unknown>;
  if (raw.type !== 'byok_host_diagnostic' || Object.keys(raw).length !== 3 || raw.code !== 'pi_jiti_seed_unavailable'
    || typeof raw.message !== 'string' || raw.message.length === 0 || /[\r\n]/u.test(raw.message)) {
    throw new TypeError('invalid Pi host diagnostic');
  }
  return createPiHostDiagnostic(raw.message);
}

const warnedDiagnostics = new Set<string>();
/** One warning per diagnostic code per Host process, as runtime-versions-store warns. */
export function warnPiHostDiagnostic(frame: unknown): void {
  let message: string;
  try {
    const diagnostic = parsePiHostDiagnostic(frame);
    message = `${diagnostic.code}: ${diagnostic.message}`;
  } catch {
    message = 'invalid Pi host diagnostic frame';
  }
  const code = message.split(':')[0]!;
  if (warnedDiagnostics.has(code)) return;
  warnedDiagnostics.add(code);
  console.warn(`[byok/client] ${message}`);
}
