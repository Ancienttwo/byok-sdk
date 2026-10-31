import { testRuntimeEnvironment } from '../fixtures/runtime-env';
import { freshTestAgentRef, testAgentHomeConfig } from '../fixtures/test-agent';
import { testScratchRoot } from '../fixtures/execution-scratch';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../../daemon/create-daemon';
import {
  freezeRuntimeAdapterDescriptor,
  type RuntimeAdapter,
  type RuntimeAdapterPrepareResult,
  type RuntimeVersionPolicy,
} from '../../types';
import { resolveRuntimeVersionPolicy, runtimeVersionDetectionFields, runtimeVersionVerdict } from '../../runtime-version-policy';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../../daemon/agent-egress-policy';
import { TestServer } from '../fixtures/test-server';
import { StubRuntimeAdapter } from '../fixtures/stub-adapter';
import { FRESH_OFFER } from '../fixtures/fresh-offer';

/**
 * #1103 C2: a synthetic Host-configured version block. Real CLIs are never
 * deliberately blocked, so this fixture is the only proof that `pickAdapter`
 * declines before claim and never reaches `prepare()`/`start()`. It needs no
 * installed runtime: the adapter's `detect()` evaluates the same policy the
 * adapter constructors use.
 */

const DESCRIPTOR_DEFAULT = Object.freeze({ qualifiedVersion: '1.4.0', unqualified: 'warn' as const });
const HOST_POLICY: RuntimeVersionPolicy = Object.freeze({
  qualifiedVersion: '1.4.0',
  unqualified: 'warn',
  block: Object.freeze([{ kind: 'prefix' as const, prefix: '1.5.' }]),
});

async function directory(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'byok-contract-block-'));
}

describe('runtime contract: synthetic Host version block (#1103)', () => {
  let server: TestServer | undefined;
  let daemon: Daemon | undefined;
  let storeDir: string | undefined;

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await server?.close();
    server = undefined;
    if (storeDir !== undefined) await fs.rm(storeDir, { recursive: true, force: true }).catch(() => undefined);
    storeDir = undefined;
  });

  it('declines before claim, without prepare or start, for an installed blocked version', async () => {
    const resolution = resolveRuntimeVersionPolicy({ descriptor: DESCRIPTOR_DEFAULT, adapterOption: HOST_POLICY });
    expect(resolution.policy).toEqual(HOST_POLICY);
    expect(runtimeVersionVerdict(resolution.policy, '1.5.2')).toEqual({
      state: 'block', qualifiedVersion: '1.4.0', matched: '1.5.',
    });

    const stub = new StubRuntimeAdapter('codex', {
      kind: 'available', version: '1.5.2', ...runtimeVersionDetectionFields(resolution.policy, '1.5.2'),
    });
    let prepareCalls = 0;
    const adapter: RuntimeAdapter = {
      descriptor: freezeRuntimeAdapterDescriptor({ ...stub.descriptor, versionPolicy: resolution.policy }),
      detect: () => stub.detect(),
      runtimeEnvironment: async () => testRuntimeEnvironment(),
      prepare: async (input): Promise<RuntimeAdapterPrepareResult> => {
        prepareCalls += 1;
        return stub.prepare(input);
      },
    };

    server = await TestServer.start();
    storeDir = await directory();
    const config: DaemonConfig = {
      storage: { scratchRoot: testScratchRoot() },
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Contract Block',
      productId: 'contract-version-block',
      serverUrl: server.url,
      agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
      storeDir,
    };
    daemon = createDaemonWithAdapters(config, [adapter]);
    await daemon.pair('pairing-code');
    await daemon.start();

    // The block is discoverable locally before any task arrives.
    expect(daemon.status().runtimes).toMatchObject([{
      id: 'codex', present: true, outcome: 'available', version: '1.5.2',
      versionVerdict: { state: 'block', qualifiedVersion: '1.4.0', matched: '1.5.' },
    }]);

    const taskId = 'task-contract-version-block';
    server.send(
      createEnvelope(
        'task.offer',
        { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'x', runtime: 'codex' },
        { taskId, seq: server.nextSeq() },
      ),
    );

    const decline = await server.waitFor((envelope) => envelope.type === 'task.decline' && envelope.task_id === taskId);
    expect(decline.payload).toMatchObject({ code: 'runtime_version_blocked', retryable: false });
    expect((decline.payload as { reason?: string }).reason).toContain('blocked by the device version policy');
    expect(server.received.some((envelope) => envelope.type === 'task.claim' && envelope.task_id === taskId)).toBe(false);
    expect(prepareCalls).toBe(0);
    expect(stub.startCalls).toHaveLength(0);
    expect(stub.sessions).toHaveLength(0);
  });
});
