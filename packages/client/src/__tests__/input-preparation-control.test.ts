import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import {
  ControlError,
  INPUT_PREPARATION_CANCEL_METHOD,
  INPUT_PREPARATION_LOOKUP_METHOD,
  INPUT_PREPARATION_PREPARE_METHOD,
  NdjsonLineReader,
  controlEndpointPath,
  encodeFrame,
} from '../daemon/control-protocol';
import {
  cancelInputPreparation,
  connectControlClient,
  lookupInputPreparation,
  requestInputPreparation,
  type ControlClient,
} from '../bin/control-client';
import {
  INPUT_PREPARATION_REQUEST_FORMAT,
  INPUT_PREPARATION_VERSION,
  validateInputPreparationLimits,
  type InputPreparationAuthorityResolver,
  type InputPreparationCounterAdapter,
  type InputPreparationCounterRequestV1,
  type InputPreparationCounterResultV1,
  type InputPreparationRequestV1,
} from '../input-preparation';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';
import { trustedCwd } from './fixtures/launch-cwd';

/**
 * One real stdio MCP server, configured as a device toolset.
 *
 * It is here because the request contract no longer lets a caller state a tool
 * manifest: a preparation names `requiredToolsets`, and the daemon observes
 * them itself. So the end-to-end path only exists when this device actually
 * has a toolset to observe, and these cases now exercise the real probe, the
 * real launch boundary and the real fingerprints along with everything else.
 */
const MCP_FIXTURE = fileURLToPath(new URL('./fixtures/mcp-fixture-server.mjs', import.meta.url));
const TOOLSETS = {
  team: {
    mcpServers: {
      teamserver: { command: process.execPath, args: [MCP_FIXTURE, '{}'] },
    },
  },
} as const;

/**
 * B-P2 §10.5 across the WHOLE local stack: the real control server and its
 * HMAC handshake, the real `create-daemon` method registry, the real durable
 * store, and the REAL native compiler — the only stub is the counter, which
 * performs no live call and is marked `test_fixture`.
 *
 * The two facts this file exists to pin, which no unit test can:
 *
 * - An unauthenticated peer never reaches compile, store or counter.
 * - Preparing does not create a task, claim, Execution or nonce: the daemon's
 *   active-task list stays empty across a successful preparation.
 */

const TRUSTED = {
  deviceId: 'device-1',
  agentRef: 'agent-1',
  profileId: 'profile-1',
  profileRevision: 'profile-rev-1',
} as const;

const LIMITS = validateInputPreparationLimits({
  revision: 'limits-rev-1',
  maxRequestBytes: 32_000,
  maxArtifactBytes: 256_000,
  maxScopeAggregateBytes: 512_000,
  maxInFlight: 4,
  maxCounterCallsPerScope: 16,
  counterTimeoutMs: 2_000,
  preparationDeadlineMs: 4_000,
  retentionMs: 60_000,
  retryHorizonMs: 30_000,
});

/** Authorizes exactly one trusted local record. Every other claim is refused. */
const authorityResolver: InputPreparationAuthorityResolver = {
  async resolveScope(claim) {
    if (
      claim.deviceId !== TRUSTED.deviceId ||
      claim.agentRef !== TRUSTED.agentRef ||
      claim.profileId !== TRUSTED.profileId
    ) {
      return { authorized: false, reason: 'unknown_device' };
    }
    if (claim.profileRevision !== TRUSTED.profileRevision) return { authorized: false, reason: 'profile_revision_drift' };
    return { authorized: true, grant: { scopeId: 'scope:device-1', ...claim } };
  },
};

interface RecordingCounter extends InputPreparationCounterAdapter {
  readonly calls: InputPreparationCounterRequestV1[];
}

function fixtureCounter(): RecordingCounter {
  const calls: InputPreparationCounterRequestV1[] = [];
  return {
    calls,
    async count(request: InputPreparationCounterRequestV1): Promise<InputPreparationCounterResultV1> {
      calls.push(request);
      return {
        method: 'fixture.tokenizer',
        methodVersion: '0',
        authority: 'test_fixture',
        kind: 'bound',
        value: 4_242,
        coverage: { covered: false, reason: 'offline fixture' },
        // Bound to the exact projection the adapter was handed: a count whose
        // projection nobody can name is refused before it is persisted.
        providerEvidence: {
          projectionDigest: createHash('sha256').update(request.counterProjection, 'utf8').digest('hex'),
          endpoint: request.target.endpoint,
          modelId: request.target.modelId,
          asserted: { httpStatus: 200, usageFields: { prompt_tokens: 4_242 }, responseDigest: 'e'.repeat(64) },
        },
      };
    },
  };
}

function preparationRequest(overrides: Partial<InputPreparationRequestV1> = {}): InputPreparationRequestV1 {
  return {
    format: INPUT_PREPARATION_REQUEST_FORMAT,
    version: INPUT_PREPARATION_VERSION,
    requestId: 'prep-1',
    policyRevision: LIMITS.revision,
    scope: { ...TRUSTED },
    source: { revision: 'src-rev-1', digest: 'src-digest-1' },
    selection: {
      model: {
        id: 'glm-4.6',
        name: 'GLM 4.6',
        api: 'openai-completions',
        provider: 'zai',
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        reasoning: false,
        input: ['text'],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
      options: { cacheRetention: 'none', maxTokens: 4_096 },
    },
    snapshot: {
      prompt: {
        cwd: '/workspace/project',
        toolSnippets: {},
        promptGuidelines: ['prefer small diffs'],
        contextFiles: [{ path: 'AGENTS.md', content: 'be precise' }],
        formattedSkills: '',
        docsPaths: { readmePath: 'README.md', docsPath: 'docs', examplesPath: 'examples' },
      },
      messages: [{ role: 'user', content: 'summarise the repository', timestamp: 1_700_000_000_000 }],
    },
    permissionMode: 'auto',
    requiredToolsets: ['team'],
    ...overrides,
  };
}

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function controlErrorCode(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ControlError) return error.code;
    throw error;
  }
  throw new Error('expected the control call to reject');
}

describe('B-P2 control surface: end to end over the real control socket', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;
  let client: ControlClient | undefined;
  let counter: RecordingCounter;

  beforeEach(async () => {
    server = await TestServer.start();
    counter = fixtureCounter();
  });

  afterEach(async () => {
    client?.close();
    client = undefined;
    await daemon?.stop();
    daemon = undefined;
    await server.close();
  });

  async function start(options: { enabled: boolean; productId: string }): Promise<{ storeDir: string; config: DaemonConfig }> {
    const workspaceRoot = await tmpDir(`byok-prep-${options.productId}-ws-`);
    const storeDir = await tmpDir(`byok-prep-${options.productId}-store-`);
    const config: DaemonConfig = {
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Acme',
      productId: options.productId,
      serverUrl: server.url,
      workspaceRoot,
      storeDir,
      mcpToolsets: { ...TOOLSETS },
      ...(options.enabled ? { inputPreparation: { limits: LIMITS, authorityResolver, counter } } : {}),
    };
    daemon = createDaemonWithAdapters(config, [new StubRuntimeAdapter('pi')]);
    await daemon.pair('pairing-code');
    await daemon.start();
    const connected = await connectControlClient({ storeDir, productId: options.productId });
    if (!connected.ok) throw new Error(`expected a control endpoint: ${connected.reason}`);
    client = connected.client;
    return { storeDir, config };
  }

  it('keeps the whole surface off when no inputPreparation section is configured', async () => {
    await start({ enabled: false, productId: 'acme-prep-off' });
    for (const method of [INPUT_PREPARATION_PREPARE_METHOD, INPUT_PREPARATION_LOOKUP_METHOD, INPUT_PREPARATION_CANCEL_METHOD]) {
      // Checked before the params are even parsed: a disabled daemon says
      // nothing about request shapes.
      expect(await controlErrorCode(client!.request(method, { nonsense: true }))).toBe('input_preparation_unconfigured');
    }
    expect(counter.calls).toEqual([]);
  });

  it('refuses a daemon whose configured limits policy is invalid, at construction', async () => {
    const workspaceRoot = await tmpDir('byok-prep-badpolicy-ws-');
    const storeDir = await tmpDir('byok-prep-badpolicy-store-');
    expect(() =>
      createDaemonWithAdapters(
        {
          localAgentRelease: { version: '0.0.0-test' },
          productName: 'Acme',
          productId: 'acme-prep-badpolicy',
          serverUrl: server.url,
          workspaceRoot,
          storeDir,
          inputPreparation: {
            limits: { revision: 'r', maxRequestBytes: 0 } as never,
            authorityResolver,
            counter,
          },
        },
        [new StubRuntimeAdapter('pi')],
      ),
    ).toThrow(/maxRequestBytes must be a positive safe integer/u);
  });

  it('prepares an artifact with the real native compiler and creates no task, claim or Execution', async () => {
    const { storeDir } = await start({ enabled: true, productId: 'acme-prep-happy' });
    const receipt = await requestInputPreparation(client!, preparationRequest());

    expect(receipt.format).toBe('byok.input-preparation.receipt');
    expect(receipt.state).toBe('counted');
    // The native compiler's own structural projection contract, carried
    // verbatim — not a label this SDK chose.
    expect(receipt.artifact?.projection.version).toBe(2);
    expect(receipt.artifact?.projection.kind).toBe('content_complete');
    expect(receipt.artifact?.projection.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt.artifact?.residual.length).toBeGreaterThan(0);
    for (const entry of receipt.artifact?.residual ?? []) {
      expect(typeof entry.key).toBe('string');
      expect(typeof entry.valueClass).toBe('string');
    }
    expect(receipt.artifact?.requestBytes).toBeGreaterThan(0);
    expect(receipt.binding.runtime.packageName).toBe('@byok-sdk/pi-coding-agent');
    expect(receipt.binding.runtime.upstreamCommit).toMatch(/^[0-9a-f]{40}$/u);
    // The mode the manifest was filtered for is recorded, not inferred.
    expect(receipt.binding.permissionMode).toBe('auto');
    // The tools were OBSERVED from the configured toolset, and every one of
    // them carries the implementation kind this daemon resolved for it. This
    // SDK ships no `toolImplementationAuthority`, so that is the unconfigured
    // answer — stated as evidence rather than assumed.
    expect(Object.keys(receipt.artifact?.toolImplementationKinds ?? {})).toEqual([
      'mcp__teamserver__echo',
      'mcp__teamserver__find_leads',
    ]);
    expect(new Set(Object.values(receipt.artifact?.toolImplementationKinds ?? {}))).toEqual(
      new Set(['unavailable:resolver_unconfigured']),
    );
    expect(receipt.artifact?.observationDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt.artifact?.toolBindingDigest).toMatch(/^[0-9a-f]{64}$/u);
    // The observation happened inside the proven launch boundary.
    expect(await trustedCwd()).toBeTruthy();
    expect(receipt.counter).toMatchObject({ authority: 'test_fixture', kind: 'bound', value: 4_242 });

    // A fixture count, an unruled residual set and unattested executors can
    // never be ready. `projection_unknown` is absent on purpose: the compiler
    // DID prove a content-complete projection, so what is missing is the Host's
    // accounting ruling, which this request deliberately does not carry.
    expect(receipt.ready).toBe(false);
    expect(receipt.readinessReasons).toEqual(
      expect.arrayContaining([
        'accounting_policy_missing',
        'counter_authority_not_production',
        'counter_coverage_incomplete',
        'executor_identity_unproven',
      ]),
    );
    expect(receipt.readinessReasons).not.toContain('projection_unknown');

    // Task-free: nothing entered the runner.
    const status = await client!.request<{ activeTasks: unknown[]; runtimeIds: string[] }>('status');
    expect(status.activeTasks).toEqual([]);

    // The retained artifact is on disk, 0600, under the daemon's own store.
    const artifactDir = path.join(storeDir, 'input-preparation', 'artifacts');
    const files = await fs.readdir(artifactDir);
    expect(files).toHaveLength(1);
    const stat = await fs.stat(path.join(artifactDir, files[0]!));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('answers lookup and cancel from the same durable record, and never across a scope', async () => {
    await start({ enabled: true, productId: 'acme-prep-scope' });
    const prepared = await requestInputPreparation(client!, preparationRequest());

    const looked = await lookupInputPreparation(client!, { requestId: 'prep-1', scope: { ...TRUSTED } });
    expect(looked.reference).toBe(prepared.reference);

    const foreign = { ...TRUSTED, deviceId: 'device-2' };
    expect(await controlErrorCode(lookupInputPreparation(client!, { requestId: 'prep-1', scope: foreign }))).toBe('scope_denied');
    expect(await controlErrorCode(cancelInputPreparation(client!, { requestId: 'prep-1', scope: foreign }))).toBe('scope_denied');

    // A scope the authority DOES trust but that has no such record is a plain
    // not-found, and cancelling a settled record is a no-op.
    expect(await controlErrorCode(lookupInputPreparation(client!, { requestId: 'prep-missing', scope: { ...TRUSTED } }))).toBe(
      'not_found',
    );
    expect((await cancelInputPreparation(client!, { requestId: 'prep-1', scope: { ...TRUSTED } })).state).toBe('counted');
    expect(counter.calls).toHaveLength(1);
  });

  it('refuses a wrong device, Agent or profile revision before compiling or counting', async () => {
    await start({ enabled: true, productId: 'acme-prep-authz' });
    for (const scope of [
      { ...TRUSTED, deviceId: 'device-2' },
      { ...TRUSTED, agentRef: 'agent-2' },
      { ...TRUSTED, profileRevision: 'profile-rev-2' },
    ]) {
      expect(await controlErrorCode(requestInputPreparation(client!, preparationRequest({ scope })))).toBe('scope_denied');
    }
    expect(counter.calls).toEqual([]);
  });

  it('rejects an unknown field, a wrong format tag and a mismatched policy revision', async () => {
    await start({ enabled: true, productId: 'acme-prep-shape' });
    expect(
      await controlErrorCode(client!.request(INPUT_PREPARATION_PREPARE_METHOD, { ...preparationRequest(), extra: 1 })),
    ).toBe('bad_request');
    expect(
      await controlErrorCode(client!.request(INPUT_PREPARATION_PREPARE_METHOD, { ...preparationRequest(), format: 'other' })),
    ).toBe('bad_request');
    expect(
      await controlErrorCode(requestInputPreparation(client!, preparationRequest({ policyRevision: 'limits-rev-9' }))),
    ).toBe('policy_revision_mismatch');
    expect(counter.calls).toEqual([]);
  });

  it('rejects an input outside the declared first support set instead of filling the gap', async () => {
    await start({ enabled: true, productId: 'acme-prep-unsupported' });
    const base = preparationRequest();
    // A toolset this device does not configure is refused as unsupported
    // input: the daemon will not prepare a manifest it cannot observe, and it
    // will not silently prepare a smaller one.
    expect(
      await controlErrorCode(requestInputPreparation(client!, preparationRequest({ requiredToolsets: ['nonesuch'] }))),
    ).toBe('unsupported_input');
    expect(counter.calls).toEqual([]);

    // A caller-stated tool schema is refused by NAME, not as a shape error:
    // the model-visible manifest is a local observation this contract moved
    // onto the device.
    expect(
      await controlErrorCode(
        client!.request(INPUT_PREPARATION_PREPARE_METHOD, {
          ...base,
          snapshot: { ...base.snapshot, tools: [{ name: 'read', description: 'd', parameters: { type: 'object' } }] },
        }),
      ),
    ).toBe('unsupported_input');
    expect(
      await controlErrorCode(
        client!.request(INPUT_PREPARATION_PREPARE_METHOD, { ...base, toolExecutors: { read: 'exec:read@1' } }),
      ),
    ).toBe('unsupported_input');
    expect(counter.calls).toEqual([]);

    // An assistant message WITHOUT the host-canonical origin discriminant is
    // refused by the wire gate itself: it claims provenance this surface
    // cannot check, and the support set admits host-canonical text only.
    expect(
      await controlErrorCode(
        client!.request(INPUT_PREPARATION_PREPARE_METHOD, {
          ...base,
          snapshot: { ...base.snapshot, messages: [{ role: 'assistant', content: 'hi', timestamp: 1 }] },
        }),
      ),
    ).toBe('bad_request');
    // And host-canonical text that carries a fabricated provenance field is
    // refused the same way rather than having the field stripped.
    expect(
      await controlErrorCode(
        client!.request(INPUT_PREPARATION_PREPARE_METHOD, {
          ...base,
          snapshot: {
            ...base.snapshot,
            messages: [
              { role: 'assistant', origin: 'host_canonical', content: 'hi', timestamp: 1, usage: { input: 1 } },
            ],
          },
        }),
      ),
    ).toBe('bad_request');
  });

  it('is idempotent over the socket: a repeated call rereads the receipt without a second counter call', async () => {
    await start({ enabled: true, productId: 'acme-prep-idem' });
    const first = await requestInputPreparation(client!, preparationRequest());
    const second = await requestInputPreparation(client!, preparationRequest());
    expect(second.reference).toBe(first.reference);
    expect(second.counter).toEqual(first.counter);
    expect(counter.calls).toHaveLength(1);

    expect(
      await controlErrorCode(
        requestInputPreparation(client!, preparationRequest({ source: { revision: 'src-rev-2', digest: 'src-digest-2' } })),
      ),
    ).toBe('request_conflict');
    expect(counter.calls).toHaveLength(1);
  });

  it('never reaches compile, store or counter without the HMAC handshake', async () => {
    const { storeDir, config } = await start({ enabled: true, productId: 'acme-prep-unauth' });
    const endpoint = controlEndpointPath(config.productId, storeDir);

    // A raw socket that skips the handshake entirely and sends the request
    // frame straight away.
    const outcome = await new Promise<'closed' | 'answered'>((resolve) => {
      const socket = net.createConnection(endpoint);
      const reader = new NdjsonLineReader();
      socket.on('error', () => undefined);
      socket.once('connect', () => {
        socket.write(
          encodeFrame({ v: 1, id: 'x1', method: INPUT_PREPARATION_PREPARE_METHOD, params: preparationRequest() }),
        );
      });
      socket.on('data', (chunk: Buffer) => {
        for (const line of reader.push(chunk)) {
          const parsed = JSON.parse(line) as { id?: string };
          if (parsed.id === 'x1') {
            socket.destroy();
            resolve('answered');
            return;
          }
        }
      });
      socket.once('close', () => resolve('closed'));
    });

    expect(outcome).toBe('closed');
    expect(counter.calls).toEqual([]);
    const artifactDir = path.join(storeDir, 'input-preparation', 'artifacts');
    await expect(fs.readdir(artifactDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
