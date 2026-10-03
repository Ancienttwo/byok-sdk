import { CloudDoError } from './errors';
import type { SessionIdentity } from './identity';
import type { CloudDispatchContext } from './tools';

export interface CloudLimits {
  readonly modelSteps: number;
  readonly toolCalls: number;
  readonly inlineFetches: number;
  readonly callTimeoutMs: number;
  readonly turnTimeoutMs: number;
  readonly resultBytes: number;
}

export const CLOUD_LIMITS: Readonly<CloudLimits> = Object.freeze({
  modelSteps: 8, toolCalls: 12, inlineFetches: 4,
  callTimeoutMs: 60_000, turnTimeoutMs: 240_000, resultBytes: 48_000,
});

export interface CloudSessionConfig extends CloudDispatchContext {
  readonly limits: CloudLimits;
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new CloudDoError('CLOUD_REQUEST_INVALID');
  }
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !keys.includes(key) || !field || !('value' in field) || !field.enumerable) {
      throw new CloudDoError('CLOUD_REQUEST_INVALID');
    }
    result[key] = field.value;
  }
  return result;
}

function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\p{Cc}/u.test(value)) {
    throw new CloudDoError('CLOUD_REQUEST_INVALID');
  }
  return value;
}

/** The consuming platform authorizes this data. It supplies the dispatcher in code. */
export function admitSessionConfig(input: unknown): CloudSessionConfig {
  const body = record(input, ['identity', 'principal', 'scopes', 'dispatcherId', 'limits']);
  const ids = record(body.identity, ['tenantId', 'workspaceId', 'agentId', 'sessionId']);
  const identity: SessionIdentity = {
    tenantId: text(ids.tenantId), workspaceId: text(ids.workspaceId),
    agentId: text(ids.agentId), sessionId: text(ids.sessionId),
  };
  const rawPrincipal = record(body.principal, ['accountId', 'workspaceId', 'channel']);
  const principal = { accountId: text(rawPrincipal.accountId), workspaceId: text(rawPrincipal.workspaceId), channel: text(rawPrincipal.channel) };
  if (principal.workspaceId !== identity.workspaceId || !['web', 'api', 'mcp'].includes(principal.channel)) {
    throw new CloudDoError('CLOUD_REQUEST_INVALID');
  }
  if (!Array.isArray(body.scopes) || body.scopes.length > 64 || Reflect.ownKeys(body.scopes).length !== body.scopes.length + 1) {
    throw new CloudDoError('CLOUD_REQUEST_INVALID');
  }
  const scopes: string[] = [];
  for (let i = 0; i < body.scopes.length; i++) {
    const field = Object.getOwnPropertyDescriptor(body.scopes, String(i));
    if (!field || !('value' in field) || !field.enumerable) throw new CloudDoError('CLOUD_REQUEST_INVALID');
    scopes.push(text(field.value, 128));
  }
  if (new Set(scopes).size !== scopes.length) throw new CloudDoError('CLOUD_REQUEST_INVALID');
  const limits = { ...CLOUD_LIMITS };
  if (Object.hasOwn(body, 'limits')) {
    const overrides = record(body.limits, Object.keys(CLOUD_LIMITS));
    for (const key of Object.keys(overrides) as (keyof CloudLimits)[]) {
      const value = overrides[key];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > CLOUD_LIMITS[key]) {
        throw new CloudDoError('CLOUD_REQUEST_INVALID');
      }
      limits[key] = value;
    }
  }
  return { identity, principal, scopes, dispatcherId: text(body.dispatcherId), limits };
}
