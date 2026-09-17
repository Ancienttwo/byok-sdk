import type { PermissionMode } from '@byok-sdk/protocol';
import { compareCodeUnits } from '../util/compare-code-units';
import { McpAuthorityError, type McpStdioServerSpec } from './client';
import {
  GRANTABLE_MCP_SERVER_NAME,
  type McpServerObservation,
  type McpToolsetServerObservation,
} from './observation';

/**
 * One model-visible MCP tool, in vocabulary no runtime owns.
 *
 * This is the single shape both consumers project from: the ordinary Pi
 * extension turns it into a registered Pi tool, and the prepared launch entry
 * turns it into a frozen native tool plus its executor identity. Neither
 * re-derives anything from a server — if the two could each decide what the
 * tool set is, "the prepared session sees what the ordinary session sees"
 * would be a coincidence rather than a property.
 */
export interface McpToolProjection {
  readonly toolsetId: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly description: string;
  readonly inputSchema: unknown;
  /**
   * The operator's classification, carried through verbatim from the
   * observation. Absent when the toolset declares none — see
   * `McpClassifiedToolDescriptor`.
   */
  readonly readOnly?: boolean;
}

/**
 * The name one MCP tool is known by inside a runtime.
 *
 * `mcp__<server>__<tool>` is already the grant vocabulary claude and codex
 * interpolate into their own authority surfaces, so pi registering the same
 * string keeps one name per tool across all three runtimes instead of a
 * per-runtime dialect. Names may contain `__`; {@link projectMcpTools}
 * rejects collisions across the complete observation before either consumer
 * registers tools or builds executor bindings.
 */
export function qualifiedMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/** Shared by runtime grants and prepared/ordinary tool projection. */
function assertUniqueQualifiedNames(
  observation: Readonly<Record<string, McpServerObservation>>,
): void {
  const qualifiedNames = new Set<string>();
  for (const [serverName, server] of Object.entries(observation)) {
    for (const tool of server.tools) {
      const name = qualifiedMcpToolName(serverName, tool.name);
      if (qualifiedNames.has(name)) {
        throw new McpAuthorityError(`duplicate MCP runtime tool name ${JSON.stringify(name)}`);
      }
      qualifiedNames.add(name);
    }
  }
}

/**
 * Order every observed tool into the ONE canonical sequence.
 *
 * `(toolsetId, serverName, toolName)` by UTF-16 code unit — the same ordering
 * `toolset-registry.ts` digests its server list with. Order is load-bearing
 * twice over: it is the order the model is shown the tools in, which feeds the
 * system prompt bytes, and it is the order the frozen tool manifest binds. Two
 * machines that disagreed about it would produce two different prepared
 * digests for the same toolset.
 */
export function projectMcpTools(
  observation: Readonly<Record<string, McpToolsetServerObservation>>,
): readonly McpToolProjection[] {
  assertUniqueQualifiedNames(observation);
  const projections: McpToolProjection[] = [];
  for (const [serverName, server] of Object.entries(observation)) {
    if (!GRANTABLE_MCP_SERVER_NAME.test(serverName)) {
      throw new McpAuthorityError(
        `observed MCP server name ${JSON.stringify(serverName)} cannot be expressed as a runtime tool name`,
      );
    }
    for (const tool of server.tools) {
      projections.push(Object.freeze({
        toolsetId: server.toolsetId,
        serverName,
        toolName: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.readOnly === undefined ? {} : { readOnly: tool.readOnly }),
      }));
    }
  }
  return Object.freeze(projections.sort((left, right) =>
    compareCodeUnits(left.toolsetId, right.toolsetId)
    || compareCodeUnits(left.serverName, right.serverName)
    || compareCodeUnits(left.toolName, right.toolName)));
}

/**
 * The names-only view of one observation, for the runtimes that pre-grant by
 * name.
 *
 * Derived, never stored: the full descriptors are the observation, and a
 * separately-carried name list would be a second authority that could disagree
 * with the schemas the model was actually shown.
 */
export function mcpToolsetToolNames(
  observation: Readonly<Record<string, McpServerObservation>>,
): Readonly<Record<string, readonly string[]>> {
  assertUniqueQualifiedNames(observation);
  const names: Record<string, readonly string[]> = {};
  for (const [serverName, server] of Object.entries(observation)) {
    names[serverName] = Object.freeze(server.tools.map((tool) => tool.name).sort(compareCodeUnits));
  }
  return Object.freeze(names);
}

/** A policy-filtered observation, or the one reason the policy is inexpressible. */
export type McpObservationPolicyResolution =
  | { readonly ok: true; readonly observation: Readonly<Record<string, McpToolsetServerObservation>> }
  | { readonly ok: false; readonly reason: string };

/**
 * Which permission modes reduce a toolset to its read-only tools.
 *
 * A POSITIVE set, decided per mode by an exhaustive `switch`, so a mode added
 * to `PERMISSION_MODES` later fails to compile here instead of silently
 * inheriting whichever half of an "everything except `auto`" test it happened
 * to land on.
 *
 * - `readonly`: narrows. The mode's entire contract is that the task runs
 *   autonomously without mutating anything.
 * - `plan`: narrows. `daemon/policy.ts` defines plan as the mode that produces
 *   NO side effects, so it may not be wider than `readonly`.
 * - `auto`: does not narrow. Every observed tool, no classification needed.
 * - `confirm`: does not narrow. A human answers each call, so the gate is per
 *   call rather than per tool set — and claude deliberately emits no MCP
 *   pre-grant at all under confirm (`adapters/claude/permission-mapping.ts`),
 *   so narrowing here would only refuse an unclassified toolset a human was
 *   going to adjudicate anyway.
 */
function narrowsToReadOnlyTools(permissionMode: PermissionMode): boolean {
  switch (permissionMode) {
    case 'readonly':
    case 'plan':
      return true;
    case 'auto':
    case 'confirm':
      return false;
    default: {
      const exhaustive: never = permissionMode;
      return exhaustive;
    }
  }
}

/**
 * Reduce one observation to exactly the tools a permission mode allows — the
 * ONE place any runtime's toolset policy is decided.
 *
 * Exactly two modes narrow, and they are named positively rather than as
 * "everything except `auto`" — see {@link narrowsToReadOnlyTools} for which
 * and why. A narrowing mode keeps only the tools the device's operator
 * classified read-only (`McpToolsetConfig.readOnlyTools`), and the excluded
 * tools are excluded everywhere at once: they are not granted to claude or
 * codex, not registered with pi, and not fingerprinted into a prepared
 * manifest. There is no "register it and refuse the call" state, because a
 * tool the model can see is a tool the model will spend tokens attempting.
 *
 * A non-narrowing mode returns the observation unchanged and demands NO
 * classification at all: refusing it for a missing `readOnlyTools` would
 * refuse a toolset whose every tool that mode would have allowed.
 *
 * Two refusals, both fail-closed, and both only under a narrowing mode:
 *
 * - A tool with no classification at all means the toolset carries no
 *   declaration. That is an INEXPRESSIBLE policy, not a small one, so it is
 *   refused by name instead of resolving to an empty toolset — an operator who
 *   has not classified a toolset should hear about the missing field, not
 *   watch the task run with nothing.
 * - A server left with no read-only tool would hand the task a server it may
 *   not call at all. It was offered authority it cannot use, so the whole
 *   admission is refused rather than half-satisfied.
 *
 * Applied to servers, not to reserved SDK helpers: those never enter an
 * observation, and each carries the fixed grant its own protocol defines.
 */
export function filterMcpObservationForPolicy(
  observation: Readonly<Record<string, McpToolsetServerObservation>>,
  permissionMode: PermissionMode,
): McpObservationPolicyResolution {
  if (!narrowsToReadOnlyTools(permissionMode)) return { ok: true, observation };
  const filtered: Record<string, McpToolsetServerObservation> = {};
  for (const serverName of Object.keys(observation).sort(compareCodeUnits)) {
    const server = observation[serverName]!;
    const unclassified = server.tools.filter((tool) => tool.readOnly === undefined);
    if (unclassified.length > 0) {
      return {
        ok: false,
        reason: `permission mode ${JSON.stringify(permissionMode)} needs a per-tool read/mutation classification`
          + ` for MCP toolset ${JSON.stringify(server.toolsetId)}, and this device's mcpToolsets configuration`
          + ` declares no McpToolsetConfig.readOnlyTools for it`
          + ` (server ${JSON.stringify(serverName)} tool(s) [${unclassified.map((tool) => JSON.stringify(tool.name)).join(', ')}]);`
          + ` a classification is never inferred from tool names, descriptions, schemas,`
          + ` or a server's own readOnlyHint`,
      };
    }
    const tools = server.tools.filter((tool) => tool.readOnly === true);
    if (tools.length === 0) {
      return {
        ok: false,
        reason: `MCP toolset server ${JSON.stringify(serverName)} exposes no tool classified read-only,`
          + ` so permission mode ${JSON.stringify(permissionMode)} leaves this task nothing it may call on it`,
      };
    }
    filtered[serverName] = Object.freeze({ ...server, tools: Object.freeze(tools) });
  }
  return { ok: true, observation: Object.freeze(filtered) };
}

/** The task-scoped authority one Pi launch is handed: what to run, and exactly which tools exist. */
export interface McpLaunchProjection {
  readonly mcpServers: Readonly<Record<string, McpStdioServerSpec>>;
  /** Canonically ordered by {@link projectMcpTools}. */
  readonly tools: readonly McpToolProjection[];
}
