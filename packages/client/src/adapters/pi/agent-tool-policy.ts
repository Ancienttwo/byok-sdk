/** Pi native tools exposed by the Agent policy. PowerShell is never implicitly selected. */
export type PiBuiltinToolName = 'read' | 'grep' | 'find' | 'ls' | 'edit' | 'write' | 'bash';
export type PiAgentExtensionName = 'web' | 'subagent' | 'todo';

const BUILTINS: readonly PiBuiltinToolName[] = ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash'];
const EXTENSIONS: readonly PiAgentExtensionName[] = ['web', 'subagent', 'todo'];

export interface PiAgentToolPolicy {
  readonly builtinTools: 'inherit' | readonly PiBuiltinToolName[];
  readonly userContext: 'inherit' | 'excluded';
  readonly extensions: 'inherit' | readonly PiAgentExtensionName[];
}

export const INHERITED_PI_AGENT_TOOL_POLICY: PiAgentToolPolicy = Object.freeze({
  builtinTools: 'inherit', userContext: 'inherit', extensions: 'inherit',
});

/** One parser owns options validation and the digest-bound helper contract. */
export function parsePiAgentToolPolicy(value: unknown): PiAgentToolPolicy {
  const reject = (message: string): never => { throw new TypeError(`Pi Agent tool policy: ${message}`); };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject('expected an object');
  const raw = value as Record<string, unknown>;
  const keys = ['builtinTools', 'userContext', 'extensions'];
  if (Object.keys(raw).length !== keys.length || Object.keys(raw).some(key => !keys.includes(key))) reject('expected exactly builtinTools, userContext, extensions');
  function selection<T extends string>(input: unknown, allowed: readonly T[], label: string): 'inherit' | readonly T[] {
    if (input === 'inherit') return input;
    if (!Array.isArray(input) || input.some(name => typeof name !== 'string' || !allowed.includes(name as T)) || new Set(input).size !== input.length) {
      return reject(`${label} must be inherit or a unique list of ${allowed.join(', ')}`);
    }
    return Object.freeze([...input]) as readonly T[];
  }
  const builtinTools = selection(raw.builtinTools, BUILTINS, 'builtinTools');
  const extensions = selection(raw.extensions, EXTENSIONS, 'extensions');
  if (raw.userContext !== 'inherit' && raw.userContext !== 'excluded') reject('userContext must be inherit or excluded');
  return Object.freeze({ builtinTools, userContext: raw.userContext, extensions }) as PiAgentToolPolicy;
}

export function hasPiAgentToolRestrictions(policy: PiAgentToolPolicy): boolean {
  return policy.builtinTools !== 'inherit' || policy.userContext !== 'inherit' || policy.extensions !== 'inherit';
}

/** Exclusions survive transcript restoration; modifiers retain independently admitted extension/MCP tools. */
export function piAgentNativeToolOptions(policy: PiAgentToolPolicy): { tools?: string[]; excludeTools?: string[] } {
  if (policy.builtinTools === 'inherit') return {};
  const excluded = [...BUILTINS, 'powershell'].filter(name => !(policy.builtinTools as readonly string[]).includes(name));
  return {
    tools: [...excluded.map(name => `-${name}`), ...policy.builtinTools.map(name => `+${name}`)],
    excludeTools: excluded,
  };
}
