import { describe, expect, it } from 'vitest';
import { admitSessionConfig, CLOUD_LIMITS, type CloudLimits } from '../src/session-config';

function input() {
  return { identity: { tenantId: 'tenant', workspaceId: 'workspace', agentId: 'agent', sessionId: 'session' },
    principal: { accountId: 'account', workspaceId: 'workspace', channel: 'mcp' }, scopes: ['read:data'], dispatcherId: 'financial' };
}
describe('strict cloud session configuration', () => {
  it('uses the six approved maxima and keeps their authority frozen', () => {
    expect(CLOUD_LIMITS).toEqual({ modelSteps: 8, toolCalls: 12, inlineFetches: 4, callTimeoutMs: 60_000,
      turnTimeoutMs: 240_000, resultBytes: 48_000 });
    expect(Object.isFrozen(CLOUD_LIMITS)).toBe(true);
    expect(admitSessionConfig(input())).toEqual({ ...input(), limits: CLOUD_LIMITS });
  });
  it('keeps distinct tenant/account ids and accepts only matching workspace ids', () => {
    expect(admitSessionConfig(input()).principal.accountId).toBe('account');
    const invalid = input(); invalid.principal.workspaceId = 'other';
    expect(() => admitSessionConfig(invalid)).toThrow('CLOUD_REQUEST_INVALID');
  });
  for (const channel of ['web', 'api', 'mcp']) it(`accepts the ${channel} channel`, () => {
    const value = input(); value.principal.channel = channel;
    expect(admitSessionConfig(value).principal.channel).toBe(channel);
  });
  for (const channel of ['unknown', '', 'MCP', 'cli', 'stdio']) it(`rejects the ${channel} channel`, () => {
    const value = input(); value.principal.channel = channel;
    expect(() => admitSessionConfig(value)).toThrow('CLOUD_REQUEST_INVALID');
  });
  it('allows partial integer limit overrides that only lower maxima', () => {
    expect(admitSessionConfig({ ...input(), limits: { modelSteps: 1, resultBytes: 1024 } }).limits)
      .toEqual({ ...CLOUD_LIMITS, modelSteps: 1, resultBytes: 1024 });
    expect(admitSessionConfig({ ...input(), limits: {} }).limits).toEqual(CLOUD_LIMITS);
  });
  for (const key of Object.keys(CLOUD_LIMITS) as (keyof CloudLimits)[]) {
    it(`rejects invalid or increased ${key}`, () => {
      for (const value of [CLOUD_LIMITS[key] + 1, 0, -1, 0.5, NaN, Infinity, '1', undefined]) {
        expect(() => admitSessionConfig({ ...input(), limits: { [key]: value } })).toThrow('CLOUD_REQUEST_INVALID');
      }
      expect(admitSessionConfig({ ...input(), limits: { [key]: CLOUD_LIMITS[key] } }).limits[key]).toBe(CLOUD_LIMITS[key]);
    });
  }
  it('rejects unknown keys at every configuration boundary', () => {
    const value = input();
    for (const candidate of [
      { ...value, env: {} }, { ...value, execute: () => {} },
      { ...value, identity: { ...value.identity, extra: 'value' } },
      { ...value, principal: { ...value.principal, tenantId: 'tenant' } },
      { ...value, limits: { modelRequests: 2 } },
    ]) expect(() => admitSessionConfig(candidate)).toThrow('CLOUD_REQUEST_INVALID');
  });
  it('requires every identity field and bounds their control-free text', () => {
    for (const key of ['tenantId', 'workspaceId', 'agentId', 'sessionId']) {
      for (const value of ['', ' ', 'x\n', 'x\u007f', 'x\u0085', 'x'.repeat(257), 1, undefined]) {
        expect(() => admitSessionConfig({ ...input(), identity: { ...input().identity, [key]: value } })).toThrow('CLOUD_REQUEST_INVALID');
      }
    }
    expect(admitSessionConfig({ ...input(), identity: { ...input().identity, sessionId: 'x'.repeat(256) } }).identity.sessionId).toHaveLength(256);
  });
  it('bounds principal, scopes and dispatcher data', () => {
    const value = input();
    for (const candidate of [
      { ...value, principal: { ...value.principal, accountId: '' } },
      { ...value, principal: { ...value.principal, accountId: 'x'.repeat(257) } },
      { ...value, dispatcherId: '' }, { ...value, dispatcherId: 'x\r' }, { ...value, dispatcherId: 'x'.repeat(257) },
      { ...value, scopes: ['read', 'read'] }, { ...value, scopes: [''] }, { ...value, scopes: ['x\t'] },
      { ...value, scopes: ['x'.repeat(129)] }, { ...value, scopes: [() => {}] },
      { ...value, scopes: Array.from({ length: 65 }, (_, i) => `scope${i}`) },
    ]) expect(() => admitSessionConfig(candidate)).toThrow('CLOUD_REQUEST_INVALID');
    expect(admitSessionConfig({ ...value, scopes: [] }).scopes).toEqual([]);
    expect(admitSessionConfig({ ...value, scopes: Array.from({ length: 64 }, (_, i) => `scope${i}`) }).scopes).toHaveLength(64);
  });
  it('requires plain complete data and rejects hidden fields/accessors without executing them', () => {
    let calls = 0;
    const accessor = Object.defineProperty(input(), 'dispatcherId', { enumerable: true, get() { calls++; return 'financial'; } });
    const hidden = Object.defineProperty(input(), 'hidden', { value: 'ignored by JSON' });
    for (const candidate of [null, [], 'text', {}, { ...input(), identity: null }, { ...input(), principal: null },
      { ...input(), scopes: undefined }, { ...input(), scopes: new Array(1) }, { ...input(), limits: undefined },
      { ...input(), limits: null }, accessor, hidden]) expect(() => admitSessionConfig(candidate)).toThrow('CLOUD_REQUEST_INVALID');
    expect(calls).toBe(0);
  });
  it('returns data that serializes and remains independent of the caller input', () => {
    const value = input(); const config = admitSessionConfig(value);
    value.identity.sessionId = 'changed'; value.principal.accountId = 'changed'; value.scopes.push('changed');
    expect(config.identity.sessionId).toBe('session'); expect(config.principal.accountId).toBe('account');
    expect(config.scopes).toEqual(['read:data']); expect(JSON.parse(JSON.stringify(config))).toEqual(config);
  });
});
