// `TaskRunner` members that select the runtime adapter and prepare its
// operation for an offer (see ./support.ts for how a member module runs).
import { awaitAdmission } from '../admission-wait.js';
import { detectedRuntimeCapabilities, observeAdmissionDetection } from '../../runtime-detection.js';
import { AGENT_USER_CONTEXT_WINDOWS_REMEDY, runtimeUnavailableForDetection, runtimeUnavailableRetryable } from '../../runtime-unavailable.js';
import { harnessSelectionNeedsModel, harnessSupportsTarget, type ExecutionTarget } from '@byok-sdk/protocol';
import { freezeRuntimeAdapterDescriptor, type RuntimeAdapter, type RuntimeAdapterDescriptor } from '../../types.js';
import { RuntimeEnvironmentUnavailableError } from '../../runtime/environment.js';
import type { McpStdioServerConfig } from '../../types.js';
import type { ExecutionScratch } from '../retention/scratch.js';
import { AGENT_MESSAGE_MCP_SERVER_NAME, AGENT_RESULT_MCP_SERVER_NAME } from '../../sdk-reserved-mcp.js';
import { McpAuthorityError, MCP_TOOLSET_PROBE_ADMISSION_TIMEOUT_MS, probeMcpServer } from '../mcp-tools-probe.js';
import { bindMcpToolsetServerObservation, type McpToolsetServerObservation } from '../../mcp/observation.js';
import type { PickResult, OfferPhaseContext, OfferRuntimeInput, RuntimeRequirements } from './support.js';
import { outboundErrorMessage } from '../outbound-error.js';
import { DEFAULT_RUNTIME_PREFERENCE, orderByPreference, unmetRequirements, requirementPhrases, runtimeTaskInput, errorMessage } from './support.js';
import type { TaskRunner } from '../task-runner.js';
import { mcpHubContextFile } from './mcp-contexts.js';
import { MCP_HUB_SERVER_INFO, MCP_HUB_SERVER_NAME, MCP_HUB_TOOLS } from '../../mcp/hub/protocol.js';
import { matchSearchRuntimeEvidence } from '../search-runtime-qualification.js';
import { MCP_SERVER_SUPPORTED_PROTOCOL_VERSIONS } from '../../mcp-server/index.js';

const SEARCH_UNAVAILABLE_REASON = 'MCP search exposure is unavailable on this device for the requested runtime or version';

export async function prepareOfferRuntime(this: TaskRunner, phase: OfferPhaseContext, input: OfferRuntimeInput) {
  const { taskId, decline, admissionWithdrawn } = phase;
  const {
    payload, agentRef, preparation, preparedMemorySelected, ordinaryMemoryMode, ordinaryMemoryMcp, messageRequirement, terminalProjection,
    readerAttempt, requiredToolsets, resolvedMcp, blobAbort,
  } = input;
  const offered = runtimeTaskInput(payload);
  // `auto` leaves the pick to device preference. A native-sessions offer
  // reached here only with an explicit Pi target (selection rule 3).
  const { target } = payload;
  const requiresAgentMemoryMcp = preparation === undefined && ordinaryMemoryMcp;
  const mcpToolApprovals = resolvedMcp?.ok ? resolvedMcp.mcpToolApprovals : undefined;
  const searchNames = Object.keys(resolvedMcp?.ok ? resolvedMcp.searchServers : {});
  const searchExposure = searchNames.length > 0;
  let pick: PickResult;
  try {
    pick = await this['pickAdapter'](
      target,
      {
        mcpToolsets: requiredToolsets !== undefined
          || (preparation === undefined && (messageRequirement !== undefined || terminalProjection?.mode === 'result-document'))
          || requiresAgentMemoryMcp || preparedMemorySelected,
        resume: offered.sessionRef !== undefined,
        preparedInput: preparation !== undefined,
      },
      blobAbort.signal,
      searchExposure,
    );
  } catch (error) {
    if (!admissionWithdrawn()) decline({ reason: `runtime detection failed: ${outboundErrorMessage(error)}`, retryable: true });
    return undefined;
  }
  if (admissionWithdrawn()) return undefined;
  if (!pick.ok) {
    // The open code names the family; the nested cause is the machine-readable
    // classification (#1103 D6). An older server strips the nested field and
    // still records the code.
    decline({
      reason: pick.reason,
      retryable: pick.retryable,
      code: pick.runtimeUnavailable === undefined ? pick.code : 'runtime_unavailable',
      ...(pick.runtimeUnavailable === undefined ? {} : { runtimeUnavailable: pick.runtimeUnavailable }),
    });
    return undefined;
  }
  if (payload.images !== undefined && (preparation !== undefined || pick.descriptor.capabilities.images === false || this['deps'].inputImages === undefined)) {
    decline({ reason: 'selected execution lane does not support image input', code: 'bad_request', retryable: false });
    return undefined;
  }
  if (preparation !== undefined && offered.effort !== undefined) {
    decline({ reason: 'invalid_request: per-task effort cannot change a frozen prepared request', code: 'bad_request', retryable: false });
    return undefined;
  }
  if (payload.nativeSessions !== undefined && pick.descriptor.memoryLane === undefined) {
    decline({ reason: 'native_sessions_unsupported', retryable: false, code: 'native_sessions_unsupported' });
    return undefined;
  }
  if (readerAttempt && pick.descriptor.capabilities.durableLane === true) {
    // Durable Pi binds its replica to the canonical home as its cwd.
    decline({ reason: 'durable Pi runs only in the canonical Agent home; it does not run memory-reader Attempts', retryable: false });
    return undefined;
  }
  if (payload.agentMemoryCommit !== undefined && pick.descriptor.capabilities.durableLane === true) {
    // A durable Attempt runs on after a daemon restart, where the crash
    // recovery of the copy would roll it back while it is alive.
    decline({ reason: 'agentMemoryCommit does not run on the durable lane', retryable: false, code: 'agent_memory_commit_unavailable' });
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
    decline({
      reason: `runtime environment unavailable: ${error.reason}`,
      retryable: false,
      code: 'runtime_unavailable',
      runtimeUnavailable: { cause: 'environment_unavailable', code: error.reason },
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
    if (!admissionWithdrawn()) decline({ reason: `execution scratch unavailable: ${outboundErrorMessage(error)}`, retryable: true });
    return undefined;
  }
  if (admissionWithdrawn()) return undefined;
  const env = { ...runtimeEnv, ...scratch.env };
  const mcpEnv = pick.adapter.projectMcpEnvironment?.(env) ?? env;
  if (resolvedMcp?.ok && this['deps'].prepareHostTaskContext) {
    await this['deps'].prepareHostTaskContext(taskId, blobAbort.signal);
    if (admissionWithdrawn()) return undefined;
  }
  let taskMcpServers: Readonly<Record<string, McpStdioServerConfig>> | undefined;
  let searchServers: Readonly<Record<string, McpStdioServerConfig>> | undefined;
  const innerNonces: string[] = [];
  try {
    // Contract §8.1: the host toolset servers this task will actually run
    // get their per-`(task, server)` nonce here, on the copy handed to the
    // adapter. The admission probe below keeps reading `resolvedMcp.servers`,
    // which stays clean — a `tools/list` handshake is not this task's
    // execution and has no business holding its tool authority.
    if (resolvedMcp?.ok) {
      const projected = await this['withHostToolsetContext'](
        { ...resolvedMcp.servers, ...resolvedMcp.searchServers }, taskId, agentRef, resolvedMcp.toolsetIdByServer, scratch,
        searchExposure ? { names: new Set(searchNames), nonces: innerNonces } : undefined,
      );
      if (searchExposure) {
        const bin = this['deps'].mcpSearch!.bin;
        searchServers = Object.freeze(Object.fromEntries(searchNames.map(name => [name, projected[name]!])));
        taskMcpServers = Object.freeze({
          ...Object.fromEntries(Object.keys(resolvedMcp.servers).map(name => [name, projected[name]!])),
          [MCP_HUB_SERVER_NAME]: Object.freeze({ command: bin.command, args: Object.freeze([...bin.args, mcpHubContextFile(scratch)]) }),
        });
      } else {
        taskMcpServers = projected;
      }
    }
    if (preparation === undefined) {
      taskMcpServers = await this['withAgentMessageMcp'](taskMcpServers, taskId, messageRequirement, scratch);
    }
    taskMcpServers = await this['withAgentResultMcp'](taskMcpServers, taskId, terminalProjection, scratch);
  } catch (error) {
    if (!admissionWithdrawn()) decline({ reason: `execution scratch unavailable: ${outboundErrorMessage(error)}`, retryable: true });
    return undefined;
  }
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
      decline({ reason: `required Agent message helper preflight failed: ${outboundErrorMessage(error)}`, retryable: false });
      return undefined;
    }
  }
  if (preparation === undefined && terminalProjection?.mode === 'result-document' && this['deps'].agentResultMcpPreflight !== undefined) {
    try {
      const preflight = this['deps'].agentResultMcpPreflight;
      await phase.admission.time('resultHelperPreflightMs', () => preflight(taskMcpServers![AGENT_RESULT_MCP_SERVER_NAME]!, mcpEnv));
    } catch (error) {
      decline({ reason: `required Agent result helper preflight failed: ${outboundErrorMessage(error)}`, retryable: false });
      return undefined;
    }
  }
  if (requiresAgentMemoryMcp && ordinaryMemoryMode !== 'none') {
    try {
      // A `read` task, which includes every reader, is sealed `read` and its helper lists only `memory_recall`.
      taskMcpServers = await this['withAgentMemoryMcp'](taskMcpServers, taskId, agentRef, ordinaryMemoryMode, this['deps'].agentMemoryMcpBin!, 'granted', scratch);
    } catch (error) {
      decline({ reason: `Agent memory MCP configuration failed: ${errorMessage(error)}`, retryable: false });
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
      decline({
        reason: `required MCP toolset server "${failure.serverName}" could not be observed: ${outboundErrorMessage(failure.error)}`,
        retryable: !(failure.error instanceof McpAuthorityError),
      });
      return undefined;
    }
    if (searchExposure) {
      observed[MCP_HUB_SERVER_NAME] = bindMcpToolsetServerObservation({
        serverName: MCP_HUB_SERVER_NAME,
        serverInfo: MCP_HUB_SERVER_INFO,
        protocolVersion: MCP_SERVER_SUPPORTED_PROTOCOL_VERSIONS[0]!,
        tools: MCP_HUB_TOOLS.map(({ name, description, inputSchema }) => ({ name, description: description ?? '', inputSchema })),
      }, '@byok-sdk/mcp-hub');
    }
    mcpToolsetTools = Object.freeze(observed);
  }
  const { adapter, descriptor, detected: admitted } = pick;
  let prepared: Awaited<ReturnType<RuntimeAdapter['prepare']>>;
  try {
    prepared = await awaitAdmission(() => adapter.prepare({
      signal: blobAbort.signal,
      offer: offered,
      descriptor,
      detected: admitted,
      requiredToolsetIds: requiredToolsets ?? [],
      ...(taskMcpServers === undefined ? {} : { mcpServers: taskMcpServers }),
      ...(mcpToolsetTools === undefined ? {} : { mcpToolsetTools }),
    }), blobAbort.signal);
  } catch (error) {
    if (!admissionWithdrawn()) decline({ reason: `runtime preparation failed: ${outboundErrorMessage(error)}`, retryable: true });
    return undefined;
  }
  if (admissionWithdrawn()) return undefined;
  if (prepared.kind === 'reject') {
    decline({ reason: prepared.reason, retryable: prepared.retryable,
      ...(prepared.code === undefined ? {} : { code: prepared.code }) });
    return undefined;
  }
  const detected = prepared.detected;
  if (detected?.versionVerdict?.state === 'block') {
    const token = (detected.version ?? detected.versionVerdict.qualifiedVersion).replace(/[\r\n\t]/g, ' ').slice(0, 256);
    decline({
      reason: `runtime "${pick.descriptor.id}" version ${token} is blocked by the device version policy`,
      retryable: runtimeUnavailableRetryable('version_blocked'),
      code: 'runtime_unavailable',
      runtimeUnavailable: { cause: 'version_blocked' },
    });
    return undefined;
  }
  if (searchExposure && pick.searchEvidence?.executableSource !== 'sdk-entry') {
    const searchRows = this['deps'].mcpSearch?.candidates(pick.descriptor) ?? [];
    const verifiedSearch = detected === undefined ? undefined : matchSearchRuntimeEvidence(searchRows, { kind: 'available', ...detected });
    if (verifiedSearch === undefined) {
      decline({ reason: SEARCH_UNAVAILABLE_REASON, retryable: true });
      return undefined;
    }
    pick = { ...pick, searchEvidence: verifiedSearch };
  }
  // `approveTools` is a grant, projected only to a runtime that declares
  // `mcpToolApprovals`; it never takes part in admission or runtime selection.
  return {
    scratch, offered, pick, env, mcpEnv, taskMcpServers, mcpToolsetTools, searchServers, innerNonces,
    mcpToolApprovals: pick.descriptor.mcpToolApprovals === true ? mcpToolApprovals : undefined,
    prepared,
  };
}

function descriptorSupportsTarget(descriptor: RuntimeAdapterDescriptor, target: ExecutionTarget): boolean {
  return harnessSupportsTarget({ id: descriptor.id, capabilities: {
    selectionModes: descriptor.selectionModes,
    defaultModelModes: descriptor.defaultModelModes,
    effort: descriptor.supportsEffort === true,
    serviceTier: descriptor.supportsServiceTier === true,
    serviceTierFallback: descriptor.supportsServiceTierFallback === true,
    byokProviderId: descriptor.byokProviderId,
  } }, target);
}

export async function pickAdapter(
  this: TaskRunner,
  target: ExecutionTarget,
  requirements: RuntimeRequirements,
  signal: AbortSignal,
  searchExposure = false,
): Promise<PickResult> {
  const allowlist = this['deps'].runtimeAllowlist;
  const searchCandidates = (descriptor: RuntimeAdapter['descriptor']) => descriptor.capabilities.durableLane === true
    ? [] : this['deps'].mcpSearch?.candidates(descriptor) ?? [];
  const searchUnavailable: PickResult = {
    ok: false, retryable: true, reason: SEARCH_UNAVAILABLE_REASON,
  };

  const advertised = this['deps'].advertisedHarnesses();

  if (target.lane === 'harness') {
    const requestedRuntime = target.harnessId;
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
    const rows = searchExposure ? searchCandidates(descriptor) : [];
    if (searchExposure && rows.length === 0) return searchUnavailable;

    const harness = advertised.find(harness => harness.id === requestedRuntime);
    if (harness?.capabilities.selectionModes.includes(target.selection.mode)
      && (harnessSelectionNeedsModel(target.selection, harness.capabilities.defaultModelModes)
        || harnessSelectionNeedsModel(target.selection, descriptor.defaultModelModes))) {
      return { ok: false, code: 'invalid_request', reason: 'the requested harness selection requires a model ID', retryable: false };
    }
    if (harness === undefined || !harnessSupportsTarget(harness, target) || !descriptorSupportsTarget(descriptor, target)) {
      const requested = target.serviceTier === undefined ? 'selection or effort' : 'selection or service tier';
      return { ok: false, reason: `runtime "${requestedRuntime}" has no advertised support for the requested ${requested}`, retryable: false };
    }
    const unmet = unmetRequirements(descriptor, requirements);
    if (unmet.length > 0) {
      return {
        ok: false,
        reason: `runtime "${requestedRuntime}" cannot ${requirementPhrases[unmet[0]!]}`,
        retryable: false,
      };
    }
    const detected = await awaitAdmission(() => observeAdmissionDetection(adapter, signal), signal);
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
          : detected.kind === 'refused' && detected.reason === 'agent_user_context_unavailable'
            ? `agent_user_context_unavailable: runtime "${requestedRuntime}" cannot keep user context out on this device. ${AGENT_USER_CONTEXT_WINDOWS_REMEDY}`
            : `runtime "${requestedRuntime}" is not installed/available on this device`,
        retryable: runtimeUnavailableRetryable(runtimeUnavailable.cause),
        runtimeUnavailable,
      };
    }
    if (!this['deps'].advertisedHarnesses().some(harness => harnessSupportsTarget(harness, target))) {
      return { ok: false, reason: `runtime "${requestedRuntime}" is no longer advertised for this target`, retryable: true };
    }
    const searchEvidence = matchSearchRuntimeEvidence(rows, detected);
    if (searchExposure && searchEvidence === undefined) return searchUnavailable;
    return { ok: true, adapter, detected, searchEvidence, descriptor: freezeRuntimeAdapterDescriptor({ ...descriptor, capabilities: detectedRuntimeCapabilities(descriptor, detected) }) };
  }

  const eligible = this['deps'].adapters.filter(({ descriptor }) =>
    (allowlist === undefined || allowlist.includes(descriptor.id)) && descriptorSupportsTarget(descriptor, target)
    && advertised.some(harness => harness.id === descriptor.id && harnessSupportsTarget(harness, target)));
  // M5 batch-3: product decision — pi is the FALLBACK runtime, not the
  // default. Ordered independently of `deps.adapters`'s own construction
  // order (which stays whatever `buildRuntimeAdapters`/the embedder built
  // it as — see `ALL_RUNTIME_IDS`'s doc comment, `create-daemon.ts`).
  const candidates = orderByPreference(eligible, this['deps'].runtimePreference ?? DEFAULT_RUNTIME_PREFERENCE);
  // Count candidates that pass the capability filters. A requirement no
  // candidate can meet is a capability mismatch, not runtime unavailability
  // (#1103 §3.2), so it keeps the free-text decline without a typed cause.
  let capabilityEligible = 0;
  for (const adapter of candidates) {
    const descriptor = freezeRuntimeAdapterDescriptor(adapter.descriptor);
    const rows = searchExposure ? searchCandidates(descriptor) : [];
    if ((searchExposure && rows.length === 0) || unmetRequirements(descriptor, requirements).length > 0) continue;
    capabilityEligible += 1;
    const detected = await awaitAdmission(() => observeAdmissionDetection(adapter, signal), signal);
    // Auto selection skips a blocked candidate and keeps the candidate order.
    if (detected.kind !== 'available' || detected.versionVerdict?.state === 'block'
      || !this['deps'].advertisedHarnesses().some(harness => harness.id === descriptor.id && harnessSupportsTarget(harness, target))) continue;
    const searchEvidence = matchSearchRuntimeEvidence(rows, detected);
    if (!searchExposure || searchEvidence !== undefined) {
      return { ok: true, adapter, detected, searchEvidence, descriptor: freezeRuntimeAdapterDescriptor({ ...descriptor, capabilities: detectedRuntimeCapabilities(descriptor, detected) }) };
    }
  }
  if (searchExposure) return searchUnavailable;
  const phrases = (Object.keys(requirementPhrases) as (keyof RuntimeRequirements)[]).filter((key) => requirements[key]).map((key) => requirementPhrases[key]);
  const capabilityMismatch = phrases.length > 0 && eligible.length > 0 && capabilityEligible === 0;
  return {
    ok: false,
    reason: phrases.length > 0
      ? `no available runtime on this device can ${phrases.join(' and ')}`
      : 'no available runtime on this device',
    retryable: runtimeUnavailableRetryable('none_available'),
    ...(capabilityMismatch ? {} : { runtimeUnavailable: { cause: 'none_available' as const } }),
  };
}
