// `TaskRunner` members that select the runtime adapter and prepare its
// operation for an offer (see ./support.ts for how a member module runs).
import { projectPiMcpEnvironment } from '../../adapters/pi/mcp-environment';
import { awaitAdmission } from '../admission-wait';
import { observeRuntimeDetection } from '../../runtime-detection';
import { runtimeUnavailableForDetection, runtimeUnavailableRetryable } from '../../runtime-unavailable';
import { freezeRuntimeAdapterDescriptor, type RuntimeAdapter } from '../../types';
import { RuntimeEnvironmentUnavailableError } from '../../runtime/environment';
import type { ExecutionScratch } from '../retention/scratch';
import { AGENT_MESSAGE_MCP_SERVER_NAME, AGENT_RESULT_MCP_SERVER_NAME } from '../../sdk-reserved-mcp';
import { McpAuthorityError, MCP_TOOLSET_PROBE_ADMISSION_TIMEOUT_MS, probeMcpServer } from '../mcp-tools-probe';
import { bindMcpToolsetServerObservation, type McpToolsetServerObservation } from '../../mcp/observation';
import type { PickResult, OfferPhaseContext, OfferRuntimeInput } from './support';
import { isKnownRuntimeId, DEFAULT_RUNTIME_PREFERENCE, orderByPreference, adapterSupportsMcpToolsets, runtimeTaskInput, errorMessage, outboundErrorMessage } from './support';
import type { TaskRunner } from '../task-runner';

export async function prepareOfferRuntime(this: TaskRunner, phase: OfferPhaseContext, input: OfferRuntimeInput) {
  const { taskId, decline, admissionWithdrawn } = phase;
  const {
    payload, agentRef, preparation, preparedMemorySelected, ordinaryMemoryMode, ordinaryMemoryMcp, messageRequirement, terminalProjection,
    readerAttempt, requiredToolsets, resolvedMcp, blobAbort,
  } = input;
  const offered = runtimeTaskInput(payload);
  const requestedRuntime = payload.harnessId ?? payload.dispatchSelection?.runtimeId ?? payload.runtime;
  const requiresAgentMemoryMcp = preparation === undefined && ordinaryMemoryMcp;
  const mcpToolApprovals = resolvedMcp?.ok ? resolvedMcp.mcpToolApprovals : undefined;
  let pick: PickResult;
  try {
    pick = await this['pickAdapter'](
      requestedRuntime,
      requiredToolsets !== undefined
        || (preparation === undefined && (messageRequirement !== undefined || terminalProjection?.mode === 'result-document'))
        || requiresAgentMemoryMcp || preparedMemorySelected,
      blobAbort.signal,
      mcpToolApprovals !== undefined,
    );
  } catch (error) {
    if (!admissionWithdrawn()) decline(`runtime detection failed: ${outboundErrorMessage(error)}`, true);
    return undefined;
  }
  if (admissionWithdrawn()) return undefined;
  if (!pick.ok) {
    // The open code names the family; the nested cause is the machine-readable
    // classification (#1103 D6). An older server strips the nested field and
    // still records the code.
    decline(pick.reason, pick.retryable, pick.runtimeUnavailable === undefined ? undefined : 'runtime_unavailable', pick.runtimeUnavailable);
    return undefined;
  }
  if (readerAttempt && pick.descriptor.capabilities.durablePi === true) {
    // Durable Pi binds its replica to the canonical home as its cwd.
    decline('durable Pi runs only in the canonical Agent home; it does not run memory-reader Attempts', false);
    return undefined;
  }
  if (!isKnownRuntimeId(pick.descriptor.id) && !(this['deps'].getServerCapabilities?.() ?? []).includes('custom-harness')) {
    decline('server does not support the selected custom harness identity', false);
    return undefined;
  }
  // The environment EVERY child process of this task receives, under the
  // adapter's own policy (`../../runtime/environment.ts`, #1095). Computed here, before
  // admission, so the admission-time MCP probes below see exactly what the
  // runtime path sees. One computation, both phases. A failed login-shell
  // capture leaves no environment to run in: a scratch-free decline.
  let runtimeEnv: Record<string, string>;
  try {
    ({ env: runtimeEnv } = await pick.adapter.runtimeEnvironment());
  } catch (error) {
    if (!(error instanceof RuntimeEnvironmentUnavailableError)) throw error;
    decline(`runtime environment unavailable: ${error.reason}`, false, 'runtime_unavailable', {
      cause: 'environment_unavailable',
      code: error.reason,
    });
    return undefined;
  }
  if (admissionWithdrawn()) return undefined;
  // Scratch-free declines do not own an Execution resource or contend on
  // its store gate. Acquire it at the first consumer; handleOffer retains
  // ownership across this await and releases it on every pre-start exit.
  //
  // A scratch root that cannot create an Execution is an admission failure,
  // not a runner crash (#1217): the offer never reached claim, so the only
  // truthful wire outcome is a retryable decline. A cancel/shutdown that
  // landed during the await keeps its own reason through
  // `admissionWithdrawn()` instead.
  let scratch: ExecutionScratch;
  try {
    scratch = await input.acquireScratch();
  } catch (error) {
    if (!admissionWithdrawn()) decline(`execution scratch unavailable: ${outboundErrorMessage(error)}`, true);
    return undefined;
  }
  if (admissionWithdrawn()) return undefined;
  const env = { ...runtimeEnv, ...scratch.env };
  const mcpEnv = pick.descriptor.id === 'pi' ? projectPiMcpEnvironment(env) : env;
  if (resolvedMcp?.ok && this['deps'].prepareHostTaskContext) {
    await this['deps'].prepareHostTaskContext(taskId, blobAbort.signal);
    if (admissionWithdrawn()) return undefined;
  }
  // Contract §8.1: the host toolset servers this task will actually run
  // get their per-`(task, server)` nonce here, on the copy handed to the
  // adapter. The admission probe below keeps reading `resolvedMcp.servers`,
  // which stays clean — a `tools/list` handshake is not this task's
  // execution and has no business holding its tool authority.
  let taskMcpServers = resolvedMcp?.ok
    ? this['withHostToolsetContext'](resolvedMcp.servers, taskId, agentRef, resolvedMcp.toolsetIdByServer)
    : undefined;
  if (preparation === undefined) {
    taskMcpServers = this['withAgentMessageMcp'](taskMcpServers, taskId, messageRequirement);
  }
  taskMcpServers = this['withAgentResultMcp'](taskMcpServers, taskId, terminalProjection);
  // Only the adapters that register projected toolset tools themselves
  // need the daemon's `tools/list` observation (see
  // `RuntimeAdapterDescriptor.requiresMcpToolsetToolObservation`). An
  // adapter whose runtime lists the tools itself must not pay a probe per
  // projected server on every offer.
  const needsToolsetObservation = resolvedMcp?.ok === true
    && pick.descriptor.requiresMcpToolsetToolObservation === true;
  if (preparation === undefined && messageRequirement !== undefined && this['deps'].agentMessageMcpPreflight !== undefined) {
    try {
      const preflight = this['deps'].agentMessageMcpPreflight;
      await phase.admission.time('messageHelperPreflightMs', () => preflight(taskMcpServers![AGENT_MESSAGE_MCP_SERVER_NAME]!, mcpEnv));
    } catch (error) {
      decline(`required Agent message helper preflight failed: ${outboundErrorMessage(error)}`, false);
      return undefined;
    }
  }
  if (preparation === undefined && terminalProjection?.mode === 'result-document' && this['deps'].agentResultMcpPreflight !== undefined) {
    try {
      const preflight = this['deps'].agentResultMcpPreflight;
      await phase.admission.time('resultHelperPreflightMs', () => preflight(taskMcpServers![AGENT_RESULT_MCP_SERVER_NAME]!, mcpEnv));
    } catch (error) {
      decline(`required Agent result helper preflight failed: ${outboundErrorMessage(error)}`, false);
      return undefined;
    }
  }
  if (requiresAgentMemoryMcp && ordinaryMemoryMode !== 'none') {
    try {
      // A `read` task, which includes every reader, is sealed `read` and its helper lists only `memory_recall`.
      taskMcpServers = this['withAgentMemoryMcp'](taskMcpServers, taskId, agentRef, ordinaryMemoryMode, this['deps'].agentMemoryMcpBin!, 'granted');
    } catch (error) {
      decline(`Agent memory MCP configuration failed: ${errorMessage(error)}`, false);
      return undefined;
    }
  }
  // Adapters that register tools need the server's observed schemas. Host
  // approval names do not establish tool existence and never trigger this
  // probe for a runtime that owns its own discovery.
  //
  // All servers are probed CONCURRENTLY under one shared deadline
  // (`MCP_TOOLSET_PROBE_ADMISSION_TIMEOUT_MS`, see its own doc comment):
  // Downloads belong to this offer; a serial loop would
  // multiply the timeout by the server count and let one unresponsive
  // command delay `task.cancel`/`task.approve` for minutes. Every probe
  // kills its own child when the deadline expires, so a decline never
  // leaves a probed server running.
  //
  // Retryability follows the KIND of failure, not the phase: a spawn
  // error, an early exit, or a timeout may well succeed later and stays
  // retryable, exactly like the workspace-busy declines below. A server
  // that answered and reported an ungrantable tool name has stated a
  // permanent fact about itself — re-offering the task would probe the
  // same command and get the same answer forever, so that declines
  // non-retryably and names the server and the tool.
  let mcpToolsetTools: Record<string, McpToolsetServerObservation> | undefined;
  if (needsToolsetObservation) {
    const probe = this['deps'].mcpToolsetToolsProbe ?? probeMcpServer;
    const entries = Object.entries(resolvedMcp!.servers);
    const settled = await phase.admission.time('toolsetProbeMs', () => Promise.allSettled(entries.map(async ([serverName, server]) => {
      const observation = await probe(serverName, server, {
        label: `MCP toolset server "${serverName}"`,
        timeoutMs: MCP_TOOLSET_PROBE_ADMISSION_TIMEOUT_MS,
        env: mcpEnv,
      });
      if (observation.tools.length === 0) throw new Error('tools/list reported no tools');
      // The toolset id is the registry's fact about this server, joined
      // on here so the adapter receives one self-describing record instead
      // of an observation plus a parallel map that could disagree with it.
      const toolsetId = resolvedMcp!.toolsetIdByServer.get(serverName);
      if (toolsetId === undefined) {
        throw new Error('observed a server that belongs to no projected toolset');
      }
      return bindMcpToolsetServerObservation(observation, toolsetId);
    })));
    const observed: Record<string, McpToolsetServerObservation> = {};
    let failure: { serverName: string; error: unknown } | undefined;
    for (let index = 0; index < entries.length; index += 1) {
      const serverName = entries[index]![0];
      const result = settled[index]!;
      if (result.status === 'fulfilled') observed[serverName] = result.value;
      else if (failure === undefined) failure = { serverName, error: result.reason };
    }
    if (failure !== undefined) {
      decline(
        `required MCP toolset server "${failure.serverName}" could not be observed: ${outboundErrorMessage(failure.error)}`,
        !(failure.error instanceof McpAuthorityError),
      );
      return undefined;
    }
    mcpToolsetTools = Object.freeze(observed);
  }
  let prepared: Awaited<ReturnType<RuntimeAdapter['prepare']>>;
  try {
    prepared = await awaitAdmission(() => pick.adapter.prepare({
      signal: blobAbort.signal,
      offer: offered,
      descriptor: pick.descriptor,
      requiredToolsetIds: requiredToolsets ?? [],
      ...(taskMcpServers === undefined ? {} : { mcpServers: taskMcpServers }),
      ...(mcpToolsetTools === undefined ? {} : { mcpToolsetTools }),
    }), blobAbort.signal);
  } catch (error) {
    if (!admissionWithdrawn()) decline(`runtime preparation failed: ${outboundErrorMessage(error)}`, true);
    return undefined;
  }
  if (admissionWithdrawn()) return undefined;
  if (prepared.kind === 'reject') {
    decline(prepared.reason, prepared.retryable);
    return undefined;
  }
  return { scratch, offered, pick, env, mcpEnv, taskMcpServers, mcpToolsetTools, mcpToolApprovals, prepared };
}

export async function pickAdapter(
  this: TaskRunner,
  requestedRuntime: string | undefined,
  requiresMcpToolsets: boolean,
  signal: AbortSignal,
  requiresMcpToolApprovals = false,
): Promise<PickResult> {
  const allowlist = this['deps'].runtimeAllowlist;

  if (requestedRuntime) {
    if (allowlist && !allowlist.includes(requestedRuntime)) {
      return {
        ok: false,
        reason: `runtime "${requestedRuntime}" is not in this device's runtime allowlist`,
        retryable: runtimeUnavailableRetryable('runtime_not_allowed'),
        runtimeUnavailable: { cause: 'runtime_not_allowed' },
      };
    }
    const adapter = this['deps'].adapters.find((a) => a.descriptor.id === requestedRuntime);
    if (!adapter) {
      return {
        ok: false,
        reason: `unknown runtime "${requestedRuntime}"`,
        retryable: runtimeUnavailableRetryable('runtime_not_configured'),
        runtimeUnavailable: { cause: 'runtime_not_configured' },
      };
    }
    const descriptor = freezeRuntimeAdapterDescriptor(adapter.descriptor);
    if (requiresMcpToolsets && !adapterSupportsMcpToolsets(descriptor)) {
      return {
        ok: false,
        reason: `runtime "${requestedRuntime}" cannot project required MCP toolsets`,
        retryable: false,
      };
    }
    if (requiresMcpToolApprovals && descriptor.mcpToolApprovals !== true) {
      return { ok: false, reason: `runtime "${requestedRuntime}" cannot enforce Host MCP tool approvals`, retryable: false };
    }
    const detected = await awaitAdmission(() => observeRuntimeDetection(adapter, signal), signal);
    // A Host-configured block is the one diagnostic verdict that changes
    // admission (#1103): decline this runtime non-retryably before claim.
    if (detected.kind === 'available' && detected.versionVerdict?.state === 'block') {
      const token = (detected.version ?? detected.versionVerdict.qualifiedVersion).replace(/[\r\n\t]/g, ' ').slice(0, 256);
      return {
        ok: false,
        reason: `runtime "${requestedRuntime}" version ${token} is blocked by the device version policy`,
        retryable: runtimeUnavailableRetryable('version_blocked'),
        runtimeUnavailable: { cause: 'version_blocked' },
      };
    }
    // Another device may support this platform, as it may have the runtime
    // installed. The display text stays as it was; the cause is the typed
    // classification, never parsed back out of the text.
    if (detected.kind !== 'available') {
      const runtimeUnavailable = runtimeUnavailableForDetection(detected);
      return {
        ok: false,
        reason: detected.kind === 'refused' && detected.reason === 'platform_unsupported'
          ? `platform_unsupported: runtime "${requestedRuntime}" does not support ${process.platform}`
          : `runtime "${requestedRuntime}" is not installed/available on this device`,
        retryable: runtimeUnavailableRetryable(runtimeUnavailable.cause),
        runtimeUnavailable,
      };
    }
    return { ok: true, adapter, descriptor };
  }

  const eligible = allowlist ? this['deps'].adapters.filter((a) => allowlist.includes(a.descriptor.id)) : this['deps'].adapters;
  // M5 batch-3: product decision — pi is the FALLBACK runtime, not the
  // default. Ordered independently of `deps.adapters`'s own construction
  // order (which stays whatever `buildDefaultAdapters`/the embedder built
  // it as — see `ALL_RUNTIME_IDS`'s doc comment, `create-daemon.ts`).
  const candidates = orderByPreference(eligible, this['deps'].runtimePreference ?? DEFAULT_RUNTIME_PREFERENCE);
  // Count candidates that pass the capability filters. A requirement no
  // candidate can meet is a capability mismatch, not runtime unavailability
  // (#1103 §3.2), so it keeps the free-text decline without a typed cause.
  let capabilityEligible = 0;
  for (const adapter of candidates) {
    const descriptor = freezeRuntimeAdapterDescriptor(adapter.descriptor);
    if (requiresMcpToolsets && !adapterSupportsMcpToolsets(descriptor)) continue;
    if (requiresMcpToolApprovals && descriptor.mcpToolApprovals !== true) continue;
    capabilityEligible += 1;
    const detected = await awaitAdmission(() => observeRuntimeDetection(adapter, signal), signal);
    // Auto selection skips a blocked candidate and keeps the candidate order.
    if (detected.kind === 'available' && detected.versionVerdict?.state !== 'block') return { ok: true, adapter, descriptor };
  }
  const capabilityMismatch = (requiresMcpToolsets || requiresMcpToolApprovals) && eligible.length > 0 && capabilityEligible === 0;
  return {
    ok: false,
    reason: requiresMcpToolApprovals
      ? 'no available runtime on this device can enforce Host MCP tool approvals'
      : requiresMcpToolsets
      ? 'no available runtime on this device can project required MCP toolsets'
      : 'no available runtime on this device',
    retryable: runtimeUnavailableRetryable('none_available'),
    ...(capabilityMismatch ? {} : { runtimeUnavailable: { cause: 'none_available' as const } }),
  };
}
