import type { JsonValue } from '@earendil-works/pi-ai';
import type { ToolRegistration } from '@earendil-works/pi-durable';
import { CloudDoError, type CloudDoErrorCode } from './errors';
import type { SessionIdentity } from './identity';

export const CLOUD_SAFE_REPLAY_TOOLS = Object.freeze([
  'load_financial_analysis_skill', 'resolve_security', 'guarded_screen', 'search_f10_datasets',
  'query_f10_dataset', 'get_security_profile', 'get_quote_snapshot', 'get_corporate_actions',
  'get_financial_statements', 'get_financial_facts', 'get_financial_ratios', 'get_sdi_disclosures',
  'get_directorate', 'get_ownership', 'get_related_warrants',
] as const);

export const CLOUD_LIVE_IPO_TOOLS = Object.freeze([
  'get_ipo_profile', 'search_ipo_calendar', 'get_ipo_timetable', 'get_ipo_offering',
  'get_ipo_allotment', 'screen_ipos', 'compare_ipos',
] as const);

const safeTools: ReadonlySet<string> = new Set(CLOUD_SAFE_REPLAY_TOOLS);
const admittedNames: ReadonlySet<string> = new Set([...CLOUD_SAFE_REPLAY_TOOLS, ...CLOUD_LIVE_IPO_TOOLS]);

export interface CloudToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolRegistration['parameters'];
  readonly execution: 'read_only_live' | 'skill' | 'scaffold' | 'pure';
  readonly resolverRpc?: string;
  readonly mode?: 'inline' | 'job';
  readonly requiredCapabilities?: readonly string[];
}

export interface CloudDispatchContext {
  readonly identity: SessionIdentity;
  readonly principal: { readonly accountId: string; readonly workspaceId: string; readonly channel: string };
  readonly scopes: readonly string[];
  readonly dispatcherId: string;
  readonly call?: { readonly invocationId: string; readonly conversationId: number; readonly toolCallId: string; readonly attempt: number };
  /** Session-local lookup can return a non-terminal invocation. */
  readonly lookup?: (invocationId: string) => {
    toolName: string; state: string; errorCode: string | null; resultJson: string | null;
    conversationId: number; toolCallId: string; settledAt: number | null; settledEventSeq: number | null;
  } | undefined;
}

/** Runtime calls supply these fields. Configuration remains source compatible. */
export interface CloudToolCallContext extends CloudDispatchContext {
  readonly call: NonNullable<CloudDispatchContext['call']>;
  readonly lookup: NonNullable<CloudDispatchContext['lookup']>;
}

export type CloudToolResult = Record<string, unknown> & { modelView?: JsonValue };

export interface CloudToolDispatcher {
  readonly pureTools?: readonly string[];
  readonly domainErrors?: readonly string[];
  readonly modelViews?: boolean;
  readonly tools: readonly CloudToolDefinition[];
  execute(context: CloudDispatchContext, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CloudToolResult>;
}

// Keep the fixed serving-domain vocabulary. Declared codes cannot use these names.
export const CLOUD_DOMAIN_ERROR_CODES: Readonly<Record<string, CloudDoErrorCode>> = Object.freeze({
  NOT_FOUND: 'CLOUD_TOOL_NOT_AVAILABLE', DATA_NOT_LICENSED: 'CLOUD_TOOL_NOT_AVAILABLE',
  DATA_QUALITY_HOLD: 'CLOUD_TOOL_NOT_AVAILABLE', SCOPE_DENIED: 'CLOUD_TOOL_NOT_AVAILABLE',
  TOOL_UNAVAILABLE: 'CLOUD_TOOL_NOT_AVAILABLE', TOOL_ARGUMENT_INVALID: 'CLOUD_TOOL_ARGUMENT_INVALID',
  OUT_OF_RANGE: 'CLOUD_TOOL_ARGUMENT_INVALID', TOO_MANY_ROWS: 'CLOUD_TOOL_ARGUMENT_INVALID',
  AMBIGUOUS_SECURITY: 'CLOUD_TOOL_ARGUMENT_INVALID', SYMBOL_AMBIGUOUS: 'CLOUD_TOOL_ARGUMENT_INVALID',
});

function policyNames(names: readonly string[] | undefined, max: number, pattern: RegExp,
  forbidden: (name: string) => boolean): readonly string[] {
  if (names === undefined) return Object.freeze([]);
  if (!Array.isArray(names) || names.length > max || new Set(names).size !== names.length
    || Array.from(names).some(name => typeof name !== 'string' || !pattern.test(name) || forbidden(name))) {
    throw new CloudDoError('CLOUD_TOOL_NOT_AVAILABLE');
  }
  return Object.freeze([...names].sort());
}

/** Admission does not grant resolver access. The trusted dispatcher checks access at execution. */
export function admitCloudTools(tools: readonly CloudToolDefinition[], pureTools: readonly string[] = []): readonly CloudToolDefinition[] {
  const pure = new Set(policyNames(pureTools, 8, /^[a-z][a-z0-9_]{2,63}$/, name => admittedNames.has(name)));
  const seen = new Set<string>();
  for (const tool of tools) {
    // Native TSchema is opaque. Inspect its JSON Schema fields at admission.
    const schema = tool.parameters as unknown as Record<string, unknown>;
    if (!(tool.execution === 'pure' ? pure.has(tool.name) : admittedNames.has(tool.name)) || seen.has(tool.name) || typeof tool.description !== 'string'
      || (tool.mode !== undefined && tool.mode !== 'inline') || (tool.requiredCapabilities?.length ?? 0) > 0
      || !schema || schema.type !== 'object' || schema.additionalProperties !== false
      || !schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)
      || (tool.execution === 'pure' ? tool.resolverRpc !== undefined : tool.name === 'load_financial_analysis_skill'
        ? tool.execution !== 'skill' || Object.keys(schema.properties).length !== 0
        : tool.execution !== 'read_only_live' || typeof tool.resolverRpc !== 'string' || !tool.resolverRpc.trim())) {
      throw new CloudDoError('CLOUD_TOOL_NOT_AVAILABLE');
    }
    seen.add(tool.name);
  }
  return Object.freeze([...tools]);
}

/** Copy policy values so consumer mutation cannot change an installed policy. */
export function admitCloudDispatcher(dispatcher: CloudToolDispatcher): CloudToolDispatcher {
  const pureTools = policyNames(dispatcher.pureTools, 8, /^[a-z][a-z0-9_]{2,63}$/, name => admittedNames.has(name));
  const domainErrors = policyNames(dispatcher.domainErrors, 64, /^[A-Z][A-Z0-9_]{2,63}$/, name => name.startsWith('CLOUD_') || Object.hasOwn(CLOUD_DOMAIN_ERROR_CODES, name));
  if (dispatcher.modelViews !== undefined && typeof dispatcher.modelViews !== 'boolean') throw new CloudDoError('CLOUD_TOOL_NOT_AVAILABLE');
  const tools = admitCloudTools(dispatcher.tools, pureTools);
  const snapshot = JSON.parse(JSON.stringify({ tools })) as { tools: CloudToolDefinition[] };
  const freeze = (value: unknown): void => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  };
  freeze(snapshot);
  return Object.freeze({ tools: snapshot.tools, pureTools, domainErrors, modelViews: dispatcher.modelViews ?? false,
    execute: dispatcher.execute.bind(dispatcher) });
}

export function dispatcherDigest(dispatcher: CloudToolDispatcher): Promise<string> {
  return digest(canonicalArgs({
    tools: dispatcher.tools.map(({ name, execution, parameters }) => ({ name, execution, parameters })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    pureTools: [...(dispatcher.pureTools ?? [])].sort(), domainErrors: [...(dispatcher.domainErrors ?? [])].sort(),
    modelViews: dispatcher.modelViews ?? false,
  }));
}

/** This policy is stored in the ledger only. Native pi registrations always use unsafe. */
export function replayForTool(name: string): 'safe' | 'unsafe' {
  return safeTools.has(name) ? 'safe' : 'unsafe';
}

function canonical(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || ancestors.has(value)) throw new CloudDoError('CLOUD_REQUEST_INVALID');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new CloudDoError('CLOUD_REQUEST_INVALID');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      // Sparse arrays are not parsed JSON and must not collide with valid arrays.
      if (Object.keys(value).length !== value.length) throw new CloudDoError('CLOUD_REQUEST_INVALID');
      return `[${value.map(item => canonical(item, ancestors)).join(',')}]`;
    }
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], ancestors)}`).join(',')}}`;
  } finally { ancestors.delete(value); }
}

export function canonicalArgs(args: Record<string, unknown>): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new CloudDoError('CLOUD_REQUEST_INVALID');
  return canonical(args, new Set());
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function invocationId(conversationId: number, assistantEntryId: number, toolCallId: string): Promise<string> {
  return digest(JSON.stringify([conversationId, assistantEntryId, toolCallId]));
}

export function argsDigest(toolName: string, args: Record<string, unknown>): Promise<string> {
  return digest(`[${JSON.stringify(toolName)},${canonicalArgs(args)}]`);
}
