// `TaskRunner` members that select the runtime adapter and prepare its
// operation for an offer (see ./support.ts for how a member module runs).
import { projectPiMcpEnvironment } from '../../adapters/pi/mcp-environment';
import { awaitAdmission } from '../admission-wait';
import { observeRuntimeDetection } from '../../runtime-detection';
import { freezeRuntimeAdapterDescriptor, type RuntimeAdapter } from '../../types';
import { buildRuntimeEnv } from '../environment';
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
  const requiresAgentMemoryMcp = preparation === undefined && agentRef !== undefined && ordinaryMemoryMcp;
  let pick: PickResult;
  try {
    pick = await this['pickAdapter'](
      requestedRuntime,
      requiredToolsets !== undefined
        || (preparation === undefined && (messageRequirement !== undefined || terminalProjection?.mode === 'result-document'))
        || requiresAgentMemoryMcp || preparedMemorySelected,
      blobAbort.signal,
    );
  } catch (error) {
    if (!admissionWithdrawn()) decline(`runtime detection failed: ${outboundErrorMessage(error)}`, true);
    return undefined;
  }
  if (admissionWithdrawn()) return undefined;
  if (!pick.ok) {
    decline(pick.reason, pick.retryable);
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
  // Scratch-free declines do not own an Execution resource or contend on
  // its store gate. Acquire it at the first consumer; handleOffer retains
  // ownership across this await and releases it on every pre-start exit.
  const scratch = await input.acquireScratch();
  if (admissionWithdrawn()) return undefined;
  // The environment EVERY child process of this task receives: the
  // daemon's own, minus the hard deny (`./environment.ts`). Computed here,
  // before admission, so the admission-time MCP probes below see exactly
  // what the runtime path sees. One computation, both phases.
  const env = { ...buildRuntimeEnv({ ambient: process.env }), ...scratch.env };
  const mcpEnv = pick.descriptor.id === 'pi' ? projectPiMcpEnvironment(env) : env;
  if (resolvedMcp?.ok && agentRef !== undefined && this['deps'].prepareHostTaskContext) {
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
      await this['deps'].agentMessageMcpPreflight(taskMcpServers![AGENT_MESSAGE_MCP_SERVER_NAME]!, mcpEnv);
    } catch (error) {
      decline(`required Agent message helper preflight failed: ${outboundErrorMessage(error)}`, false);
      return undefined;
    }
  }
  if (preparation === undefined && terminalProjection?.mode === 'result-document' && this['deps'].agentResultMcpPreflight !== undefined) {
    try {
      await this['deps'].agentResultMcpPreflight(taskMcpServers![AGENT_RESULT_MCP_SERVER_NAME]!, mcpEnv);
    } catch (error) {
      decline(`required Agent result helper preflight failed: ${outboundErrorMessage(error)}`, false);
      return undefined;
    }
  }
  if (requiresAgentMemoryMcp && agentRef !== undefined && ordinaryMemoryMode !== 'none') {
    try {
      // A `read` task, which includes every reader, is sealed `read` and its helper lists only `memory_recall`.
      taskMcpServers = this['withAgentMemoryMcp'](taskMcpServers, taskId, agentRef, ordinaryMemoryMode, this['deps'].agentMemoryMcpBin!, 'granted');
    } catch (error) {
      decline(`Agent memory MCP configuration failed: ${errorMessage(error)}`, false);
      return undefined;
    }
  }
  // Observe each projected toolset server's OWN tool list before the
  // adapter is asked to admit the task. Both bundled runtimes refuse an
  // MCP tool they were not told to allow, and the only honest source for
  // those names is the server itself — device toolset configuration
  // carries `command`/`args` and nothing more.
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
    const settled = await Promise.allSettled(entries.map(async ([serverName, server]) => {
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
    }));
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
  return { scratch, offered, pick, env, mcpEnv, taskMcpServers, mcpToolsetTools, prepared };
}

export async function pickAdapter(
  this: TaskRunner,
  requestedRuntime: string | undefined,
  requiresMcpToolsets: boolean,
  signal: AbortSignal,
): Promise<PickResult> {
  const allowlist = this['deps'].runtimeAllowlist;

  if (requestedRuntime) {
    if (allowlist && !allowlist.includes(requestedRuntime)) {
      return {
        ok: false,
        reason: `runtime "${requestedRuntime}" is not in this device's runtime allowlist`,
        retryable: false,
      };
    }
    const adapter = this['deps'].adapters.find((a) => a.descriptor.id === requestedRuntime);
    if (!adapter) {
      return { ok: false, reason: `unknown runtime "${requestedRuntime}"`, retryable: false };
    }
    const descriptor = freezeRuntimeAdapterDescriptor(adapter.descriptor);
    if (requiresMcpToolsets && !adapterSupportsMcpToolsets(descriptor)) {
      return {
        ok: false,
        reason: `runtime "${requestedRuntime}" cannot project required MCP toolsets`,
        retryable: false,
      };
    }
    const detected = await awaitAdmission(() => observeRuntimeDetection(adapter, signal), signal);
    // Another device may support this platform, as it may have the runtime installed.
    if (detected.kind === 'refused' && detected.reason === 'platform_unsupported') {
      return { ok: false, reason: `platform_unsupported: runtime "${requestedRuntime}" does not support ${process.platform}`, retryable: true };
    }
    if (detected.kind !== 'available') {
      return {
        ok: false,
        reason: `runtime "${requestedRuntime}" is not installed/available on this device`,
        retryable: true,
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
  for (const adapter of candidates) {
    const descriptor = freezeRuntimeAdapterDescriptor(adapter.descriptor);
    if (requiresMcpToolsets && !adapterSupportsMcpToolsets(descriptor)) continue;
    const detected = await awaitAdmission(() => observeRuntimeDetection(adapter, signal), signal);
    if (detected.kind === 'available') return { ok: true, adapter, descriptor };
  }
  return {
    ok: false,
    reason: requiresMcpToolsets
      ? 'no available runtime on this device can project required MCP toolsets'
      : 'no available runtime on this device',
    retryable: true,
  };
}
