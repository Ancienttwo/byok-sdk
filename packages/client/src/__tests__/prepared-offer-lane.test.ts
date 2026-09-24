import { createDaemonWithAdapters } from '../daemon/create-daemon';
import { TestServer } from './fixtures/test-server';
import { McpToolsetRegistry } from '../daemon/toolset-registry';
import * as preparationRuntime from '../adapters/pi/input-preparation-runtime';
import * as implementationIdentity from '../daemon/tool-implementation-identity';
import * as mcpProbe from '../daemon/mcp-tools-probe';
import { mapPiMessageToAgentEvent } from '../adapters/pi/events';
import { sanitizeEgressEnvelope } from '../daemon/agent-egress-sanitizer';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope, type InputPreparationOfferBinding, type TaskOfferPreparedPayload } from '@byok-sdk/protocol';
import { AgentHomeManager } from '../agent-home';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { buildRuntimeEnv } from '../daemon/environment';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import {
  PREPARED_CONTEXT_OVERFLOW_REASON_PREFIX,
  PREPARED_USAGE_UNAVAILABLE_REASON_PREFIX,
  TaskRunner,
  type TaskRunnerDeps,
} from '../daemon/task-runner';
import {
  InputPreparationStore,
  type CounterReservationInput,
  type InputPreparationArtifact,
} from '../daemon/input-preparation-store';
import { SUPPORTED_PREPARED_COMPILER_VERSION } from '../adapters/pi/input-preparation';
import { fingerprintPreparedToolSurface } from '../daemon/prepared-tool-surface';
import { mcpLaunchAttestation } from '../daemon/trusted-launch-cwd';
import {
  realToolImplementationFsProbe,
  resolveToolImplementationIdentity,
  type ToolImplementationAuthority,
  type ToolImplementationFsProbe,
  type ToolImplementationIdentityV1,
} from '../daemon/tool-implementation-identity';
import {
  INPUT_PREPARATION_ARTIFACT_FORMAT,
  INPUT_PREPARATION_VERSION,
  inputPreparationRuntimeIdentityString,
  preparedToolBindingDigest,
  type InputPreparationAccountingPolicyRefV1,
  type InputPreparationArtifactSummaryV1,
  type InputPreparationBindingV1,
  type InputPreparationCounterEvidenceV1,
  type InputPreparationModelV1,
  type InputPreparationRuntimeIdentityV1,
} from '../input-preparation';
import type { McpToolsetConfig, RuntimeCapabilities, RuntimeInstallationObservationContext } from '../types';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { observationOf } from './fixtures/mcp-observation';
import { trustedCwd } from './fixtures/launch-cwd';

/**
 * `task.offer_prepared` end to end through the real `TaskRunner`, the real
 * durable `InputPreparationStore`, and the real digest functions both sides
 * compute with.
 *
 * Nothing about the counted record is faked into agreement: the fixture below
 * builds it the way a preparation builds it — same launch attestation, same
 * resolved implementation identity, same `fingerprintPreparedToolSurface`, same
 * `preparedToolBindingDigest` — and every mismatch case perturbs exactly ONE of
 * those inputs. A test that hard-coded the digests would pass forever after a
 * formula change, which is the one thing this lane cannot afford.
 *
 * The properties under test:
 *
 * - The pin lands strictly BEFORE the claim, asserted as an order on the same
 *   connection spy the claim goes out on.
 * - Two runners racing one reference produce exactly one claim; the loser sends
 *   a decline and dispatches nothing.
 * - Every compared item declines with its own reason, claims nothing and pins
 *   nothing.
 * - A missing record, and a record that is not ready, decline by name.
 * - A replay after the pin reads back the same pin rather than taking a second.
 * - Ordinary `task.offer*` traffic is untouched.
 */

const MCP_CAPABLE: RuntimeCapabilities = {
  steer: false,
  resume: true,
  approvalInteractive: true,
  mcpToolsets: true,
  permissionModes: ['auto', 'confirm'],
};

const unusedBlobClient: BlobResolver = {
  resolveInstruction: async () => { throw new Error('not used'); },
  uploadArtifact: async () => { throw new Error('not used'); },
};

const AGENT_REF = { agentId: 'agent-prepared-1', profileRevision: 'profile-rev-1' } as const;
const DEVICE_ID = 'device-prepared-1';
const SCOPE_ID = 'scope-prepared-1';
const REQUEST_ID = 'prep-request-1';
const REQUEST_DIGEST = 'request-digest-1';
const ENVELOPE_DIGEST = 'envelope-digest-1';

/**
 * The environment `TaskRunner.handleOffer` builds for this task, recomputed
 * here from the same three inputs (`daemon/task-runner.ts`'s own
 * `buildRuntimeEnv` call) — the stub adapter declares no environment
 * requirements and this lane wires no local override.
 *
 * It has to be the SAME value: an implementation identity binds the
 * environment the SDK measured it against, so a fixture that resolved against
 * a different one would recompute a different binding digest at admission and
 * every case below would decline for the fixture's reason instead of its own.
 */
const LANE_ENV: Readonly<Record<string, string>> = Object.freeze(buildRuntimeEnv({
  ambient: process.env,
  requirements: { credentialNames: [] },
}));
const TOOL_MANIFEST_DIGEST = 'tool-manifest-digest-1';
const POLICY_REVISION = 'limits-policy-r1';
const TOOLSET_ID = 'team';
const SERVER_NAME = 'teamserver';
const TOOLSET_REVISION = 'team-definition-r1';

/** Synthetic fixture identity: never resolved from the installed fork. */
const RUNTIME: InputPreparationRuntimeIdentityV1 = {
  packageName: '@byok-sdk/pi-coding-agent',
  packageVersion: '0.85.1002',
  tarballIntegrity: 'sha512-'+ 'YQ=='.repeat(1),
  upstreamCommit: 'd981de1229ef899957bbe968bc8dcda02a21f477',
  provenanceDigest: 'a'.repeat(64), closureDigest: 'b'.repeat(64),
  envelopeFormat: 'pi.session.prepared-input',
  requestFormat: 'pi.openai-completions.prepared',
  compilerVersion: SUPPORTED_PREPARED_COMPILER_VERSION,
};

/** The projection a compiler would have proved over this lane's P(D). */
const PROJECTION = { version: 3, kind: 'content_complete', digest: 'a'.repeat(64) } as const;
const RESIDUAL = [{ key: 'max_tokens', valueClass: 'bounded_integer' }] as const;

/** The Host ruling that makes this lane's one residual key applicable. */
const ACCOUNTING_POLICY_REF: InputPreparationAccountingPolicyRefV1 = {
  revision: 'accounting-r1',
  ruledRuntime: inputPreparationRuntimeIdentityString(RUNTIME),
  ruledTarget: { endpoint: 'https://api.z.ai/api/coding/paas/v4', modelId: 'glm-4.6' },
  ruledResidualKeys: ['max_tokens'],
};

/**
 * A SYNTHETIC production-authority marker, written directly into the store.
 *
 * It exists only to move this lane past the readiness gate for these tests: the
 * record is authored into the durable store, so it never travels through
 * `validateProviderEvidence` and never faces the digest/target comparison a
 * real count is checked by. It is NOT evidence that any HTTP observation ever
 * happened, and nothing in this file places a counter call.
 */
const SYNTHETIC_PROVIDER_COUNT_FOR_LANE_TESTS = 'provider' as const;

/**
 * The counter evidence an optional counter leaves on a prepared record. A
 * record with none is equally ready; the lane fixture keeps a provider count so
 * the lane is exercised with the optional tightener present.
 */
const COUNTER_EVIDENCE: InputPreparationCounterEvidenceV1 = {
  method: 'fixture.tokenizer',
  methodVersion: '0',
  authority: SYNTHETIC_PROVIDER_COUNT_FOR_LANE_TESTS,
  value: 128,
  coverage: { covered: true },
  providerEvidence: {
    projectionDigest: PROJECTION.digest,
    endpoint: 'https://api.z.ai/api/coding/paas/v4',
    modelId: 'glm-4.6',
    asserted: { httpStatus: 200, usageFields: { prompt_tokens: 128 }, responseDigest: 'e'.repeat(64) },
  },
  target: { endpoint: 'https://api.z.ai/api/coding/paas/v4', modelId: 'glm-4.6' },
  calledAt: '2026-01-01T00:00:00.000Z',
  completedAt: '2026-01-01T00:00:01.000Z',
};

const MODEL: InputPreparationModelV1 = {
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
};

const dirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(
    (dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  ));
});

/**
 * The ownership seam the identity resolver requires, exactly as
 * `tool-implementation-spawn-gate.test.ts` uses it: only `uid`/`mode` are
 * overridden, so the digest, size and mtime under test are still read off a
 * real file. A non-root test process cannot create a root-owned file, and an
 * unattested identity can never produce a READY record.
 */
function rootOwnedProbe(): ToolImplementationFsProbe {
  return {
    async lstat(target) {
      const real = await realToolImplementationFsProbe.lstat(target);
      return { ...real, uid: 0, mode: real.mode & ~0o222 };
    },
    realpath: (target) => realToolImplementationFsProbe.realpath(target),
    digest: (target) => realToolImplementationFsProbe.digest(target),
  };
}

interface Lane {
  readonly store: InputPreparationStore;
  /** The daemon store directory the record log lives under, so a restart can be reconstructed over it. */
  readonly storeDir: string;
  readonly recordId: string;
  readonly observation: ReturnType<typeof observationOf>;
  readonly implementations: Readonly<Record<string, ToolImplementationIdentityV1>>;
  readonly toolsets: ReadonlyMap<string, McpToolsetConfig>;
  readonly authority: ToolImplementationAuthority;
  readonly serverCommand: string;
  readonly toolsetDefinitionRevisions: () => ReadonlyMap<string, string>;
}

function binding(overrides: Partial<InputPreparationBindingV1> = {}): InputPreparationBindingV1 {
  return {
    scopeId: SCOPE_ID,
    deviceId: DEVICE_ID,
    agentRef: AGENT_REF.agentId,
    profileId: 'profile-prepared-1',
    profileRevision: AGENT_REF.profileRevision,
    source: { revision: 'source-r1', digest: 'source-digest-1' },
    target: { endpoint: MODEL.baseUrl, modelId: MODEL.id },
    policyRevision: POLICY_REVISION,
    permissionMode: 'auto',
    runtime: RUNTIME,
    requestDigest: REQUEST_DIGEST,
    accountingPolicyRef: ACCOUNTING_POLICY_REF,
    ...overrides,
  };
}

function artifact(recordId: string): InputPreparationArtifact {
  return {
    format: INPUT_PREPARATION_ARTIFACT_FORMAT,
    version: INPUT_PREPARATION_VERSION,
    recordId,
    requestDigest: REQUEST_DIGEST,
    envelopeDigest: ENVELOPE_DIGEST,
    toolManifestDigest: TOOL_MANIFEST_DIGEST,
    requestBody: '{"model":"glm-4.6","messages":[]}',
    counterProjection: '{"model":"glm-4.6"}',
    projection: PROJECTION,
    residual: [...RESIDUAL],
    envelope: { format: 'pi.session.prepared-input', version: 3 },
  };
}

/**
 * Build the durable record a preparation would have written on THIS machine,
 * for THIS toolset, under THIS launch boundary.
 *
 * `summaryOverrides` is how every mismatch case below perturbs exactly one
 * compared item: the record is otherwise identical to what the admission will
 * recompute, so a decline can only come from the perturbation.
 */
async function lane(options: {
  readonly summaryOverrides?: Partial<InputPreparationArtifactSummaryV1>;
  readonly bindingOverrides?: Partial<InputPreparationBindingV1>;
  readonly modelOverride?: InputPreparationModelV1;
  readonly counted?: boolean;
  readonly registryRevision?: boolean;
} = {}): Promise<Lane> {
  const serverCommand = path.join(await tempDir('byok-prepared-bin-'), 'teamserver');
  await fs.writeFile(serverCommand, '#!/bin/sh\nexec true\n');
  const closureDigest = await realToolImplementationFsProbe.digest(serverCommand);
  // An install RECORD: the stat tuples and the two launch-environment digests
  // are deliberately absent, because those are the facts the SDK measures
  // itself rather than accepting from a host.
  const authority: ToolImplementationAuthority = {
    resolve: async () => ({
      kind: 'attested',
      authority: 'host-install-record',
      manifestRevision: 'team@2026.9.1',
      form: 'compiled-executable',
      installPath: serverCommand,
      closureDigest,
      closureKind: 'artifact',
      launchArgv: ['--stdio'],
      launchCwd: '/',
    } as never),
  };

  const toolsets: ReadonlyMap<string, McpToolsetConfig> = new Map([
    [TOOLSET_ID, { mcpServers: { [SERVER_NAME]: { command: serverCommand, args: ['--stdio'] } } }],
  ]);
  const revision = options.registryRevision
    ? new McpToolsetRegistry(Object.fromEntries(toolsets)).status().toolsets[0]!.definitionRevision
    : TOOLSET_REVISION;
  const toolsetDefinitionRevisions = (): ReadonlyMap<string, string> =>
    new Map([[TOOLSET_ID, revision]]);

  // Resolved through the production resolver, with the production fs probe
  // seam — the same call `TaskRunner.handleOffer` makes for this same server.
  const launch = { cwd: await trustedCwd() } as const;
  const attestation = mcpLaunchAttestation(launch);
  const implementation = await resolveToolImplementationIdentity(
    authority,
    {
      subject: { kind: 'mcp-server', toolsetId: TOOLSET_ID, serverName: SERVER_NAME },
      command: serverCommand,
      args: ['--stdio'],
      launch: attestation,
    },
    LANE_ENV,
    rootOwnedProbe(),
  );
  expect(implementation.kind).toBe('attested');
  const implementations = Object.freeze({ [SERVER_NAME]: implementation });

  const observation = observationOf({ [SERVER_NAME]: ['echo'] }, { toolsetId: TOOLSET_ID });
  const fingerprinted = await fingerprintPreparedToolSurface({
    observation,
    permissionMode: 'auto',
    runtimeIdentity: inputPreparationRuntimeIdentityString(RUNTIME),
    launch: attestation,
    toolsetDefinitionRevisions: { [TOOLSET_ID]: revision },
    implementations,
  });
  if (!fingerprinted.ok) throw new Error(`fixture surface refused: ${fingerprinted.detail}: ${fingerprinted.message}`);

  const toolBindingDigest = preparedToolBindingDigest({
    launch: attestation,
    toolsetDefinitionRevisions: { [TOOLSET_ID]: revision },
    servers: [{
      serverName: SERVER_NAME,
      toolsetId: TOOLSET_ID,
      command: serverCommand,
      args: ['--stdio'],
      implementation,
    }],
  });

  const summary: InputPreparationArtifactSummaryV1 = {
    requestDigest: REQUEST_DIGEST,
    envelopeDigest: ENVELOPE_DIGEST,
    toolManifestDigest: TOOL_MANIFEST_DIGEST,
    requestBytes: 33,
    projectionBytes: 19,
    // The readiness inputs a fixture must state honestly: a projection the
    // compiler did NOT prove content-complete, or a residual key the Host
    // ruling does not name, keeps every record unready.
    projection: PROJECTION,
    residual: [...RESIDUAL],
    observationDigest: fingerprinted.fingerprint.observationDigest,
    toolBindingDigest,
    toolImplementationKinds: fingerprinted.fingerprint.toolImplementationKinds,
    ...options.summaryOverrides,
  };

  const storeDir = await tempDir('byok-prepared-prep-store-');
  const store = new InputPreparationStore({
    storeDir,
    retentionMs: 60 * 60 * 1000,
    retryHorizonMs: 60 * 60 * 1000,
  });
  await store.open();
  const reserved = await store.reserve({
    key: { scopeId: SCOPE_ID, agentRef: AGENT_REF.agentId, requestId: REQUEST_ID },
    requestDigest: REQUEST_DIGEST,
    binding: binding(options.bindingOverrides),
    model: options.modelOverride ?? MODEL,
    maxInFlight: 8,
  });
  const reservation: CounterReservationInput = {
    recordId: reserved.record.recordId,
    artifact: artifact(reserved.record.recordId),
    summary,
    requestContentTextOnly: true,
    bounds: { maxScopeAggregateBytes: 10_000_000, maxCounterCallsPerScope: 4 },
  };
  await store.commitCounterReservation(reservation);
  if (options.counted !== false) {
    await store.update(reserved.record.recordId, { state: 'prepared', counter: COUNTER_EVIDENCE });
  }

  return {
    store,
    storeDir,
    recordId: reserved.record.recordId,
    observation,
    implementations,
    toolsets,
    authority,
    serverCommand,
    toolsetDefinitionRevisions,
  };
}

async function makeRunner(built: Lane, adapter: StubRuntimeAdapter, sent: Envelope[], extra: Partial<TaskRunnerDeps> = {}): Promise<TaskRunner> {
  const storeDir = await tempDir('byok-prepared-runner-store-');
  // This local fake models a configured complete runtime, not physical attestation.
  if (adapter.descriptor.id === 'pi') Object.assign(adapter, {
    detectInstallation: async (context: RuntimeInstallationObservationContext) => {
      expect(Object.keys(context).sort()).toEqual(['authority', 'scope']);
      expect(context.authority).toBe(Object.hasOwn(extra, 'toolImplementationAuthority') ? extra.toolImplementationAuthority : built.authority);
      expect(context.scope).toBe('enabled-top-level');
      return { kind: 'available' as const };
    },
  });
  return new TaskRunner({
    adapters: [adapter],
    workspaceRoot: await tempDir('byok-prepared-workspace-'),
    deviceId: DEVICE_ID,
    send: (envelope) => sent.push(envelope),
    blobClient: unusedBlobClient,
    sessionWorkspaces: new SessionWorkspaceStore(storeDir),
    approvalRegistry: new ApprovalRegistry(),
    storeDir,
    productId: 'prepared-offer-lane',
    agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
    agentHome: new AgentHomeManager({ hostStorageRoot: await tempDir('byok-prepared-home-') }),
    agentSessionHandoffs: new AgentSessionHandoffStore(),
    getMcpToolsets: () => built.toolsets,
    toolImplementationAuthority: built.authority,
    toolImplementationFsProbe: rootOwnedProbe(),
    mcpToolsetToolsProbe: async (serverName) => built.observation[serverName]!,
    inputPreparationLane: {
      store: built.store,
      open: () => built.store.open(),
      runtime: RUNTIME,
      policyRevision: POLICY_REVISION,
      toolsetDefinitionRevisions: built.toolsetDefinitionRevisions,
    },
    ...extra,
  });
}

function preparedOffer(
  taskId: string,
  preparation: InputPreparationOfferBinding,
  seq = 1,
  overrides: Partial<TaskOfferPreparedPayload> = {},
): Envelope {
  return createEnvelope(
    'task.offer_prepared',
    {
      egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      policy: { mode: 'auto', allowTools: [] },
      runtime: 'pi',
      agentRef: AGENT_REF,
      requiredToolsets: [TOOLSET_ID],
      preparation,
      ...overrides,
    },
    { taskId, seq },
  );
}

function reference(built: Lane, overrides: Partial<InputPreparationOfferBinding> = {}): InputPreparationOfferBinding {
  return {
    reference: built.recordId,
    requestDigest: REQUEST_DIGEST,
    artifactDigest: ENVELOPE_DIGEST,
    ...overrides,
  };
}

function declineReason(sent: readonly Envelope[]): string {
  const declined = sent.find((envelope) => envelope.type === 'task.decline');
  if (declined === undefined || declined.type !== 'task.decline') throw new Error('no task.decline was sent');
  return declined.payload.reason;
}

describe('a prepared offer is admitted only by item-by-item equality with its record', () => {
  it('pins the record strictly before the claim, then starts the prepared variant', async () => {
    const built = await lane();
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, MCP_CAPABLE);
    const sent: Envelope[] = [];
    // Observed on the SAME spy the claim goes out on, so the assertion is an
    // order between two real events rather than two independent facts.
    const order: string[] = [];
    const runner = await makeRunner(built, adapter, sent, {
      send: (envelope) => {
        if (envelope.type === 'task.claim') order.push('claim');
        sent.push(envelope);
      },
      beforeClaim: async () => {
        order.push(built.store.get(built.recordId)?.pin === undefined ? 'unpinned-at-claim' : 'pin');
      },
    });

    await runner.handleEnvelope(preparedOffer('task-prepared-ok', reference(built)));

    expect(sent.filter((envelope) => envelope.type === 'task.decline')).toHaveLength(0);
    expect(order).toEqual(['pin', 'claim']);
    expect(built.store.get(built.recordId)?.pin).toMatchObject({ taskId: 'task-prepared-ok' });
    expect(built.store.get(built.recordId)?.pin?.manifestDigest).toMatch(/^[0-9a-f]{64}$/u);

    // The prepared variant, not an instruction start with an empty string.
    expect(adapter.startCalls).toHaveLength(0);
    expect(adapter.preparedStartCalls).toHaveLength(1);
    const launched = adapter.preparedStartCalls[0]!.preparation;
    expect(launched.reference).toEqual({
      scopeId: SCOPE_ID,
      agentRef: AGENT_REF.agentId,
      requestId: REQUEST_ID,
      recordId: built.recordId,
    });
    expect(launched.artifactPath).toBe(built.store.artifactPathOf(built.store.get(built.recordId)!));
    expect(launched.expected.envelopeDigest).toBe(ENVELOPE_DIGEST);
    expect(launched.expected.toolManifestDigest).toBe(TOOL_MANIFEST_DIGEST);
    // The model comes from the durable record, never from the envelope on disk.
    expect(launched.expected.model).toEqual(MODEL);
    expect(launched.expected.binding).toEqual({
      inputIdentity: 'source-r1:source-digest-1',
      runtimeIdentity: inputPreparationRuntimeIdentityString(RUNTIME),
      policyIdentity: POLICY_REVISION,
      profileRevision: AGENT_REF.profileRevision,
    });
    expect(launched.permissionMode).toBe('auto');
    expect(launched.launch).toEqual({ cwd: await trustedCwd() });
    expect(launched.toolImplementations).toEqual(built.implementations);

    await runner.handleEnvelope(createEnvelope('task.cancel', {}, { taskId: 'task-prepared-ok', seq: 2 }));
  });

  it('admits a prepared offer against a record that only exists on disk, on a daemon that has opened nothing yet', async () => {
    // PHASE 1 — one daemon lifetime writes the record, then ends. Its store
    // instance is closed, so its replayed map is gone and every read through it
    // refuses; nothing it held can be mistaken for a durable fact below.
    const built = await lane();
    const storeDir = built.storeDir;
    const recordId = built.recordId;
    const offered = reference(built);
    built.store.close();
    expect(() => built.store.get(recordId)).toThrow(/has not been opened/u);

    // PHASE 2 — a brand-new daemon lifetime over the SAME directory. A fresh
    // `InputPreparationStore`, a fresh once-only open latch standing in for the
    // preparation service's `ensureOpen` (the only production path that used to
    // open the store, reached only from prepare/lookup/cancel), a fresh lane
    // and a fresh `TaskRunner`. No record state crosses the boundary — the
    // phase-1 store is closed and the lane is rebuilt; the daemon-side probe
    // results a real restart would re-derive are reused as inputs. Without the
    // lane's own `open()` the record on disk is invisible to the offer path and
    // the offer declines `preparation_not_found`, non-retryably.
    const restarted = new InputPreparationStore({
      storeDir,
      retentionMs: 60 * 60 * 1000,
      retryHorizonMs: 60 * 60 * 1000,
    });
    let opening: Promise<void> | undefined;
    let openCalls = 0;
    const ensureOpen = (): Promise<void> => (opening ??= (async () => {
      openCalls += 1;
      await restarted.open();
    })());
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, MCP_CAPABLE);
    const sent: Envelope[] = [];
    const runner = await makeRunner(built, adapter, sent, {
      inputPreparationLane: {
        store: restarted,
        open: ensureOpen,
        runtime: RUNTIME,
        policyRevision: POLICY_REVISION,
        toolsetDefinitionRevisions: built.toolsetDefinitionRevisions,
      },
    });

    await runner.handleEnvelope(preparedOffer('task-prepared-restart', offered));

    expect(sent.filter((envelope) => envelope.type === 'task.decline')).toHaveLength(0);
    expect(sent.filter((envelope) => envelope.type === 'task.claim')).toHaveLength(1);
    expect(restarted.get(recordId)?.pin).toMatchObject({ taskId: 'task-prepared-restart' });
    expect(adapter.preparedStartCalls).toHaveLength(1);
    // The expectation the prepared launch carries is the model off the RECORD
    // replayed from disk in phase 2 — equality, not mere presence, because a
    // record that replayed a different model identity would still be present.
    expect(adapter.preparedStartCalls[0]!.preparation.expected.model).toEqual(MODEL);
    // One latch, not one replay per offer: the lane adds no second open authority.
    expect(openCalls).toBe(1);

    await runner.handleEnvelope(createEnvelope('task.cancel', {}, { taskId: 'task-prepared-restart', seq: 2 }));
  });

  it('releases the pin when the Execution reaches a terminal', async () => {
    const built = await lane();
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, MCP_CAPABLE);
    const sent: Envelope[] = [];
    const runner = await makeRunner(built, adapter, sent);

    await runner.handleEnvelope(preparedOffer('task-prepared-terminal', reference(built)));
    expect(built.store.get(built.recordId)?.pin?.taskId).toBe('task-prepared-terminal');

    // A prepared Execution completes only with provider usage observed.
    adapter.sessions[0]!.emit({ type: 'usage', inputTokens: 1_000, outputTokens: 10 });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(sent.some((envelope) => envelope.type === 'task.complete')).toBe(true));
    await vi.waitFor(() => expect(built.store.get(built.recordId)?.pin).toBeUndefined());
  });

  it('reports the prepared observation: initial = the first provider call, max = the largest', async () => {
    const built = await lane();
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, MCP_CAPABLE);
    const sent: Envelope[] = [];
    const runner = await makeRunner(built, adapter, sent);
    await runner.handleEnvelope(preparedOffer('task-prepared-observed', reference(built)));

    // Three provider calls: D, then two tool continuations. The initial call
    // is neither the largest nor the last.
    const session = adapter.sessions[0]!;
    session.emit({ type: 'usage', inputTokens: 1_200, cachedInputTokens: 0, outputTokens: 30 });
    session.emit({ type: 'tool_use', tool: 'mcp__team__list', input: {}, toolCallId: 'c1' });
    session.emit({ type: 'usage', inputTokens: 5_400, cachedInputTokens: 1_200, outputTokens: 20 });
    session.emit({ type: 'usage', inputTokens: 3_100, cachedInputTokens: 3_000, outputTokens: 40 });
    session.emit({ type: 'turn_end' });

    await vi.waitFor(() => expect(sent.some((envelope) => envelope.type === 'task.complete')).toBe(true));
    const completed = sent.find((envelope) => envelope.type === 'task.complete');
    if (completed?.type !== 'task.complete') throw new Error('no task.complete');
    expect(completed.payload.preparedObservation).toEqual({
      requestDigest: REQUEST_DIGEST,
      initialPromptTokens: 1_200,
      maxPromptTokens: 5_400,
    });
  });

  it('fails closed with context_overflow when a call reaches the prepared model\'s context window', async () => {
    const built = await lane();
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, MCP_CAPABLE);
    const sent: Envelope[] = [];
    const runner = await makeRunner(built, adapter, sent);
    await runner.handleEnvelope(preparedOffer('task-prepared-overflow', reference(built)));

    const session = adapter.sessions[0]!;
    session.emit({ type: 'usage', inputTokens: 150_000, outputTokens: 30 });
    // Exactly AT the window is overflow: the boundary is `>=`, not `>`.
    session.emit({ type: 'usage', inputTokens: MODEL.contextWindow, outputTokens: 1 });

    await vi.waitFor(() => expect(sent.some((envelope) => envelope.type === 'task.fail')).toBe(true));
    const failed = sent.find((envelope) => envelope.type === 'task.fail');
    if (failed?.type !== 'task.fail') throw new Error('no task.fail');
    expect(failed.payload.reason.startsWith(`${PREPARED_CONTEXT_OVERFLOW_REASON_PREFIX}:`)).toBe(true);
    expect(failed.payload.retryable).toBe(false);
    expect(failed.payload.preparedObservation).toEqual({
      requestDigest: REQUEST_DIGEST,
      initialPromptTokens: 150_000,
      maxPromptTokens: MODEL.contextWindow,
    });
    // Torn down, not left running, and never reported as success.
    expect(session.interruptCalled).toBe(true);
    expect(sent.some((envelope) => envelope.type === 'task.complete')).toBe(false);
  });

  it('keeps a call just below the context window a success', async () => {
    const built = await lane();
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, MCP_CAPABLE);
    const sent: Envelope[] = [];
    const runner = await makeRunner(built, adapter, sent);
    await runner.handleEnvelope(preparedOffer('task-prepared-below', reference(built)));

    adapter.sessions[0]!.emit({ type: 'usage', inputTokens: MODEL.contextWindow - 1, outputTokens: 1 });
    adapter.sessions[0]!.emit({ type: 'turn_end' });

    await vi.waitFor(() => expect(sent.some((envelope) => envelope.type === 'task.complete')).toBe(true));
    expect(sent.some((envelope) => envelope.type === 'task.fail')).toBe(false);
  });

  it('fails closed with usage_unavailable when a prepared Execution settles with no usage observed', async () => {
    const built = await lane();
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, MCP_CAPABLE);
    const sent: Envelope[] = [];
    const runner = await makeRunner(built, adapter, sent);
    await runner.handleEnvelope(preparedOffer('task-prepared-no-usage', reference(built)));

    adapter.sessions[0]!.emit({ type: 'progress', text: 'an answer nobody can check' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });

    await vi.waitFor(() => expect(sent.some((envelope) => envelope.type === 'task.fail')).toBe(true));
    const failed = sent.find((envelope) => envelope.type === 'task.fail');
    if (failed?.type !== 'task.fail') throw new Error('no task.fail');
    expect(failed.payload.reason.startsWith(`${PREPARED_USAGE_UNAVAILABLE_REASON_PREFIX}:`)).toBe(true);
    expect(failed.payload.retryable).toBe(false);
    expect(failed.payload.preparedObservation).toBeUndefined();
    expect(sent.some((envelope) => envelope.type === 'task.complete')).toBe(false);
  });

  it('fails closed with usage_unavailable when the FIRST call\'s usage is unreadable, never promoting the next call to initial', async () => {
    const built = await lane();
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, MCP_CAPABLE);
    const sent: Envelope[] = [];
    const runner = await makeRunner(built, adapter, sent);
    await runner.handleEnvelope(preparedOffer('task-prepared-unreadable', reference(built)));

    // What `adapters/pi/events.ts` emits for an assistant message_end whose
    // usage block cannot be read: the call is still counted, with no prompt.
    adapter.sessions[0]!.emit({ type: 'usage', outputTokens: 12 });
    adapter.sessions[0]!.emit({ type: 'usage', inputTokens: 4_000, outputTokens: 20 });
    adapter.sessions[0]!.emit({ type: 'turn_end' });

    await vi.waitFor(() => expect(sent.some((envelope) => envelope.type === 'task.fail')).toBe(true));
    const failed = sent.find((envelope) => envelope.type === 'task.fail');
    if (failed?.type !== 'task.fail') throw new Error('no task.fail');
    expect(failed.payload.reason.startsWith(`${PREPARED_USAGE_UNAVAILABLE_REASON_PREFIX}:`)).toBe(true);
    expect(failed.payload.reason).toContain('provider call 1 ');
    expect(failed.payload.preparedObservation).toBeUndefined();
    expect(sent.some((envelope) => envelope.type === 'task.complete')).toBe(false);
  });

  it('fails closed with usage_unavailable when a provider call reports no prompt count', async () => {
    const built = await lane();
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, MCP_CAPABLE);
    const sent: Envelope[] = [];
    const runner = await makeRunner(built, adapter, sent);
    await runner.handleEnvelope(preparedOffer('task-prepared-zero-usage', reference(built)));

    // The Pi runtime leaves a call's usage at zeros when the provider streams
    // none; zero prompt tokens for a non-empty D is not an observation.
    adapter.sessions[0]!.emit({ type: 'usage', inputTokens: 0, outputTokens: 0 });

    await vi.waitFor(() => expect(sent.some((envelope) => envelope.type === 'task.fail')).toBe(true));
    const failed = sent.find((envelope) => envelope.type === 'task.fail');
    if (failed?.type !== 'task.fail') throw new Error('no task.fail');
    expect(failed.payload.reason.startsWith(`${PREPARED_USAGE_UNAVAILABLE_REASON_PREFIX}:`)).toBe(true);
    expect(sent.some((envelope) => envelope.type === 'task.complete')).toBe(false);
  });

  it('admits exactly one of two runners racing one reference; the loser claims nothing and dispatches nothing', async () => {
    const built = await lane();
    const left = new StubRuntimeAdapter('pi', { kind: 'available' }, MCP_CAPABLE);
    const right = new StubRuntimeAdapter('pi', { kind: 'available' }, MCP_CAPABLE);
    const leftSent: Envelope[] = [];
    const rightSent: Envelope[] = [];
    // Two independent runners over ONE durable store — the shape two daemon
    // processes racing the same reference would have, minus the process
    // boundary the store's own serialization is what makes irrelevant.
    const leftRunner = await makeRunner(built, left, leftSent);
    const rightRunner = await makeRunner(built, right, rightSent);

    await Promise.all([
      leftRunner.handleEnvelope(preparedOffer('task-race-left', reference(built))),
      rightRunner.handleEnvelope(preparedOffer('task-race-right', reference(built), 2)),
    ]);

    const claims = [...leftSent, ...rightSent].filter((envelope) => envelope.type === 'task.claim');
    expect(claims).toHaveLength(1);
    const dispatched = left.preparedStartCalls.length + right.preparedStartCalls.length;
    expect(dispatched).toBe(1);

    const loser = left.preparedStartCalls.length === 0 ? leftSent : rightSent;
    expect(declineReason(loser)).toContain('preparation_already_pinned');
    // The winner's pin is the one that survives, and it names the winner.
    const winnerTaskId = claims[0]!.task_id;
    expect(built.store.get(built.recordId)?.pin?.taskId).toBe(winnerTaskId);

    await leftRunner.handleEnvelope(createEnvelope('task.cancel', {}, { taskId: 'task-race-left', seq: 9 }));
    await rightRunner.handleEnvelope(createEnvelope('task.cancel', {}, { taskId: 'task-race-right', seq: 9 }));
  });

  it('reads back the same pin for a redelivered offer rather than taking a second one', async () => {
    const built = await lane();
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, MCP_CAPABLE);
    const sent: Envelope[] = [];
    const runner = await makeRunner(built, adapter, sent);

    await runner.handleEnvelope(preparedOffer('task-prepared-replay', reference(built)));
    const first = built.store.get(built.recordId)?.pin;
    expect(first?.taskId).toBe('task-prepared-replay');

    // The runner's own redelivery guard answers this one, which is exactly the
    // point: a redelivered offer for an already-claimed task never reaches the
    // pin at all, so the record still carries one pin, unchanged.
    await runner.handleEnvelope(preparedOffer('task-prepared-replay', reference(built), 2));
    expect(built.store.get(built.recordId)?.pin).toEqual(first);
    expect(sent.filter((envelope) => envelope.type === 'task.claim')).toHaveLength(1);
    expect(adapter.preparedStartCalls).toHaveLength(1);

    await runner.handleEnvelope(createEnvelope('task.cancel', {}, { taskId: 'task-prepared-replay', seq: 3 }));
  });
});

describe('every compared item declines by its own name, with no claim and no pin', () => {
  interface Case {
    readonly name: string;
    readonly reason: string;
    readonly build: () => Promise<{
      readonly built: Lane;
      readonly offered: InputPreparationOfferBinding;
      /** For the one item that can only drift on the LIVE side. */
      readonly runnerOverrides?: Partial<TaskRunnerDeps>;
    }>;
  }

  const cases: Case[] = [
    {
      name: 'a reference no record on this device answers to',
      reason: 'preparation_not_found',
      build: async () => {
        const built = await lane();
        return { built, offered: reference(built, { reference: 'f'.repeat(64) }) };
      },
    },
    {
      name: 'a record that was never counted',
      reason: 'preparation_not_ready',
      build: async () => {
        const built = await lane({ counted: false });
        return { built, offered: reference(built) };
      },
    },
    {
      name: 'a record whose compiler proved nothing about P(D)',
      reason: 'preparation_not_ready',
      build: async () => {
        const built = await lane({
          summaryOverrides: { projection: { version: 3, kind: 'unknown', digest: PROJECTION.digest }, residual: [] },
        });
        return { built, offered: reference(built) };
      },
    },
    {
      name: 'a record carrying a residual key the Host ruling never covered',
      reason: 'preparation_not_ready',
      build: async () => {
        const built = await lane({
          summaryOverrides: { residual: [{ key: 'stream_options', valueClass: 'object_shape' }] },
        });
        return { built, offered: reference(built) };
      },
    },
    {
      name: 'a record whose accounting ruling was made for another runtime',
      reason: 'preparation_not_ready',
      build: async () => {
        const built = await lane({
          bindingOverrides: {
            accountingPolicyRef: { ...ACCOUNTING_POLICY_REF, ruledRuntime: 'another-runtime@1+abc.1' },
          },
        });
        return { built, offered: reference(built) };
      },
    },
    {
      name: 'a record counted on another device row',
      reason: 'preparation_device_mismatch',
      build: async () => {
        const built = await lane({ bindingOverrides: { deviceId: 'device-somewhere-else' } });
        return { built, offered: reference(built) };
      },
    },
    {
      name: 'a record counted for another Agent',
      reason: 'preparation_agent_mismatch',
      build: async () => {
        const built = await lane({ bindingOverrides: { agentRef: 'agent-somewhere-else' } });
        return { built, offered: reference(built) };
      },
    },
    {
      name: 'a record counted under another profile revision',
      reason: 'preparation_profile_revision_mismatch',
      build: async () => {
        const built = await lane({ bindingOverrides: { profileRevision: 'profile-rev-0' } });
        return { built, offered: reference(built) };
      },
    },
    {
      name: 'a limits-policy revision that moved since the count',
      reason: 'preparation_policy_revision_mismatch',
      build: async () => {
        const built = await lane({ bindingOverrides: { policyRevision: 'limits-policy-r0' } });
        return { built, offered: reference(built) };
      },
    },
    {
      name: 'a re-presented request digest the record does not carry',
      reason: 'preparation_request_digest_mismatch',
      build: async () => {
        const built = await lane();
        return { built, offered: reference(built, { requestDigest: 'request-digest-from-another-request' }) };
      },
    },
    {
      name: 'a re-presented envelope digest the record does not carry',
      reason: 'preparation_artifact_digest_mismatch',
      build: async () => {
        const built = await lane();
        return { built, offered: reference(built, { artifactDigest: 'envelope-digest-from-another-count' }) };
      },
    },
    {
      name: 'a manifest filtered for a mode this offer was not admitted under',
      reason: 'preparation_permission_mode_mismatch',
      build: async () => {
        const built = await lane({ bindingOverrides: { permissionMode: 'confirm' } });
        return { built, offered: reference(built) };
      },
    },
    {
      name: 'an artifact compiled against a native closure this device no longer has',
      reason: 'preparation_runtime_identity_mismatch',
      build: async () => {
        const runtime = { ...RUNTIME, provenanceDigest: 'a'.repeat(64), closureDigest: 'b'.repeat(64), packageVersion: '0.85.1001' };
        // The accounting ruling moves WITH the runtime it was ruled for, so the
        // record stays ready and the only difference left is the one this case
        // is about: the closure the device has now.
        const built = await lane({
          bindingOverrides: {
            runtime,
            accountingPolicyRef: {
              ...ACCOUNTING_POLICY_REF,
              ruledRuntime: inputPreparationRuntimeIdentityString(runtime),
            },
          },
        });
        return { built, offered: reference(built) };
      },
    },
    {
      name: 'a model-visible tool set that is not the counted one',
      reason: 'preparation_tool_set_mismatch',
      build: async () => {
        const built = await lane({
          summaryOverrides: {
            toolImplementationKinds: { [`mcp__${SERVER_NAME}__echo`]: 'attested', [`mcp__${SERVER_NAME}__vanished`]: 'attested' },
          },
        });
        return { built, offered: reference(built) };
      },
    },
    {
      // This item can only drift on the LIVE side, and that is a fact about the
      // contract rather than a limitation of the fixture: a record whose counted
      // kind is anything but `attested` is already unready, so readiness answers
      // first. The real case is a server whose implementation WAS attested when
      // it was counted and cannot be attested now — a replaced binary, a
      // resolver that no longer answers — which is exactly what a host authority
      // that throws produces.
      name: 'a counted tool whose implementation can no longer be attested',
      reason: 'preparation_tool_implementation_kinds_mismatch',
      build: async () => {
        const built = await lane();
        return {
          built,
          offered: reference(built),
          runnerOverrides: {
            toolImplementationAuthority: { resolve: async () => { throw new Error('the install record is gone'); } },
          },
        };
      },
    },
    {
      name: 'a launch directory, definition revision, argv or identity the record did not bind',
      reason: 'preparation_tool_binding_digest_mismatch',
      build: async () => {
        const built = await lane({ summaryOverrides: { toolBindingDigest: 'e'.repeat(64) } });
        return { built, offered: reference(built) };
      },
    },
    {
      name: 'a schema surface the record did not count',
      reason: 'preparation_observation_digest_mismatch',
      build: async () => {
        const built = await lane({ summaryOverrides: { observationDigest: 'a'.repeat(64) } });
        return { built, offered: reference(built) };
      },
    },
  ];

  it.each(cases)('declines $name as $reason', async ({ reason, build }) => {
    const { built, offered, runnerOverrides } = await build();
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, MCP_CAPABLE);
    const sent: Envelope[] = [];
    const runner = await makeRunner(built, adapter, sent, runnerOverrides ?? {});

    await runner.handleEnvelope(preparedOffer(`task-${reason}`, offered));

    expect(declineReason(sent)).toContain(reason);
    const declined = sent.find((envelope) => envelope.type === 'task.decline');
    expect(declined?.type === 'task.decline' ? declined.payload.retryable : undefined).toBe(false);
    expect(sent.filter((envelope) => envelope.type === 'task.claim')).toHaveLength(0);
    expect(adapter.preparedStartCalls).toHaveLength(0);
    expect(adapter.startCalls).toHaveLength(0);
    expect(built.store.get(built.recordId)?.pin).toBeUndefined();
  });

  it('declines a prepared offer on a daemon with no input-preparation lane at all', async () => {
    const built = await lane();
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, MCP_CAPABLE);
    const sent: Envelope[] = [];
    const runner = await makeRunner(built, adapter, sent, { inputPreparationLane: undefined });

    await runner.handleEnvelope(preparedOffer('task-no-lane', reference(built)));

    expect(declineReason(sent)).toContain('preparation_lane_unconfigured');
    expect(sent.filter((envelope) => envelope.type === 'task.claim')).toHaveLength(0);
    expect(built.store.get(built.recordId)?.pin).toBeUndefined();
  });

  it('declines a prepared offer when the preparation store cannot be opened at all', async () => {
    const built = await lane();
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, MCP_CAPABLE);
    const sent: Envelope[] = [];
    // The lane is configured, the record is on disk and counted, and the
    // reference names it. The ONLY thing that fails is the open the lane awaits
    // before its first lookup — the failure a restarted daemon meets when the
    // store directory is unreadable. It must not be reported as
    // `preparation_not_found`: an unopened store and an empty one mean opposite
    // things, and the offer would otherwise be refused for a record that exists.
    const runner = await makeRunner(built, adapter, sent, {
      inputPreparationLane: {
        store: built.store,
        open: () => Promise.reject(new Error('disk gone')),
        runtime: RUNTIME,
        policyRevision: POLICY_REVISION,
        toolsetDefinitionRevisions: built.toolsetDefinitionRevisions,
      },
    });

    await runner.handleEnvelope(preparedOffer('task-store-unavailable', reference(built)));

    const declines = sent.filter((envelope) => envelope.type === 'task.decline');
    expect(declines).toHaveLength(1);
    expect(declineReason(sent).startsWith('preparation_store_unavailable')).toBe(true);
    expect(declineReason(sent)).toContain('disk gone');
    const declined = declines[0]!;
    expect(declined.type === 'task.decline' ? declined.payload.retryable : undefined).toBe(false);
    expect(sent.filter((envelope) => envelope.type === 'task.claim')).toHaveLength(0);
    expect(built.store.get(built.recordId)?.pin).toBeUndefined();
    expect(adapter.preparedStartCalls).toHaveLength(0);
    expect(adapter.startCalls).toHaveLength(0);
  });

  it('declines a prepared offer whose task resolved a launcher-wrapped MCP boundary', async () => {
    const built = await lane();
    // A claude-shaped adapter: an external CLI spawns its servers through a
    // launcher, and a preparation never attests one.
    const adapter = new StubRuntimeAdapter('claude', { kind: 'available' }, MCP_CAPABLE, true, {
      mcpServerLaunch: 'launcher-wrapped',
    });
    const sent: Envelope[] = [];
    const runner = await makeRunner(built, adapter, sent);

    await runner.handleEnvelope(createEnvelope(
      'task.offer_prepared',
      {
        egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      policy: { mode: 'auto', allowTools: [] },
        runtime: 'claude',
        agentRef: AGENT_REF,
        requiredToolsets: [TOOLSET_ID],
        preparation: reference(built),
      },
      { taskId: 'task-launcher-wrapped', seq: 1 },
    ));

    expect(declineReason(sent)).toContain('preparation_launch_attestation_mismatch');
    expect(built.store.get(built.recordId)?.pin).toBeUndefined();
  });
});

describe('ordinary offers are untouched by the prepared lane', () => {
  it('runs a task.offer_for_agent on the instruction lane while a preparation record sits in the store', async () => {
    const built = await lane();
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, MCP_CAPABLE);
    const sent: Envelope[] = [];
    const runner = await makeRunner(built, adapter, sent);

    await runner.handleEnvelope(createEnvelope(
      'task.offer_for_agent',
      {
        instruction: 'an ordinary instruction',
        policy: { mode: 'auto' },
        runtime: 'pi',
        agentRef: AGENT_REF,
        requiredToolsets: [TOOLSET_ID],
      },
      { taskId: 'task-ordinary', seq: 1 },
    ));

    expect(sent.filter((envelope) => envelope.type === 'task.decline')).toHaveLength(0);
    expect(adapter.startCalls).toHaveLength(1);
    // The Agent lane prepends its memory guidance; the offered instruction is
    // still the one that reached the runtime.
    expect(adapter.startCalls[0]?.task.instruction).toContain('an ordinary instruction');
    expect(adapter.preparedStartCalls).toHaveLength(0);
    // Nothing on the ordinary lane touches a preparation record.
    expect(built.store.get(built.recordId)?.pin).toBeUndefined();

    await runner.handleEnvelope(createEnvelope('task.cancel', {}, { taskId: 'task-ordinary', seq: 2 }));
  });
});


describe('prepared daemon-authored message egress', () => {
  const messageEgress = { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 10_000 } as const;

  it.each([false, true])('uses no reserved helper (bins configured: %s), publishes the final text and waits for exact acceptance', async configured => {
    const built = await lane();
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, MCP_CAPABLE);
    const sent: Envelope[] = [];
    const preflight = vi.fn(async () => { throw new Error('prepared must not run helper preflight'); });
    const runner = await makeRunner(built, adapter, sent, {
      tenantId: 'tenant-prepared',
      agentMessageMcpPreflight: preflight,
      ...(configured ? {
        agentMessageMcpBin: { command: '/unused/message', args: [] },
        agentMemoryMcpBin: { command: '/unused/memory', args: [] },
      } : {}),
    });
    const taskId = `prepared-message-${configured}`;
    await runner.handleEnvelope(preparedOffer(taskId, reference(built), 1, { messageEgress }));
    expect(declineReasonOrNone(sent)).toBeUndefined();
    expect(runner.usesAgentEgress(taskId)).toBe(true);
    expect(adapter.preparedStartCalls).toHaveLength(1);
    expect(Object.keys(adapter.preparedStartCalls[0]!.input.mcpServers ?? {})).toEqual([SERVER_NAME]);
    expect(preflight).not.toHaveBeenCalled();
    const session = adapter.sessions[0]!;
    session.emit({ type: 'progress', text: 'earlier reasoning' });
    session.emit({ type: 'tool_use', tool: 'teamserver_echo' });
    const delta = mapPiMessageToAgentEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '**prepared reply**' } });
    expect(delta).toEqual({ type: 'progress', text: '**prepared reply**' });
    session.emit(delta!);
    session.emit({ type: 'usage', inputTokens: 1200, outputTokens: 20 });
    session.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(sent.some(e => e.type === 'agent.message.publish')).toBe(true));
    const published = sent.find(e => e.type === 'agent.message.publish');
    if (published?.type !== 'agent.message.publish') throw new Error('missing message');
    expect(published.payload.body).toBe('**prepared reply**');
    expect(sent.some(e => e.type === 'task.complete')).toBe(false);
    const exact = {
      agentRef: AGENT_REF, sessionRef: published.payload.sessionRef,
      contract: published.payload.contract, messageId: published.payload.messageId,
      cursor: published.payload.cursor, contentHash: published.payload.contentHash,
    };
    await runner.handleEnvelope(createEnvelope('agent.message.disposition', {
      ...exact, outcome: 'held', receiptId: '10000000-0000-4000-8000-000000000001', reasonCode: 'freshness_pending',
    }, { taskId, seq: 2 }));
    expect(sent.some(e => e.type === 'task.complete')).toBe(false);
    await runner.handleEnvelope(createEnvelope('agent.message.disposition', {
      ...exact, outcome: 'accepted', receiptId: '10000000-0000-4000-8000-000000000002',
    }, { taskId, seq: 3 }));
    await vi.waitFor(() => expect(sent.some(e => e.type === 'task.complete')).toBe(true));
    const completed = sent.find(e => e.type === 'task.complete');
    expect(completed?.payload).toMatchObject({ preparedObservation: { requestDigest: REQUEST_DIGEST, initialPromptTokens: 1200, maxPromptTokens: 1200 } });
    const sanitized = sanitizeEgressEnvelope(completed!, DEFAULT_AGENT_EGRESS_POLICY, undefined);
    expect(sanitized).toMatchObject({ ok: true, envelope: { payload: { summary: '[content omitted]', preparedObservation: { requestDigest: REQUEST_DIGEST } } } });
    await runner.shutdownActiveTasks('test complete');
  });

  it.each(['missing', 'unreadable', 'overflow'] as const)('publishes no body when prepared usage is %s', async usage => {
    const built = await lane();
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, MCP_CAPABLE);
    const sent: Envelope[] = [];
    const runner = await makeRunner(built, adapter, sent, { tenantId: 'tenant-prepared' });
    await runner.handleEnvelope(preparedOffer('prepared-no-message', reference(built), 1, { messageEgress }));
    expect(adapter.sessions).toHaveLength(1);
    const session = adapter.sessions[0]!;
    session.emit({ type: 'progress', text: 'must never be published' });
    if (usage === 'unreadable') session.emit({ type: 'usage', outputTokens: 10 });
    if (usage === 'overflow') session.emit({ type: 'usage', inputTokens: MODEL.contextWindow, outputTokens: 10 });
    session.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(sent.some(e => e.type === 'task.fail')).toBe(true));
    expect(sent.some(e => e.type === 'agent.message.publish' || e.type === 'task.complete')).toBe(false);
    await runner.shutdownActiveTasks('test complete');
  });

  it.each([
    [{ mode: 'auto' }, 'policy_inexpressible'],
    [{ mode: 'auto', allowTools: ['read'] }, 'native_tools_uncounted'],
    [{ mode: 'auto', allowTools: [], network: false }, 'policy_inexpressible'],
  ] as const)('refuses native policy %j before pin or claim', async (policy, reason) => {
    const built = await lane();
    const pin = vi.spyOn(built.store, 'pin');
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, MCP_CAPABLE);
    const sent: Envelope[] = [];
    const runner = await makeRunner(built, adapter, sent);
    await runner.handleEnvelope(preparedOffer('native-refused', reference(built), 1, { policy: { mode: policy.mode, ...('allowTools' in policy ? { allowTools: [...policy.allowTools] } : {}), ...('network' in policy ? { network: policy.network } : {}) } }));
    expect(declineReason(sent)).toContain(reason);
    expect(pin).not.toHaveBeenCalled();
    expect(built.store.get(built.recordId)?.pin).toBeUndefined();
    expect(sent.some(e => e.type === 'task.claim')).toBe(false);
    expect(adapter.preparedStartCalls).toHaveLength(0);
    await runner.shutdownActiveTasks('test complete');
  });
});

function declineReasonOrNone(sent: readonly Envelope[]): string | undefined {
  const declined = sent.find(e => e.type === 'task.decline');
  return declined?.type === 'task.decline' ? declined.payload.reason : undefined;
}


it('the real daemon sanitizes prepared terminal envelopes before transport', async () => {
  // Synthetic preparation authority only: reuse the durable ready record and
  // its measured tool identity. Runner, daemon routing, sanitizer and transport
  // all execute normally; this is not a physical installation attestation test.
  const built = await lane({ registryRevision: true, bindingOverrides: { deviceId: 'device-1' } });
  const server = await TestServer.start();
  const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, MCP_CAPABLE);
  Object.assign(adapter, { detectInstallation: async () => ({ kind: 'available' }) });
  vi.spyOn(preparationRuntime, 'resolvePiInputPreparationCompiler').mockResolvedValue({
    runtime: RUNTIME, compile: async () => { throw new Error('fixture is already prepared'); },
  });
  vi.spyOn(implementationIdentity, 'resolveToolImplementationIdentity').mockImplementation(async () => built.implementations[SERVER_NAME]!);
  vi.spyOn(mcpProbe, 'probeMcpServer').mockImplementation(async () => built.observation[SERVER_NAME]!);
  const sanitizer = vi.fn((value: unknown, _context: { envelopeType?: string }) => value);
  const daemon = createDaemonWithAdapters({
    localAgentRelease: { version: '0.0.0-test' }, productName: 'Prepared egress', productId: 'prepared-egress-transport',
    serverUrl: server.url, storeDir: built.storeDir, workspaceRoot: await tempDir('prepared-wire-workspace-'),
    agentHome: { hostStorageRoot: await tempDir('prepared-wire-home-') },
    agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY, sanitizer },
    mcpToolsets: Object.fromEntries(built.toolsets),
    inputPreparation: {
      limits: { revision: POLICY_REVISION, maxRequestBytes: 256000, maxArtifactBytes: 200000,
        maxScopeAggregateBytes: 400000, maxInFlight: 4, maxCounterCallsPerScope: 8,
        counterTimeoutMs: 5000, preparationDeadlineMs: 8000, retentionMs: 60000, retryHorizonMs: 30000 },
      authorityResolver: {
        resolveScope: async () => { throw new Error('no preparation requested'); },
        resolveSource: async () => { throw new Error('no preparation requested'); },
      },
    },
  }, [adapter]);
  try {
    const device = await daemon.pair('prepared-wire-pair');
    expect(device.deviceId).toBe('device-1');
    await daemon.start();
    const taskId = 'prepared-wire-task';
    server.send(preparedOffer(taskId, reference(built), server.nextSeq()));
    await server.waitFor(e => e.type === 'task.started' && e.task_id === taskId);
    adapter.sessions[0]!.emit({ type: 'progress', text: 'private prepared reply' });
    adapter.sessions[0]!.emit({ type: 'usage', inputTokens: 1200, outputTokens: 10 });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    const completed = await server.waitFor(e => e.type === 'task.complete' && e.task_id === taskId);
    expect(completed.payload).toMatchObject({ summary: '[content omitted]', preparedObservation: { requestDigest: REQUEST_DIGEST, initialPromptTokens: 1200, maxPromptTokens: 1200 } });
    expect(sanitizer.mock.calls.some(([, context]) => (context as { envelopeType: string }).envelopeType === 'task.complete')).toBe(true);
    expect(JSON.stringify(server.received)).not.toContain('private prepared reply');
  } finally {
    await daemon.stop(); await server.close(); vi.restoreAllMocks();
  }
});
