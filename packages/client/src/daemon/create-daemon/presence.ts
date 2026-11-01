import { declares, E2EE_MEMBER_CAPABILITY, E2EE_MEMBER_KEM_EPOCH_CAPABILITY, fetchCapabilityDeclaration, PRESENCE_HINTS_CAPABILITY } from '../capabilities-client';
import { HOST_MCP_TASK_CONTEXT_CAPABILITY, SEALED_PAYLOAD_CAPABILITY, SEALED_PAYLOAD_V2_CAPABILITY, PROTOCOL_VERSION } from '@byok-sdk/protocol';
import type { CapabilityDeclaration } from '@byok-sdk/core';
import type { CapabilityFlag } from '@byok-sdk/protocol';
import { PresencePublisher } from '../presence-publisher';
import type { DaemonScope } from './scope';

/** Capability discovery, the hello capabilities and the presence producer (#926). */

/**
 * Contract §8.1 / §8.3: is the task lane's capability gate actually in place
 * on this daemon, right now?
 *
 * BOTH halves, and nothing else counts as either:
 *
 * 1. This daemon can sign at all — `deviceAssertion.audiences` is configured
 *    and non-empty. A daemon that issues no assertions cannot serve a lane
 *    made of them.
 * 2. This daemon has READ a deployment declaration that names
 *    `host-mcp-task-context`. Not "assumed", not "the route 404'd so probably
 *    old": an unread declaration leaves `deploymentDeclaration` undefined and
 *    this answer `false`.
 *
 * Every consumer of the lane asks THIS function — the `conn.hello`
 * advertisement, the nonce injection, and the `task_assertion.issue` RPC — so
 * the three cannot disagree about whether the lane is open.
 *
 * §8.3 is the reason the false answer is a plain refusal: a missing
 * capability makes the task lane `unavailable`, never a reason to fall back
 * to a device assertion, which this lane does not accept in any case.
 */
export function taskContextCapabilityAvailable(daemonScope: DaemonScope): boolean {
  const { deviceAssertionAudiences, daemonState } = daemonScope;
  if (deviceAssertionAudiences === undefined) return false;
  if (daemonState.deploymentDeclaration === undefined) return false;
  return declares(daemonState.deploymentDeclaration, HOST_MCP_TASK_CONTEXT_CAPABILITY);
}

/**
 * Records what the latest discovery pass read (or, on failure, that it read
 * nothing) and republishes the `conn.hello` advertisement if that changed the
 * device-level half of §8.1's gate.
 *
 * The device capability string is advertised only after the deployment-level
 * declaration has actually been read, so the FIRST `conn.hello` of a run
 * never claims the task lane — discovery runs off the connection path and has
 * not answered yet. That ordering is deliberate rather than tolerated: a
 * daemon that advertised the capability before reading the declaration would
 * be promising a lane whose other half it has not seen, which is the same
 * assumption ADR-010 forbids a client to make about an unread deployment.
 * `refreshHello()` is how the answer reaches the server once it exists.
 */
export function applyCapabilityDeclaration(daemonScope: DaemonScope, declaration: CapabilityDeclaration | undefined): void {
  const { daemonState, setHelloCapability, taskContextCapabilityAvailable, logMember } = daemonScope;
  daemonState.deploymentDeclaration = declaration;
  const taskContext = setHelloCapability(HOST_MCP_TASK_CONTEXT_CAPABILITY, taskContextCapabilityAvailable());
  // #654 E2d-e5, E5b-2: only a verified member on a Host with the E2EE member routes and their KEM epoch rules.
  const member = daemonState.deviceMember?.session !== undefined && declaration !== undefined && declares(declaration, E2EE_MEMBER_CAPABILITY);
  const kemEpoch = member && declares(declaration!, E2EE_MEMBER_KEM_EPOCH_CAPABILITY);
  if (member && !kemEpoch) logMember(`the Host does not declare ${E2EE_MEMBER_KEM_EPOCH_CAPABILITY}; E2EE stays off until the Host is upgraded`);
  const sealedPayload = setHelloCapability(SEALED_PAYLOAD_CAPABILITY, kemEpoch);
  // #1045: the same member seals Agent messages and memory evidence, and matches a sealed disposition.
  const sealedPayloadV2 = setHelloCapability(SEALED_PAYLOAD_V2_CAPABILITY, kemEpoch);
  if (taskContext || sealedPayload || sealedPayloadV2) daemonState.connection?.refreshHello();
  if (kemEpoch) daemonState.deviceMember!.checkKemRotation();
}

/** Whether the advertisement changed. */
export function setHelloCapability(daemonScope: DaemonScope, flag: CapabilityFlag, wanted: boolean): boolean {
  const { daemonState } = daemonScope;
  const index = daemonState.helloCapabilities.indexOf(flag);
  if (wanted === (index !== -1)) return false;
  if (wanted) daemonState.helloCapabilities.push(flag);
  else daemonState.helloCapabilities.splice(index, 1);
  return true;
}

/** Arm before connection.start(); its first open callback starts the read. */
export function startPresenceProducer(daemonScope: DaemonScope): void {
  const { daemonState } = daemonScope;
  daemonState.presenceDiscovery = new AbortController();
}

export async function waitForHostTaskContext(daemonScope: DaemonScope, taskId: string, signal: AbortSignal): Promise<void> {
  const {
    deviceAssertionAudiences, capabilityDiscoveryTimeoutMs, daemonState,
    taskContextCapabilityAvailable, observer,
  } = daemonScope;
  if (deviceAssertionAudiences === undefined || signal.aborted) return;
  let timedOut = false;
  let interrupt!: () => void;
  const interrupted = new Promise<void>((resolve) => { interrupt = resolve; });
  const timer = setTimeout(() => { timedOut = true; interrupt(); }, capabilityDiscoveryTimeoutMs);
  signal.addEventListener('abort', interrupt, { once: true });
  try {
    // A reconnect replaces the pass. Re-read that identity after each await,
    // under this ONE offer deadline, rather than admitting on an old answer.
    while (!signal.aborted && !timedOut && daemonState.presenceDiscoveryPass?.outcome === 'pending') {
      await Promise.race([daemonState.presenceDiscoveryPass.completion, interrupted]);
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', interrupt);
  }
  if (signal.aborted || daemonState.shuttingDown) return;
  if (!taskContextCapabilityAvailable()) {
    const outcome = timedOut ? 'timeout' : daemonState.presenceDiscoveryPass?.outcome;
    const reason = outcome === 'read' ? 'capability_undeclared'
      : outcome === 'timeout' ? 'capability_discovery_timeout'
      : outcome === 'failed' ? 'capability_discovery_failed'
      : 'capability_discovery_unavailable';
    observer.noteDeviceAssertion({ result: 'denied', lane: 'task', taskId, reason });
  }
}

/** Each connection open starts a fresh, bounded declaration read. */
export function runPresenceDiscovery(daemonScope: DaemonScope): void {
  const {
    daemonState, applyCapabilityDeclaration, capabilityDiscoveryTimeoutMs, config, toolsetRegistry,
    localAgentRelease, presenceCadence,
  } = daemonScope;
  const lifecycle = daemonState.presenceDiscovery;
  if (!lifecycle || lifecycle.signal.aborted) return;
  daemonState.presenceDiscoveryPass?.controller.abort();
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  lifecycle.signal.addEventListener('abort', abort, { once: true });
  const pass = {
    controller,
    completion: Promise.resolve(),
    outcome: 'pending' as 'pending' | 'read' | 'failed' | 'timeout' | 'aborted',
  };
  daemonState.presenceDiscoveryPass = pass;
  // A previous connection's declaration cannot authorize a new offer while
  // this deployment is still unknown. Existing nonces are never re-minted.
  applyCapabilityDeclaration(undefined);
  daemonState.presencePublisher?.stop();
  let rejectAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new Error('capability discovery aborted'));
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  const timer = setTimeout(() => {
    pass.outcome = 'timeout';
    controller.abort();
  }, capabilityDiscoveryTimeoutMs);
  pass.completion = (async () => {
    try {
      const declaration = await Promise.race([
        fetchCapabilityDeclaration(config.serverUrl, { signal: controller.signal }), aborted,
      ]);
      if (controller.signal.aborted || daemonState.presenceDiscoveryPass !== pass) return;
      applyCapabilityDeclaration(declaration);
      pass.outcome = 'read';
      if (declares(declaration, PRESENCE_HINTS_CAPABILITY)) {
        daemonState.presencePublisher ??= new PresencePublisher({
          serverUrl: config.serverUrl,
          auth: daemonState.auth,
          getConfiguredToolsets: () => toolsetRegistry.snapshot().configuredToolsets,
          clientVersion: localAgentRelease.version,
          protocolVersions: [PROTOCOL_VERSION],
          runtimes: daemonState.detectedRuntimeFacts,
          runtimeUnavailable: daemonState.detectedRuntimeUnavailable,
          ...presenceCadence,
          onDegraded: (reason) => console.warn(`[byok/client] ${reason}`),
        });
        daemonState.presencePublisher.start();
      }
    } catch (err) {
      if (daemonState.presenceDiscoveryPass !== pass || lifecycle.signal.aborted) {
        pass.outcome = 'aborted';
        return;
      }
      if (pass.outcome !== 'timeout') pass.outcome = 'failed';
      applyCapabilityDeclaration(undefined);
      console.warn(
        `[byok/client] capability discovery ${pass.outcome}; presence publishing and the task assertion lane stay off until the next reconnect: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', rejectAbort);
      lifecycle.signal.removeEventListener('abort', abort);
    }
  })();
}
