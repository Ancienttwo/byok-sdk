/**
 * #654 E3d-3: the device opens a routine template under the binding it builds
 * from the offer's `routineRef`, `agentRef` and `sealing` (design §6.3,
 * acceptance row §13.2). The offers are the golden routine lines of the
 * protocol corpus, so this test also pins the binding mapping that the Host
 * tests of #843 pin. Each refusal first runs the unchanged template on the
 * same runner, so it fails when the device cannot open a template at all.
 */
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEnvelope, type Envelope, type MessageType } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentHomeManager } from '../agent-home';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { ApprovalRegistry } from '../daemon/approvals';
import { SealedTasks, type SealedScopeKeyring } from '../daemon/sealed-task';
import { TaskRunner } from '../daemon/task-runner';
import { testIngressBudget } from './fixtures/activity-ingress';
import { testScratchOwner } from './fixtures/execution-scratch';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { advertiseEveryDeviceFlag } from './support/advertised-capabilities';

/** The fixed inputs the golden sealed lines were sealed with. Test data only. */
const GOLDEN_TENANT = 'tenant-golden';
const GOLDEN_SCOPE = { scopeId: 'scope-golden-device-1', epoch: 2 };
const GOLDEN_SCOPE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const TEMPLATE_INSTRUCTION = 'Write the daily digest.';
const TYPE = 'task.offer';

type Payload = Record<string, unknown> & {
  routineRef: { routineId: string; definitionVersion: number; notAfter: string };
  agentRef: { agentId: string; profileRevision: string };
  sealing: { scopeId: string; epoch: number; categories: string[] };
};
type Line = { type: MessageType; task_id: string; ts: string; payload: Payload };

const routineLines = readFileSync(new URL('../../../protocol/src/__tests__/golden/v5.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n')
  .map((raw) => JSON.parse(raw) as Line)
  .filter((line) => line.payload.routineRef !== undefined);
const [first, second, expired] = routineLines as [Line, Line, Line];

class GoldenKeyring implements SealedScopeKeyring {
  async scopeCategories() { return []; }
  async acceptHeader() { return true; }
  async openingKey(scope: { readonly id: string; readonly epoch: number }) {
    return scope.id === GOLDEN_SCOPE.scopeId && scope.epoch === GOLDEN_SCOPE.epoch ? GOLDEN_SCOPE_KEY : undefined;
  }
  async sealingKey(scopeId: string, minEpoch: number) {
    return scopeId === GOLDEN_SCOPE.scopeId && minEpoch <= GOLDEN_SCOPE.epoch
      ? { scopeKey: GOLDEN_SCOPE_KEY, epoch: GOLDEN_SCOPE.epoch, sender: 'A'.repeat(43), chainHead: { seq: 1, hash: `sha256:${'a'.repeat(64)}` } }
      : undefined;
  }
}

/** The golden opening key and no sealing key. Counts each sealing key lookup. */
class NoSealingKeyring extends GoldenKeyring {
  sealingKeyCalls = 0;
  override async sealingKey() {
    this.sealingKeyCalls += 1;
    return undefined;
  }
}

const runners: TaskRunner[] = [];
const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(runners.splice(0).map((runner) => runner.shutdownActiveTasks('test cleanup')));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/** The device clock, set to `instant` and running from there. */
function clockAt(instant: string): void {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(Date.parse(instant));
}

async function device(keyring: SealedScopeKeyring = new GoldenKeyring()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-routine-template-'));
  roots.push(root);
  const storeDir = path.join(root, 'store');
  const sent: Envelope[] = [];
  const adapter = new StubRuntimeAdapter('pi');
  const runner = new TaskRunner({
    getIngressBudget: testIngressBudget, scratchRoot: testScratchOwner(),
    adapters: [adapter],
    agentHome: new AgentHomeManager({ hostStorageRoot: path.join(root, 'home') }),
    agentEgressPolicy: first.payload.egressPolicy as never, agentSessionHandoffs: new AgentSessionHandoffStore(),
    deviceId: 'device-golden-1', tenantId: GOLDEN_TENANT, productId: 'sealed-routine', storeDir,
    getServerCapabilities: () => ['sealed-payload-v1'], send: (envelope) => { sent.push(envelope); },
    blobClient: { resolveInstruction: async () => '', uploadArtifact: async () => { throw new Error('unused'); } },
    approvalRegistry: new ApprovalRegistry(),
    agentMessageMcpBin: { command: process.execPath, args: ['/sdk/byok-agent-message-mcp.js'] },
    agentMessageMcpPreflight: async () => {},
    advertisedCapabilities: advertiseEveryDeviceFlag,
    sealedTasks: new SealedTasks({
      keyring, tenantId: GOLDEN_TENANT, deviceId: 'device-golden-1',
      blobs: { download: async () => { throw new Error('unused'); }, upload: async () => { throw new Error('unused'); } },
      serverCapabilities: () => [],
    }),
  });
  runners.push(runner);
  let seq = 0;
  /** Offers `payload` as the Host would, on the stub runtime. The AAD does not bind `runtime`. */
  const offer = (taskId: string, payload: Payload) =>
    runner.handleEnvelope(createEnvelope(TYPE, { ...structuredClone(payload), runtime: 'pi' } as never, { taskId, seq: ++seq }));
  const declines = (taskId: string) => sent.filter((envelope) => envelope.type === 'task.decline' && envelope.task_id === taskId).map((envelope) => envelope.payload);
  return { adapter, offer, declines, sent };
}

describe('a sealed routine template on the device (#654 E3d-3)', () => {
  it('runs two occurrences of one template', async () => {
    expect(second.payload.sealed).toEqual(first.payload.sealed);
    clockAt(second.ts);
    const { adapter, offer, declines, sent } = await device();
    await offer('occurrence-1', first.payload);
    // One Agent runs one task at a time, so the first occurrence ends first.
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(sent.some((envelope) => envelope.task_id === 'occurrence-1' && ['task.complete', 'task.fail'].includes(envelope.type))).toBe(true));
    await offer('occurrence-2', second.payload);
    // The runner puts the Agent memory preamble before the opened instruction.
    expect(adapter.startCalls).toHaveLength(2);
    for (const call of adapter.startCalls) expect((call.task.instruction as string).endsWith(`\n\n${TEMPLATE_INSTRUCTION}`)).toBe(true);
    expect([...declines('occurrence-1'), ...declines('occurrence-2')]).toEqual([]);
  });

  const changes: readonly (readonly [string, (payload: Payload) => Payload])[] = [
    ['another routine', (payload) => ({ ...payload, routineRef: { ...payload.routineRef, routineId: 'routine-other' } })],
    ['another definitionVersion', (payload) => ({ ...payload, routineRef: { ...payload.routineRef, definitionVersion: payload.routineRef.definitionVersion + 1 } })],
    ['another Agent', (payload) => ({ ...payload, agentRef: { ...payload.agentRef, profileRevision: 'profile-other' } })],
    ['another agentId', (payload) => ({ ...payload, agentRef: { ...payload.agentRef, agentId: 'agent-other' } })],
    ['a sealing that drops task-output (C3)', (payload) => ({ ...payload, sealing: { ...payload.sealing, categories: ['task-input'] } })],
  ];

  it.each(changes)('refuses the template under %s with sealed_open_failed', async (_name, change) => {
    clockAt(first.ts);
    const { adapter, offer, declines } = await device();
    await offer('unchanged', first.payload);
    expect(adapter.startCalls).toHaveLength(1);
    const changed = change(first.payload);
    await offer('changed', changed);
    expect(declines('changed')).toEqual([{ reason: 'sealed_open_failed', code: 'sealed_open_failed', retryable: false, agentRef: changed.agentRef, admission: { totalMs: expect.any(Number) } }]);
    expect(adapter.startCalls).toHaveLength(1);
  });

  it('refuses a template past its notAfter with sealing_policy_mismatch', async () => {
    expect(Date.parse(expired.payload.routineRef.notAfter)).toBeLessThan(Date.parse(expired.ts));
    clockAt(expired.ts);
    const { adapter, offer, declines } = await device();
    await offer('expired', expired.payload);
    expect(declines('expired')).toEqual([{ reason: 'sealing_policy_mismatch', code: 'sealing_policy_mismatch', retryable: false, agentRef: expired.payload.agentRef, admission: { totalMs: expect.any(Number) } }]);
    expect(adapter.startCalls).toHaveLength(0);
  });

  it('refuses an expired template whose notAfter the Host moved later, with sealed_open_failed', async () => {
    clockAt(expired.ts);
    const { adapter, offer, declines } = await device();
    const moved = { ...expired.payload, routineRef: { ...expired.payload.routineRef, notAfter: '2099-12-31T00:00:00.000Z' } };
    await offer('moved', moved);
    expect(declines('moved')).toEqual([{ reason: 'sealed_open_failed', code: 'sealed_open_failed', retryable: false, agentRef: moved.agentRef, admission: { totalMs: expect.any(Number) } }]);
    expect(adapter.startCalls).toHaveLength(0);
  });

  it('checks notAfter before it looks up a sealing key', async () => {
    clockAt(expired.ts);
    const keyring = new NoSealingKeyring();
    const { adapter, offer, declines } = await device(keyring);
    await offer('expired-no-key', expired.payload);
    expect(declines('expired-no-key')).toEqual([{ reason: 'sealing_policy_mismatch', code: 'sealing_policy_mismatch', retryable: false, agentRef: expired.payload.agentRef, admission: { totalMs: expect.any(Number) } }]);
    expect(keyring.sealingKeyCalls).toBe(0);
    expect(adapter.startCalls).toHaveLength(0);
  });

  it('runs a template at its notAfter and refuses it one millisecond later', async () => {
    const { notAfter } = first.payload.routineRef;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(notAfter));
    const { adapter, offer, declines } = await device();
    await offer('at-not-after', first.payload);
    expect(adapter.startCalls).toHaveLength(1);
    vi.setSystemTime(Date.parse(notAfter) + 1);
    await offer('after-not-after', first.payload);
    expect(declines('after-not-after')).toEqual([{ reason: 'sealing_policy_mismatch', code: 'sealing_policy_mismatch', retryable: false, agentRef: first.payload.agentRef, admission: { totalMs: expect.any(Number) } }]);
    expect(adapter.startCalls).toHaveLength(1);
  });
});
