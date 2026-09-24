import { DEFAULT_AGENT_EGRESS_POLICY } from '../../daemon/agent-egress-policy';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { AgentHomeLeaseManager, AgentHomeManager, stableAgentHomeOwnerId } from '../../agent-home';
import { AgentSessionHandoffStore } from '../../daemon/agent-session-handoff-store';
import { ApprovalRegistry } from '../../daemon/approvals';
import type { BlobResolver } from '../../daemon/blob-client';
import { buildRuntimeEnv } from '../../daemon/environment';
import { SessionWorkspaceStore } from '../../daemon/session-workspace-store';
import { TaskRunner } from '../../daemon/task-runner';
import {
  InputPreparationStore,
  type InputPreparationArtifact,
} from '../../daemon/input-preparation-store';
import { SUPPORTED_PREPARED_COMPILER_VERSION } from '../../adapters/pi/input-preparation';
import { fingerprintPreparedToolSurface } from '../../daemon/prepared-tool-surface';
import { mcpLaunchAttestation } from '../../daemon/trusted-launch-cwd';
import {
  realToolImplementationFsProbe,
  resolveToolImplementationIdentity,
  type ToolImplementationAuthority,
  type ToolImplementationFsProbe,
} from '../../daemon/tool-implementation-identity';
import {
  INPUT_PREPARATION_ARTIFACT_FORMAT,
  INPUT_PREPARATION_VERSION,
  inputPreparationRuntimeIdentityString,
  preparedToolBindingDigest,
  type InputPreparationAccountingPolicyRefV1,
  type InputPreparationBindingV1,
  type InputPreparationCounterEvidenceV1,
  type InputPreparationModelV1,
  type InputPreparationPinV1,
  type InputPreparationRuntimeIdentityV1,
} from '../../input-preparation';
import type { McpToolsetConfig, RuntimeCapabilities, RuntimeInstallationObservationContext } from '../../types';
import { StubRuntimeAdapter } from './stub-adapter';
import { observationOf } from './mcp-observation';
import { trustedCwd } from './launch-cwd';

/**
 * One daemon LIFETIME of the prepared-offer lane, as its own operating-system
 * process.
 *
 * It exists because every other prepared-offer test reconstructs the "restart"
 * inside one process: a second `InputPreparationStore` over the same directory,
 * built by code that still holds the first one's heap. That proves the replay
 * reads the log, and cannot prove anything about a process that was killed
 * mid-Execution — the pin, the artifact file and the record log all still live
 * in one address space that never died.
 *
 * So this script is spawned, driven over NDJSON on stdin/stdout, and SIGKILLed.
 * A second spawn over the SAME store directory is a real restart: nothing but
 * the bytes on disk crosses the boundary.
 *
 * What is REAL here: the durable `InputPreparationStore` and its record log,
 * the retained artifact, the real `TaskRunner` offer path, the real
 * `admitPreparedOffer` comparison, and the real digest functions on both sides
 * (the record is built with the same `fingerprintPreparedToolSurface` /
 * `preparedToolBindingDigest` calls the admission recomputes with, so nothing
 * is faked into agreement and a formula change breaks this file too).
 *
 * The two deliberate test seams, both of which a real daemon does not need:
 *
 * - `rootOwnedProbe` — an `attested` implementation identity requires a
 *   root-owned, non-writable file (`tool-implementation-identity.ts`), which a
 *   non-root test process cannot create. Only `uid`/`mode` are overridden; the
 *   digest, size and mtime are still measured off the real file on disk, so
 *   both processes measure the same thing.
 * - the lane's `open` latch — a once-only `store.open()`, which is the shape
 *   `create-daemon.ts:2288` wires from `InputPreparationService.open` (replay,
 *   then a reconcile that is a no-op for a `counted` record). The real blocker
 *   to building the whole service through `createDaemonWithAdapters` is the
 *   seam above, not convenience: `DaemonConfig` exposes
 *   `toolImplementationAuthority` (`create-daemon.ts:684`) and NO
 *   `toolImplementationFsProbe` — that override exists only on
 *   `TaskRunnerDeps` (`task-runner.ts:423`) — so `rootOwnedProbe` could not be
 *   injected, and `input-preparation-service.ts:214`
 *   (`.some((kind) => kind !== 'attested')`) would then hold every record this
 *   non-root process can produce unready. Constructing `TaskRunner` directly is
 *   what makes an `attested` record reachable at all, and it does not change
 *   what this file measures: whether the FIRST read on a brand-new process
 *   finds the record a killed process pinned. The cost is that
 *   `create-daemon.ts:2288` and `InputPreparationService.open` are NOT
 *   exercised by this fixture.
 */

interface Config {
  /** The preparation store directory. Shared by every lifetime, and the only thing that crosses a restart. */
  readonly storeDir: string;
  /** The task runner's own store directory. Shared too, so a redelivered task resolves the same workspace. */
  readonly runnerStoreDir: string;
  readonly workspaceRoot: string;
  readonly agentHomeDir: string;
  /** The MCP toolset server file the test created; both lifetimes measure this same path. */
  readonly serverCommand: string;
}

interface RpcRequest {
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

const config = JSON.parse(await fs.readFile(process.argv[2]!, 'utf8')) as Config;

/**
 * One Agent per record. A canonical Agent home admits one mutable writer at a
 * time (`agent-home.ts`), so two Executions that must be live at once — the one
 * whose pin is still held when the process dies, and the one that reached its
 * terminal before it — cannot share an Agent.
 */
const PROFILE_REVISION = 'profile-rev-1';
const agentRefOf = (agentId: string) => ({ agentId, profileRevision: PROFILE_REVISION } as const);
const DEVICE_ID = 'device-prepared-restart';
const SCOPE_ID = 'scope-prepared-restart';
const REQUEST_DIGEST = 'request-digest-restart';
const ENVELOPE_DIGEST = 'envelope-digest-restart';
const TOOL_MANIFEST_DIGEST = 'tool-manifest-digest-restart';
const POLICY_REVISION = 'limits-policy-r1';
const TOOLSET_ID = 'team';
const SERVER_NAME = 'teamserver';
const TOOLSET_REVISION = 'team-definition-r1';
const RETENTION_MS = 60 * 60 * 1000;
const PRODUCT_ID = 'prepared-offer-process-restart';
/**
 * Fixture-local budget for observing one terminal's durable effect. It widens
 * this fixture's own observation window only: no production timeout, default or
 * configuration reads it.
 */
const TERMINAL_WAIT_MS = 20_000;

const MCP_CAPABLE: RuntimeCapabilities = {
  steer: false,
  resume: true,
  approvalInteractive: true,
  mcpToolsets: true,
  permissionModes: ['auto', 'confirm'],
};

/** Synthetic fixture identity: never resolved from the installed fork. */
const RUNTIME: InputPreparationRuntimeIdentityV1 = {
  packageName: '@byok-sdk/pi-coding-agent',
  packageVersion: '0.85.1002',
  tarballIntegrity: 'sha512-'+ 'YQ=='.repeat(1),
  upstreamCommit: 'd981de1229ef899957bbe968bc8dcda02a21f477',
  envelopeFormat: 'pi.session.prepared-input',
  requestFormat: 'pi.openai-completions.prepared',
  provenanceDigest: 'a'.repeat(64), closureDigest: 'b'.repeat(64),
  compilerVersion: SUPPORTED_PREPARED_COMPILER_VERSION,
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

const LANE_ENV: Readonly<Record<string, string>> = Object.freeze(buildRuntimeEnv({
  ambient: process.env,
  requirements: { credentialNames: [] },
}));

const unusedBlobClient: BlobResolver = {
  resolveInstruction: async () => { throw new Error('not used'); },
  uploadArtifact: async () => { throw new Error('not used'); },
};

/** Ownership seam only: digest, size and mtime are still measured off the real file. */
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

const authority: ToolImplementationAuthority = {
  resolve: async () => ({
    kind: 'attested',
    authority: 'host-install-record',
    manifestRevision: 'team@2026.9.1',
    form: 'compiled-executable',
    installPath: config.serverCommand,
    closureDigest: await realToolImplementationFsProbe.digest(config.serverCommand),
    closureKind: 'artifact',
    launchArgv: ['--stdio'],
    launchCwd: '/',
  } as never),
};

const toolsets: ReadonlyMap<string, McpToolsetConfig> = new Map([
  [TOOLSET_ID, { mcpServers: { [SERVER_NAME]: { command: config.serverCommand, args: ['--stdio'] } } }],
]);
const toolsetDefinitionRevisions = (): ReadonlyMap<string, string> => new Map([[TOOLSET_ID, TOOLSET_REVISION]]);

const launchBinding = { cwd: await trustedCwd() } as const;
const attestation = mcpLaunchAttestation(launchBinding);
const implementation = await resolveToolImplementationIdentity(
  authority,
  {
    subject: { kind: 'mcp-server', toolsetId: TOOLSET_ID, serverName: SERVER_NAME },
    command: config.serverCommand,
    args: ['--stdio'],
    launch: attestation,
  },
  LANE_ENV,
  rootOwnedProbe(),
);
if (implementation.kind !== 'attested') {
  throw new Error(`fixture could not attest the toolset server implementation: ${JSON.stringify(implementation)}`);
}
const implementations = Object.freeze({ [SERVER_NAME]: implementation });
const observation = observationOf({ [SERVER_NAME]: ['echo'] }, { toolsetId: TOOLSET_ID });

const store = new InputPreparationStore({
  storeDir: config.storeDir,
  retentionMs: RETENTION_MS,
  retryHorizonMs: RETENTION_MS,
});

/**
 * The lane's single open authority, latched once per PROCESS — the shape
 * `create-daemon.ts` hands the task runner. Nothing else in this script opens
 * the store, so a lifetime that never serves an offer never replays the log.
 */
let opening: Promise<void> | undefined;
let openCalls = 0;
const ensureOpen = (): Promise<void> => (opening ??= (async () => {
  openCalls += 1;
  await store.open();
})());

const adapter = Object.assign(new StubRuntimeAdapter('pi', { kind: 'available' }, MCP_CAPABLE), {
  // Same explicit fake readiness as this fixture's old probe, never a measurement claim.
  detectInstallation: async (context: RuntimeInstallationObservationContext) => {
    assert.deepEqual(Object.keys(context).sort(), ['authority', 'scope']);
    assert.equal(context.authority, authority);
    assert.equal(context.scope, 'enabled-top-level');
    return { kind: 'available' as const };
  },
});
const sent: Envelope[] = [];

await fs.mkdir(config.runnerStoreDir, { recursive: true });
await fs.mkdir(config.workspaceRoot, { recursive: true });
await fs.mkdir(config.agentHomeDir, { recursive: true });

const runner = new TaskRunner({
  adapters: [adapter],
  workspaceRoot: config.workspaceRoot,
  deviceId: DEVICE_ID,
  send: (envelope) => sent.push(envelope),
  blobClient: unusedBlobClient,
  sessionWorkspaces: new SessionWorkspaceStore(config.runnerStoreDir),
  approvalRegistry: new ApprovalRegistry(),
  storeDir: config.runnerStoreDir,
  productId: PRODUCT_ID,
  agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
  // The SAME construction `create-daemon.ts` performs: a lease owner id that is
  // stable across restarts for one store/product identity. Without it a killed
  // lifetime leaves an unreclaimable marker behind and the restart declines on
  // the Agent home instead of ever reaching the preparation record.
  agentHome: new AgentHomeManager({
    hostStorageRoot: config.agentHomeDir,
    leaseManager: new AgentHomeLeaseManager({ ownerId: stableAgentHomeOwnerId(config.runnerStoreDir, PRODUCT_ID) }),
  }),
  agentSessionHandoffs: new AgentSessionHandoffStore(),
  getMcpToolsets: () => toolsets,
  toolImplementationAuthority: authority,
  toolImplementationFsProbe: rootOwnedProbe(),
  mcpToolsetToolsProbe: async (serverName) => observation[serverName]!,
  inputPreparationLane: {
    store,
    open: ensureOpen,
    runtime: RUNTIME,
    policyRevision: POLICY_REVISION,
    toolsetDefinitionRevisions,
  },
});

/** The projection, Host ruling and count a READY record on this device carries. */
const PROJECTION = { version: 3, kind: 'content_complete', digest: 'a'.repeat(64) } as const;
const RESIDUAL = [{ key: 'max_tokens', valueClass: 'bounded_integer' }] as const;

const ACCOUNTING_POLICY_REF: InputPreparationAccountingPolicyRefV1 = {
  revision: 'accounting-r1',
  ruledRuntime: inputPreparationRuntimeIdentityString(RUNTIME),
  ruledTarget: { endpoint: MODEL.baseUrl, modelId: MODEL.id },
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

const COUNTER_EVIDENCE: InputPreparationCounterEvidenceV1 = {
  method: 'fixture.tokenizer',
  methodVersion: '0',
  authority: SYNTHETIC_PROVIDER_COUNT_FOR_LANE_TESTS,
  value: 128,
  coverage: { covered: true },
  providerEvidence: {
    projectionDigest: PROJECTION.digest,
    endpoint: MODEL.baseUrl,
    modelId: MODEL.id,
    asserted: { httpStatus: 200, usageFields: { prompt_tokens: 128 }, responseDigest: 'e'.repeat(64) },
  },
  target: { endpoint: MODEL.baseUrl, modelId: MODEL.id },
  calledAt: '2026-01-01T00:00:00.000Z',
  completedAt: '2026-01-01T00:00:01.000Z',
};

function binding(agentId: string): InputPreparationBindingV1 {
  return {
    scopeId: SCOPE_ID,
    deviceId: DEVICE_ID,
    agentRef: agentId,
    profileId: 'profile-prepared-restart',
    profileRevision: PROFILE_REVISION,
    source: { revision: 'source-r1', digest: 'source-digest-1' },
    target: { endpoint: MODEL.baseUrl, modelId: MODEL.id },
    policyRevision: POLICY_REVISION,
    permissionMode: 'auto',
    runtime: RUNTIME,
    requestDigest: REQUEST_DIGEST,
    accountingPolicyRef: ACCOUNTING_POLICY_REF,
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

/** Write the counted record, with every digest produced by the production functions. */
async function seed(requestId: string, agentId: string): Promise<Record<string, unknown>> {
  const fingerprinted = await fingerprintPreparedToolSurface({
    observation,
    permissionMode: 'auto',
    runtimeIdentity: inputPreparationRuntimeIdentityString(RUNTIME),
    launch: attestation,
    toolsetDefinitionRevisions: { [TOOLSET_ID]: TOOLSET_REVISION },
    implementations,
  });
  if (!fingerprinted.ok) throw new Error(`fixture surface refused: ${fingerprinted.detail}`);
  const toolBindingDigest = preparedToolBindingDigest({
    launch: attestation,
    toolsetDefinitionRevisions: { [TOOLSET_ID]: TOOLSET_REVISION },
    servers: [{
      serverName: SERVER_NAME,
      toolsetId: TOOLSET_ID,
      command: config.serverCommand,
      args: ['--stdio'],
      implementation,
    }],
  });

  await ensureOpen();
  const reserved = await store.reserve({
    key: { scopeId: SCOPE_ID, agentRef: agentId, requestId },
    requestDigest: REQUEST_DIGEST,
    binding: binding(agentId),
    model: MODEL,
    maxInFlight: 8,
  });
  await store.commitCounterReservation({
    recordId: reserved.record.recordId,
    artifact: artifact(reserved.record.recordId),
    summary: {
      requestDigest: REQUEST_DIGEST,
      envelopeDigest: ENVELOPE_DIGEST,
      toolManifestDigest: TOOL_MANIFEST_DIGEST,
      requestBytes: 33,
      projectionBytes: 19,
      projection: PROJECTION,
      residual: [...RESIDUAL],
      observationDigest: fingerprinted.fingerprint.observationDigest,
      toolBindingDigest,
      toolImplementationKinds: fingerprinted.fingerprint.toolImplementationKinds,
    },
    requestContentTextOnly: true,
    bounds: { maxScopeAggregateBytes: 10_000_000, maxCounterCallsPerScope: 4 },
  });
  await store.update(reserved.record.recordId, { state: 'prepared', counter: COUNTER_EVIDENCE });
  return {
    recordId: reserved.record.recordId,
    requestDigest: REQUEST_DIGEST,
    artifactDigest: ENVELOPE_DIGEST,
    observationDigest: fingerprinted.fingerprint.observationDigest,
    toolBindingDigest,
    artifactPath: store.artifactPathOf(store.get(reserved.record.recordId)!),
  };
}

function preparedOffer(
  taskId: string,
  agentId: string,
  reference: string,
  requestDigest: string,
  artifactDigest: string,
  seq: number,
): Envelope {
  return createEnvelope(
    'task.offer_prepared',
    {
      egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      policy: { mode: 'auto', allowTools: [] },
      runtime: 'pi',
      agentRef: agentRefOf(agentId),
      requiredToolsets: [TOOLSET_ID],
      preparation: { reference, requestDigest, artifactDigest },
    },
    { taskId, seq },
  );
}

/** Everything one offer produced, as values the test asserts on by exact name. */
function report(before: number): Record<string, unknown> {
  const produced = sent.slice(before);
  return {
    claims: produced.filter((envelope) => envelope.type === 'task.claim').length,
    declines: produced
      .filter((envelope) => envelope.type === 'task.decline')
      .map((envelope) => (envelope as Extract<Envelope, { type: 'task.decline' }>).payload.reason),
    preparedStarts: adapter.preparedStartCalls.length,
    instructionStarts: adapter.startCalls.length,
    openCalls,
  };
}

/**
 * Drive one started prepared Execution to its terminal and wait for the release.
 *
 * The release is the runner's own `releasePreparationPin`, reached from the
 * terminal path and nothing else — this helper only supplies the usage and `turn_end` a
 * real runtime would emit and then waits for the durable effect.
 */
async function finish(sessionIndex: number, recordId: string): Promise<Record<string, unknown>> {
  // A prepared Execution completes only with provider usage observed.
  adapter.sessions[sessionIndex]!.emit({ type: 'usage', inputTokens: 1_000, outputTokens: 10 });
  adapter.sessions[sessionIndex]!.emit({ type: 'turn_end' });
  const deadline = Date.now() + TERMINAL_WAIT_MS;
  for (;;) {
    const completed = sent.some(
      (envelope) => envelope.type === 'task.complete' && envelope.task_id === adapter.preparedStartCalls[sessionIndex]!.manifest.taskId,
    );
    if (completed && store.get(recordId)?.pin === undefined) return { released: true };
    if (Date.now() >= deadline) {
      return { released: false, pin: store.get(recordId)?.pin ?? null, completed };
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function pinOf(recordId: string): InputPreparationPinV1 | undefined {
  return store.get(recordId)?.pin;
}

function respond(id: number, result?: unknown, error?: unknown): void {
  process.stdout.write(`${JSON.stringify(error === undefined ? { id, result } : { id, error: String(error) })}\n`);
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line) as RpcRequest;
  void (async () => {
    const params = request.params ?? {};
    switch (request.method) {
      case 'seed':
        return seed(String(params.requestId), String(params.agentId));
      case 'offer': {
        const before = sent.length;
        await runner.handleEnvelope(preparedOffer(
          String(params.taskId),
          String(params.agentId),
          String(params.reference),
          String(params.requestDigest),
          String(params.artifactDigest),
          Number(params.seq ?? 1),
        ));
        return report(before);
      }
      case 'finish':
        return finish(Number(params.sessionIndex), String(params.recordId));
      case 'pin':
        return pinOf(String(params.recordId)) ?? null;
      case 'record':
        return store.get(String(params.recordId)) ?? null;
      case 'artifactPath': {
        const record = store.get(String(params.recordId));
        return record === undefined ? null : store.artifactPathOf(record);
      }
      default:
        throw new Error(`unknown prepared-offer restart fixture RPC method ${request.method}`);
    }
  })().then((result) => respond(request.id, result), (error) => respond(request.id, undefined, error));
});

process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid })}\n`);
