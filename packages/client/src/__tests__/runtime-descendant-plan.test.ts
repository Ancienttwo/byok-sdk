import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { descendantTemplateDigest, type ImplementationSpawnBindingV1, type RuntimeEntryV1 } from '@byok-sdk/implementation-identity';
import { createRuntimeDescendantPlan, parseRuntimeDescendantPlan, requiredRuntimePlanKinds, type RuntimeDescendantDeclarationV1, type RuntimeDescendantPlanV1 } from '../adapters/pi/runtime-descendant-plan';
const vectors = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/c07-runtime-record/canonical-revision.v1.json', import.meta.url), 'utf8')) as {
  templateVectors: { id: RuntimeEntryV1; template: ImplementationSpawnBindingV1; templateDigest: string; templateUtf8: string }[];
  resolutionVectors: { response: RuntimeDescendantDeclarationV1 }[];
};
const declaration = vectors.resolutionVectors[0]!.response;
const binding = (kind: RuntimeEntryV1) => vectors.templateVectors.find(v => v.id === kind)!.template;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function plan(kind: RuntimeEntryV1 = 'pi-rpc'): RuntimeDescendantPlanV1 {
  return { format: 'byok.runtime-launch-plan', version: 1, selfKind: kind,
    policy: clone(declaration.descendantPolicy), edges: clone(declaration.edges),
    templates: requiredRuntimePlanKinds(kind, declaration.descendantPolicy, declaration.edges).map(kind => {
      const vector = vectors.templateVectors.find(v => v.id === kind)!;
      return { kind, template: clone(vector.template), templateDigest: vector.templateDigest };
    }) };
}
const parse = (value: unknown) => parseRuntimeDescendantPlan(value, 'pi-rpc', binding('pi-rpc'), declaration);
describe('strict runtime descendant plan', () => {
  it('preserves all four frozen digest preimages', () => {
    for (const vector of vectors.templateVectors) {
      expect(JSON.stringify(vector.template)).toBe(vector.templateUtf8);
      expect(descendantTemplateDigest(vector.template)).toBe(vector.templateDigest);
    }
  });
  it.each(['pi-prepared', 'pi-rpc', 'pi-subagent-print', 'pi-subagent-runner'] as const)('accepts %s complete closure', kind => {
    const input = plan(kind);
    const output = parseRuntimeDescendantPlan(input, kind, binding(kind), declaration)!;
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
    expect(Object.isFrozen(output.templates[0]!.template.identity)).toBe(true);
    expect(createRuntimeDescendantPlan(kind, binding(kind), declaration, input.templates)).toEqual(output);
  });
  it('requires self only for prepared/maxDepth zero, and RPC needs runner plus print', () => {
    expect(plan('pi-prepared').templates.map(v => v.kind)).toEqual(['pi-prepared']);
    expect(plan().templates.map(v => v.kind)).toEqual(['pi-rpc', 'pi-subagent-print', 'pi-subagent-runner']);
    const zero = { ...declaration, descendantPolicy: { ...declaration.descendantPolicy, maxDepth: 0 } };
    expect(createRuntimeDescendantPlan('pi-rpc', binding('pi-rpc'), zero, [{ kind: 'pi-rpc', template: binding('pi-rpc') }])!.templates).toHaveLength(1);
  });
  it('rejects missing runner, duplicate and extra unreachable rows', () => {
    const input = plan();
    expect(() => parse({ ...input, templates: input.templates.slice(0, 2) })).toThrow();
    expect(() => parse({ ...input, templates: [input.templates[0], input.templates[1], input.templates[1]] })).toThrow();
    expect(() => parse({ ...input, templates: [...input.templates, plan('pi-prepared').templates[0]] })).toThrow();
  });
  it('compares self original bytes even when its reordered digest is valid', () => {
    const input = plan(), row = input.templates[0]!;
    const { format, ...rest } = row.template;
    const template = { ...rest, format };
    expect(() => parse({ ...input, templates: [{ ...row, template, templateDigest: descendantTemplateDigest(template) }, ...input.templates.slice(1)] })).toThrow('self_template_mismatch');
  });
  it('rejects policy mismatch against the independent Host declaration', () => {
    const input = plan();
    expect(() => parse({ ...input, policy: { ...input.policy, fanout: input.policy.fanout + 1 } })).toThrow('declaration_mismatch');
  });
  it.each(['manifestRevision', 'closureDigest', 'loaderEnvValuesDigest', 'nativeProvenance', 'envCommitments'])('rejects rehashed %s drift', field => {
    const input = clone(plan()) as any, row = input.templates[1];
    if (field === 'nativeProvenance') row.template.identity.nativeProvenance.forkBuild += 1;
    else if (field === 'envCommitments') row.template.envCommitments.PI_CODING_AGENT_SESSION_DIR += '/other';
    else row.template.identity[field] = 'e'.repeat(64);
    row.templateDigest = descendantTemplateDigest(row.template);
    expect(() => parse(input)).toThrow('template_identity_mismatch');
  });
  it.each([
    ['version', (p: any) => { p.version = 2; }],
    ['unknown top key', (p: any) => { p.perLaunch = {}; }],
    ['unknown row key', (p: any) => { p.templates[0].extra = true; }],
    ['unknown policy key', (p: any) => { p.policy.extra = true; }],
    ['missing policy field', (p: any) => { delete p.policy.sessionCap; }],
    ['invalid allowlist', (p: any) => { p.policy.envNameAllowlist = ['UNDECLARED']; }],
    ['negative zero', (p: any) => { p.policy.maxDepth = -0; }],
    ['unknown edge', (p: any) => { p.edges[0].child = 'pi-prepared'; }],
    ['unknown edge key', (p: any) => { p.edges[0].extra = true; }],
    ['bad digest', (p: any) => { p.templates[0].templateDigest = '0'.repeat(64); }],
    ['raw digest before projection', (p: any) => { const { format, ...rest } = p.templates[1].template; p.templates[1].template = { ...rest, format }; }],
    ['invalid fixed prefix', (p: any) => { const r = p.templates[1]; r.template.fixedArgv[0] = 'other'; r.template.identity.launchArgv[0] = 'other'; r.templateDigest = descendantTemplateDigest(r.template); }],
    ['unattested child', (p: any) => { p.templates[1].template.identity = { kind: 'unavailable', reason: 'resolver_unconfigured' }; p.templates[1].templateDigest = descendantTemplateDigest(p.templates[1].template); }],
  ])('rejects %s without external declaration', (_label, mutate) => {
    const input = clone(plan()); mutate(input);
    expect(() => parseRuntimeDescendantPlan(input, 'pi-rpc', binding('pi-rpc'))).toThrow();
  });
  it('requires plan for attested binding; only explicit unconfigured identity permits null', () => {
    expect(() => parse(null)).toThrow();
    expect(() => parse(undefined)).toThrow();
    expect(() => parseRuntimeDescendantPlan(plan(), 'pi-prepared', binding('pi-rpc'))).toThrow('self_kind_mismatch');
    expect(() => createRuntimeDescendantPlan('pi-rpc', binding('pi-rpc'))).toThrow('declaration_required');
    const unavailable: ImplementationSpawnBindingV1 = { ...binding('pi-rpc'), identity: { kind: 'unavailable', reason: 'resolver_unconfigured' } };
    expect(parseRuntimeDescendantPlan(null, 'pi-rpc', unavailable)).toBeNull();
    expect(createRuntimeDescendantPlan('pi-rpc', unavailable)).toBeNull();
    expect(() => parseRuntimeDescendantPlan(undefined, 'pi-rpc', unavailable)).toThrow();
    expect(() => parseRuntimeDescendantPlan(plan(), 'pi-rpc', unavailable)).toThrow();
    expect(() => parseRuntimeDescendantPlan(null, 'pi-rpc', { ...unavailable, identity: { kind: 'unavailable', reason: 'implementation_identity_unattested' } })).toThrow();
  });
});
