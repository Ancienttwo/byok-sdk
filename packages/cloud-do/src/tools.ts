import type { ToolRegistration } from '@earendil-works/pi-durable';
import { CloudDoError } from './errors';
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
  readonly execution: 'read_only_live' | 'skill' | 'scaffold';
  readonly resolverRpc?: string;
  readonly mode?: 'inline' | 'job';
  readonly requiredCapabilities?: readonly string[];
}

export interface CloudDispatchContext {
  readonly identity: SessionIdentity;
  readonly principal: { readonly accountId: string; readonly workspaceId: string; readonly channel: string };
  readonly scopes: readonly string[];
  readonly dispatcherId: string;
}

export interface CloudToolDispatcher {
  readonly tools: readonly CloudToolDefinition[];
  execute(context: CloudDispatchContext, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>;
}

/** Admission does not grant resolver access. The trusted dispatcher checks access at execution. */
export function admitCloudTools(tools: readonly CloudToolDefinition[]): readonly CloudToolDefinition[] {
  const seen = new Set<string>();
  for (const tool of tools) {
    // Native TSchema is opaque. Inspect its JSON Schema fields at admission.
    const schema = tool.parameters as unknown as Record<string, unknown>;
    if (!admittedNames.has(tool.name) || seen.has(tool.name) || typeof tool.description !== 'string'
      || (tool.mode !== undefined && tool.mode !== 'inline') || (tool.requiredCapabilities?.length ?? 0) > 0
      || !schema || schema.type !== 'object' || schema.additionalProperties !== false
      || !schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)
      || (tool.name === 'load_financial_analysis_skill'
        ? tool.execution !== 'skill' || Object.keys(schema.properties).length !== 0
        : tool.execution !== 'read_only_live' || typeof tool.resolverRpc !== 'string' || !tool.resolverRpc.trim())) {
      throw new CloudDoError('CLOUD_TOOL_NOT_AVAILABLE');
    }
    seen.add(tool.name);
  }
  return Object.freeze([...tools]);
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
