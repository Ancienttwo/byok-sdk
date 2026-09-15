/** Telemetry-only Pi extension for the bounded agent-gateway probe. */
import { appendFileSync } from 'node:fs';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function telemetryPath(): string | undefined {
  const value = process.env.BYOK_GATEWAY_OBSERVER;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function sessionSnapshot(context: unknown, requireModel: boolean): UnknownRecord | undefined {
  const sessionManager = record(record(context)?.sessionManager);
  const getSessionId = sessionManager?.getSessionId;
  if (typeof getSessionId !== 'function') return undefined;
  const sessionId = getSessionId.call(sessionManager);
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
  const snapshot: UnknownRecord = { sessionId };
  if (!requireModel) return snapshot;
  const model = record(record(context)?.model);
  const provider = model?.provider;
  const id = model?.id;
  if (typeof provider !== 'string' || provider.length === 0 || typeof id !== 'string' || id.length === 0) return undefined;
  snapshot.modelProvider = provider;
  snapshot.modelId = id;
  if (typeof model?.baseUrl === 'string') snapshot.baseUrl = model.baseUrl;
  return snapshot;
}

function emit(event: 'agent_settled' | 'session_start' | 'session_shutdown', context: unknown, requireModel = false): void {
  const output = telemetryPath();
  const snapshot = sessionSnapshot(context, requireModel);
  if (output === undefined || snapshot === undefined) return;
  try {
    appendFileSync(output, `${JSON.stringify({ ts: new Date().toISOString(), event, ...snapshot })}\n`, { mode: 0o600 });
  } catch {
    // Telemetry cannot change Pi session, prompt, identity, or tool behavior.
  }
}

export default function piObserver(pi: { on(event: string, handler: (event: unknown, context: unknown) => void): void }): void {
  pi.on('session_start', (_event, context) => emit('session_start', context, true));
  pi.on('agent_settled', (_event, context) => emit('agent_settled', context));
  pi.on('session_shutdown', (_event, context) => emit('session_shutdown', context));
}
