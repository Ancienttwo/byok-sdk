import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DESCENDANT_PER_LAUNCH_ENV_NAMES, RUNTIME_DESCENDANT_EDGES,
  parseRuntimeImplementationRecord, resolveRuntimeImplementation, resolveToolImplementationIdentity,
  type ToolImplementationFsProbe, type ToolImplementationInstallRecordV1,
  type RuntimeImplementationLocatorV1, type McpImplementationLocatorV1,
} from '../identity';

const fixtureRoot = path.resolve(import.meta.dirname, '../../../../tests/fixtures/c07-runtime-record');
const positive = JSON.parse(readFileSync(path.join(fixtureRoot, 'canonical-revision.v1.json'), 'utf8'));
const negative = JSON.parse(readFileSync(path.join(fixtureRoot, 'rejections.v1.json'), 'utf8'));
const env = { PATH: '/usr/bin', HOME: '/home/fixture' };
// Mock physical measurements only: these tests verify selection and immutable
// projection, not an actual root-owned installation (client tests cover bytes).
function probeFor(record: ToolImplementationInstallRecordV1) {
  const hashes = new Map([[record.installPath, record.closureDigest]]);
  if (record.interpreter) hashes.set(record.interpreter.path, record.interpreter.digest);
  for (const asset of record.assets ?? []) hashes.set(path.join(record.assetRoot!, asset.path), asset.digest);
  const probe = {
    realpath: vi.fn(async (target: string) => target),
    lstat: vi.fn(async () => ({ uid: 0, gid: 0, mode: 0o100555, size: 11, dev: 1, ino: 2, mtimeMs: 1000.5,
      isFile: true, isSymbolicLink: false })),
    digest: vi.fn(async (target: string) => { const value = hashes.get(target); if (!value) throw new Error(`unmapped ${target}`); return value; }),
  } satisfies ToolImplementationFsProbe;
  return probe;
}

describe('M0 runtime-only wrapper cutover', () => {
  it.each(positive.resolutionVectors as { id: string; response: any; request: RuntimeImplementationLocatorV1 }[])('measures $id and retains independent immutable Host policy', async vector => {
    const response = structuredClone(vector.response);
    const probe = probeFor(response.record);
    const resolve = vi.fn(async () => response);
    const result = await resolveRuntimeImplementation({ resolve }, vector.request, env, probe);
    expect(result.kind).toBe('attested');
    if (result.kind !== 'attested') throw new Error(result.reason);
    expect(result.identity.launchArgv).toEqual(vector.response.record.launchArgv);
    expect(result.descendantPolicy).toEqual(vector.response.descendantPolicy);
    expect(result.edges).toEqual(vector.response.edges);
    expect(result.identity).not.toHaveProperty('descendantPolicy');
    expect(result.identity).not.toHaveProperty('edges');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.descendantPolicy.envNameAllowlist)).toBe(true);
    response.descendantPolicy.maxDepth = 999;
    response.descendantPolicy.envNameAllowlist.push('NODE_OPTIONS');
    response.edges[0].inheritsCredential = false;
    expect(result.descendantPolicy).toEqual(vector.response.descendantPolicy);
    expect(result.edges).toEqual(vector.response.edges);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(vector.request);
    expect(probe.digest).toHaveBeenCalled();
  });

  it.each(negative.resolutionCases as { id: string; request: any; response: any }[])('rejects frozen $id before measurement', async vector => {
    const probe = probeFor(positive.resolutionVectors[0].response.record);
    const authority = { resolve: async () => vector.response };
    const result = vector.request.subject.kind === 'runtime'
      ? await resolveRuntimeImplementation(authority, vector.request, env, probe)
      : await resolveToolImplementationIdentity(authority, vector.request, env, probe);
    expect(result).toEqual({ kind: 'unavailable', reason: 'implementation_identity_unattested' });
    expect(probe.lstat).not.toHaveBeenCalled();
    expect(probe.digest).not.toHaveBeenCalled();
  });

  it('preserves exact MCP response bytes and measured result on both vector sides', async () => {
    const vector = positive.mcpResolutionVector;
    expect(JSON.stringify(vector.responseBefore)).toBe(vector.responseJsonBefore);
    expect(JSON.stringify(vector.responseAfter)).toBe(vector.responseJsonAfter);
    expect(vector.responseJsonBefore).toBe(vector.responseJsonAfter);
    const locator: McpImplementationLocatorV1 = { subject: vector.requestSubject,
      command: vector.responseBefore.installPath, args: vector.responseBefore.launchArgv,
      launch: { launchCwd: vector.responseBefore.launchCwd, launcher: null } };
    const before = await resolveToolImplementationIdentity({ resolve: async () => vector.responseBefore }, locator, env, probeFor(vector.responseBefore));
    const after = await resolveToolImplementationIdentity({ resolve: async () => vector.responseAfter }, locator, env, probeFor(vector.responseAfter));
    expect(before.kind).toBe('attested');
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('cannot route runtime through the MCP-only API', async () => {
    const resolve = vi.fn(async () => positive.resolutionVectors[0].response.record);
    const result = await resolveToolImplementationIdentity({ resolve }, positive.resolutionVectors[0].request as McpImplementationLocatorV1, env);
    expect(result.kind).toBe('unavailable'); expect(resolve).not.toHaveBeenCalled();
  });

  it.each(['pi-subagent-print', 'pi-subagent-runner'] as const)('rejects a retargeted record for %s before measurement', async runtimeEntry => {
    const vector = positive.resolutionVectors[0]; // valid prepared prefix, wrong target
    const probe = probeFor(vector.response.record);
    const result = await resolveRuntimeImplementation({ resolve: async () => vector.response },
      { subject: { kind: 'runtime', runtimeId: 'pi' }, runtimeEntry }, env, probe);
    expect(result).toEqual({ kind: 'unavailable', reason: 'install_record_mismatch' });
    expect(probe.digest).not.toHaveBeenCalled();
  });

  it('rejects unknown runtime kinds before asking the Host', async () => {
    const resolve = vi.fn();
    const request = { subject: { kind: 'runtime', runtimeId: 'pi' }, runtimeEntry: 'rogue' } as unknown as RuntimeImplementationLocatorV1;
    expect((await resolveRuntimeImplementation({ resolve }, request, env)).kind).toBe('unavailable');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('ties finite vocabulary and edges to the accepted source inventory', () => {
    expect(DESCENDANT_PER_LAUNCH_ENV_NAMES).toEqual(positive.descendantSchemaDraft.template.fields.envNamesProjection.allowedPerLaunchNames);
    expect(RUNTIME_DESCENDANT_EDGES).toEqual(positive.schema.allowedEdges);
  });

  it.each([
    ['unknown wrapper key', (r: any) => { r.version = 99; }],
    ['missing finite cap', (r: any) => { delete r.descendantPolicy.sessionCap; }],
    ['unlimited sentinel', (r: any) => { r.descendantPolicy.sessionCap = 0; }],
    ['fraction', (r: any) => { r.descendantPolicy.fanout = 1.5; }],
    ['negative zero', (r: any) => { r.descendantPolicy.maxDepth = -0; }],
    ['loader authority', (r: any) => { r.descendantPolicy.envNameAllowlist = ['NODE_OPTIONS']; }],
    ['credential authority', (r: any) => { r.descendantPolicy.envNameAllowlist = ['PI_PROVIDER_API_KEY']; }],
    ['wildcard authority', (r: any) => { r.descendantPolicy.envNameAllowlist = ['PI_SUBAGENT_*']; }],
    ['unsorted names', (r: any) => { r.descendantPolicy.envNameAllowlist = ['PATH', 'HOME']; }],
    ['sparse names', (r: any) => { r.descendantPolicy.envNameAllowlist = Array(1); }],
    ['duplicate names', (r: any) => { r.descendantPolicy.envNameAllowlist = ['HOME', 'HOME']; }],
    ['extra policy key', (r: any) => { r.descendantPolicy.extra = true; }],
    ['edge mutation', (r: any) => { r.edges[0].child = 'pi-prepared'; }],
    ['missing edge', (r: any) => { r.edges.pop(); }],
    ['credential source rewrite', (r: any) => { r.edges[0].inheritsCredential = false; }],
    ['extra edge field', (r: any) => { r.edges[0].signer = 'child'; }],
    ['Host supplies measurement', (r: any) => { r.record.launchEnvNamesDigest = '0'.repeat(64); }],
  ] as const)('fails closed for %s', (_name, mutate) => {
    const response = structuredClone(positive.resolutionVectors[0].response);
    expect(parseRuntimeImplementationRecord(response)).toBeDefined();
    mutate(response);
    expect(parseRuntimeImplementationRecord(response)).toBeUndefined();
  });
});
