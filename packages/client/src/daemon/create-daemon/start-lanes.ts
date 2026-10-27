import { computeCapabilities } from './support';
import { AgentHomeProjectionCompletionClient } from '../agent-home-projection-client';
import { createProviderProvisioningNoticeProcessor } from '../provider-provisioning';
import { createAgentMemoryIntentProcessor } from '../agent-memory-intent';
import { InputPreparationCompletionClient } from '../input-preparation-completion-client';
import { createRemoteInputPreparationHandler } from '../input-preparation-remote';
import { BlobClient } from '../blob-client';
import { SealedTasks } from '../sealed-task';
import type { DaemonScope } from './scope';
import type { StartRun } from './start-run';

/**
 * The second stage of `runStartUnderLease` (#926), synchronous: computes the
 * hello capabilities and builds the notice processors, the input-preparation
 * lane, the sealed upload client and this start's sealed-task lane.
 */
export function composeStartLanes(daemonScope: DaemonScope, run: Pick<StartRun, 'agentMemoryIntentBackend' | 'record' | 'blobClient' | 'sealedRun'>) {
  const {
    adapters, config, agentHomeManager, agentContentReadPolicies, daemonState, observer,
    inputPreparationLimits, sealIdentityOf,
  } = daemonScope;
  const { agentMemoryIntentBackend, record, blobClient, sealedRun } = run;
  const capabilities = computeCapabilities(
    adapters,
    config.agentHome !== undefined,
    agentHomeManager?.supportsTaskFreeProjection() === true,
    config.agentEgress !== undefined,
    agentContentReadPolicies,
    config.piByokLauncher !== undefined,
    daemonState.inputPreparationService !== undefined,
    config.providerProvisioning !== undefined,
    agentMemoryIntentBackend !== undefined,
  );
  const agentHomeProjectionCompletion = agentHomeManager?.supportsTaskFreeProjection() === true
    ? new AgentHomeProjectionCompletionClient({
        serverUrl: config.serverUrl,
        auth: daemonState.auth,
        tenantId: record.tenantId,
        deviceId: record.deviceId,
      })
    : undefined;

  const processProviderProvisioningNotice = createProviderProvisioningNoticeProcessor({
    tenantId: record.tenantId,
    deviceId: record.deviceId,
    handler: config.providerProvisioning,
  });
  // Constructed unconditionally so a stale notice is answered with a closed
  // reason before any fetch: no transport → `transport_unconfigured`; no
  // proven backend (the capability was not advertised) →
  // `filesystem_unavailable`. Either keeps the mailbox row and the cursor.
  const processAgentMemoryIntentNotice = createAgentMemoryIntentProcessor({
    tenantId: record.tenantId,
    deviceId: record.deviceId,
    transport: config.agentMemoryIntents,
    homes: agentHomeManager,
    backend: agentMemoryIntentBackend,
    onIntegrity: (event) => observer.noteAgentMemoryIntentIntegrity(event),
  });

  /**
   * C07 G4-remote. Constructed UNCONDITIONALLY, unlike the projection client
   * above: a daemon with no `inputPreparation` section still has to be able
   * to answer a stale or mis-targeted envelope with a typed
   * `input_preparation_unconfigured` completion. Throwing instead would
   * freeze this device's redelivery cursor behind a row it can never
   * discharge, which is a worse failure than reporting the truth.
   *
   * That completion is ACCEPTED by cloud: the completion route asserts no
   * device capability (`cloud.ts`'s `completeInputPreparationFromStores`),
   * precisely so this rejection is recordable by a device that never
   * advertised `agent-input-preparation-v9`. The flag remains the admission
   * gate on `enqueueInputPreparation`.
   *
   * The handler takes the service directly, so a preparation runs IN-PROCESS.
   * Nothing here touches the local control socket — see
   * `input-preparation-remote.ts` for why that is the point.
   */
  daemonState.inputPreparationStatusAbort = new AbortController();
  const inputPreparationCompletion = new InputPreparationCompletionClient({
    serverUrl: config.serverUrl,
    auth: daemonState.auth,
    tenantId: record.tenantId,
    deviceId: record.deviceId,
    statusReadSignal: daemonState.inputPreparationStatusAbort.signal,
  });
  const handleRemoteInputPreparation = createRemoteInputPreparationHandler({
    deviceId: record.deviceId,
    service: daemonState.inputPreparationService,
    limits: inputPreparationLimits,
    // The two absences are different facts and the Host is told which:
    // "this daemon does not do preparation" versus "its native closure did
    // not verify". Neither is ever widened into a compiled artifact.
    ...(config.inputPreparation !== undefined && daemonState.inputPreparationService === undefined
      ? { unavailableReason: daemonState.inputPreparationLaneOff?.code ?? 'runtime_identity_unavailable' }
      : {}),
    completion: inputPreparationCompletion,
    // openStartRun assigned it; TypeScript's narrowing ends at that call.
    signal: daemonState.blobLifecycleAbort!.signal,
    resolveBlobText: (blobRef, signal) => blobClient.resolveInstruction(blobRef, { signal }),
  });

  capabilities.push('custom-harness');
  // #654 E2d-3: sealed task content needs this run's verified member. The
  // object exists before the restart replay, and its keyring holds no key
  // until the member is ready, so a recovered sealed terminal is sealed or
  // one of the closed plaintext forms (decision 74e). The member stays bound
  // after a loss: a sealed task must never fall back to plaintext output.
  daemonState.sealedUploadAbort = new AbortController();
  daemonState.sealedUploads = new BlobClient(config.serverUrl, daemonState.auth, { signal: daemonState.sealedUploadAbort.signal });
  const opened = new SealedTasks({
    keyring: {
      scopeCategories: async (scopeId) => sealedRun.sealedMember?.scopeCategories(scopeId),
      openingKey: async (scope) => sealedRun.sealedMember?.openingKey(scope),
      acceptHeader: async (header) => await sealedRun.sealedMember?.acceptHeader(header) === true,
      sealingKey: async (scopeId, minEpoch) => sealedRun.sealedMember?.sealingKey(scopeId, minEpoch),
    },
    tenantId: record.tenantId,
    deviceId: record.deviceId,
    blobs: {
      download: (ref) => blobClient.downloadBlob(ref, { signal: daemonState.blobLifecycleAbort?.signal }),
      upload: (ciphertext) => daemonState.sealedUploads!.uploadArtifact(ciphertext, 'application/octet-stream'),
    },
    // Between sessions, and while a start is under way, the next
    // session's flags are unknown. Once the daemon stopped, halted or
    // crashed with no start under way, no session will advertise any.
    serverCapabilities: () => {
      if (daemonState.lifecycle.phase === 'halted' || daemonState.lifecycle.phase === 'crashed') return [];
      if (daemonState.lifecycle.phase === 'running') return daemonState.connection?.isOpen() === true ? daemonState.connection.getServerCapabilities() : undefined;
      return daemonState.startInProgress ? undefined : [];
    },
  });
  sealedRun.sealedTasks = opened;
  daemonState.latestSealedTasks = opened;
  daemonState.sealedOutputSettled = () => opened.settled();
  daemonState.activateSealedTasks = (keyring) => {
    if (sealedRun.sealedMember !== undefined) return;
    sealedRun.sealedMember = keyring;
    sealedRun.ownSealIdentity = sealIdentityOf(record, keyring);
  };
  // Only the next run receives this run's points, so a run with no member leaves none.
  daemonState.retireSealedMember = () => { daemonState.carriedFreshness = sealedRun.sealedMember?.retire(); };
  daemonState.latestSealIdentity = () => sealIdentityOf(record, sealedRun.sealedMember);
  // Contract §8.1 / §8.3: the device-level capability string is NOT computed
  // here. It is the one flag whose answer depends on a deployment fact this
  // daemon has not read yet at this point in `start()`, so it is added (and
  // removed again) by `applyCapabilityDeclaration` against this exact array —
  // `ConnectionManager` rebuilds `conn.hello` from it, so a later change
  // reaches the server through `refreshHello()`. Reset to "no declaration
  // read" first: a restart must not inherit the previous run's answer about a
  // deployment it has not spoken to yet.
  daemonState.deploymentDeclaration = undefined;
  daemonState.helloCapabilities = capabilities;
  return {
    capabilities, agentHomeProjectionCompletion, processProviderProvisioningNotice,
    processAgentMemoryIntentNotice, handleRemoteInputPreparation, opened,
  };
}

export type StartLanes = ReturnType<typeof composeStartLanes>;
