import { describe, expect, it } from 'vitest';
import { admitCloudTools, argsDigest, canonicalArgs, CLOUD_LIVE_IPO_TOOLS, CLOUD_SAFE_REPLAY_TOOLS,
  invocationId, replayForTool, type CloudToolDefinition } from '../src/tools';

const definition = (name = 'resolve_security'): CloudToolDefinition => ({
  name, description: 'Read security data.', execution: 'read_only_live', resolverRpc: 'resolve',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
});

describe('cloud tool admission and frozen replay policy', () => {
  it('locks all 15 replay names and all 7 live IPO names separately', () => {
    expect(CLOUD_SAFE_REPLAY_TOOLS).toEqual([
      'load_financial_analysis_skill', 'resolve_security', 'guarded_screen', 'search_f10_datasets',
      'query_f10_dataset', 'get_security_profile', 'get_quote_snapshot', 'get_corporate_actions',
      'get_financial_statements', 'get_financial_facts', 'get_financial_ratios', 'get_sdi_disclosures',
      'get_directorate', 'get_ownership', 'get_related_warrants',
    ]);
    expect(CLOUD_LIVE_IPO_TOOLS).toEqual(['get_ipo_profile', 'search_ipo_calendar', 'get_ipo_timetable',
      'get_ipo_offering', 'get_ipo_allotment', 'screen_ipos', 'compare_ipos']);
    expect(Object.isFrozen(CLOUD_SAFE_REPLAY_TOOLS)).toBe(true);
    expect(Object.isFrozen(CLOUD_LIVE_IPO_TOOLS)).toBe(true);
    for (const name of CLOUD_SAFE_REPLAY_TOOLS) expect(replayForTool(name)).toBe('safe');
    for (const name of CLOUD_LIVE_IPO_TOOLS) expect(replayForTool(name)).toBe('unsafe');
    expect(replayForTool('unknown')).toBe('unsafe');
  });
  it('admits the skill loader without a live resolver and all 21 live tools with one', () => {
    const skill = { ...definition('load_financial_analysis_skill'), execution: 'skill' as const, resolverRpc: undefined };
    const tools = [skill, ...[...CLOUD_SAFE_REPLAY_TOOLS.slice(1), ...CLOUD_LIVE_IPO_TOOLS].map(name => definition(name))];
    expect(admitCloudTools(tools)).toEqual(tools);
    expect(Object.isFrozen(admitCloudTools(tools))).toBe(true);
  });
  for (const name of ['bash', 'read', 'write', 'edit', 'keychain', 'stdio_mcp', 'cli', 'get_ipo_offer_statistics',
    'get_ipo_lockup', 'get_ipo_lineage', 'unknown', '__proto__']) {
    it(`rejects ${name} even with a live resolver`, () => {
      expect(() => admitCloudTools([definition(name)])).toThrow('CLOUD_TOOL_NOT_AVAILABLE');
    });
  }
  for (const patch of [
    { execution: 'scaffold' as const }, { execution: 'skill' as const }, { resolverRpc: undefined },
    { resolverRpc: '' }, { resolverRpc: ' ' }, { mode: 'job' as const }, { requiredCapabilities: ['local_file'] },
    { requiredCapabilities: ['remote_mcp'] }, { parameters: { type: 'object', properties: {} } },
    { parameters: { type: 'object', properties: {}, additionalProperties: true } },
    { parameters: { type: 'array', items: { type: 'string' }, additionalProperties: false } },
  ]) {
    it(`rejects unavailable execution or an open schema: ${JSON.stringify(patch)}`, () => {
      expect(() => admitCloudTools([{ ...definition(), ...patch }])).toThrow('CLOUD_TOOL_NOT_AVAILABLE');
    });
  }
  it('rejects a duplicate registration', () => {
    expect(() => admitCloudTools([definition(), definition()])).toThrow('CLOUD_TOOL_NOT_AVAILABLE');
  });
  it('rejects a live resolver masquerading as the skill loader', () => {
    expect(() => admitCloudTools([definition('load_financial_analysis_skill')])).toThrow('CLOUD_TOOL_NOT_AVAILABLE');
  });
  it('rejects arguments registered for the no-argument skill loader', () => {
    expect(() => admitCloudTools([{ ...definition('load_financial_analysis_skill'), execution: 'skill',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false } }])).toThrow('CLOUD_TOOL_NOT_AVAILABLE');
  });
});

describe('cloud invocation identity', () => {
  it('includes conversation and assistant entry, even when a call id repeats', async () => {
    const first = await invocationId(1, 2, 'call_0');
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(await invocationId(1, 2, 'call_0')).toBe(first);
    expect(await invocationId(1, 3, 'call_0')).not.toBe(first);
    expect(await invocationId(2, 2, 'call_0')).not.toBe(first);
    expect(await invocationId(1, 2, 'call_1')).not.toBe(first);
  });
  it('canonicalizes nested keys but preserves arrays and tool identity', async () => {
    const a = { z: [{ b: 2, a: 1 }], a: 'é' };
    const b = { a: 'é', z: [{ a: 1, b: 2 }] };
    expect(canonicalArgs(a)).toBe('{"a":"é","z":[{"a":1,"b":2}]}');
    expect(await argsDigest('resolve_security', a)).toBe(await argsDigest('resolve_security', b));
    expect(await argsDigest('resolve_security', a)).not.toBe(await argsDigest('get_quote_snapshot', a));
    expect(await argsDigest('resolve_security', { a: [1, 2] })).not.toBe(await argsDigest('resolve_security', { a: [2, 1] }));
  });
  it('does not drop invalid JSON values or collapse them into a valid digest', () => {
    const circular: Record<string, unknown> = {}; circular.self = circular;
    for (const args of [{ a: undefined }, { a: NaN }, { a: Infinity }, { a: 1n }, { a: () => {} }, { a: new Date() },
      { a: new Array(1) }, circular]) expect(() => canonicalArgs(args)).toThrow('CLOUD_REQUEST_INVALID');
  });
  it('preserves __proto__ as a JSON key', () => {
    expect(canonicalArgs(JSON.parse('{"__proto__":{"a":1},"b":2}'))).toBe('{"__proto__":{"a":1},"b":2}');
  });
});
