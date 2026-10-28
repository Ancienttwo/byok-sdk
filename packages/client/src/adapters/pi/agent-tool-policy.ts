import { isAbsolute } from 'node:path';

/** Pi native tools exposed by the Agent policy. PowerShell is never implicitly selected. */
export type PiBuiltinToolName = 'read' | 'grep' | 'find' | 'ls' | 'edit' | 'write' | 'bash';
export type PiAgentExtensionName = 'web' | 'subagent' | 'todo';

const BUILTINS: readonly PiBuiltinToolName[] = ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash'];
const EXTENSIONS: readonly PiAgentExtensionName[] = ['web', 'subagent', 'todo'];

export interface PiAgentToolPolicy {
  readonly builtinTools: 'inherit' | readonly PiBuiltinToolName[];
  readonly userContext: 'inherit' | 'excluded';
  readonly extensions: 'inherit' | readonly PiAgentExtensionName[];
  readonly skillPaths: readonly string[];
  readonly extensionPaths: readonly string[];
}

export const INHERITED_PI_AGENT_TOOL_POLICY: PiAgentToolPolicy = Object.freeze({
  builtinTools: 'inherit', userContext: 'inherit', extensions: 'inherit',
  skillPaths: Object.freeze([]), extensionPaths: Object.freeze([]),
});

/** One parser owns options validation and the digest-bound helper contract. */
export function parsePiAgentToolPolicy(value: unknown): PiAgentToolPolicy {
  const reject = (message: string): never => { throw new TypeError(`Pi Agent tool policy: ${message}`); };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject('expected an object');
  const raw = value as Record<string, unknown>;
  const keys = ['builtinTools', 'userContext', 'extensions', 'skillPaths', 'extensionPaths'];
  if (Object.keys(raw).length !== keys.length || Object.keys(raw).some(key => !keys.includes(key))) reject('expected exactly builtinTools, userContext, extensions, skillPaths, extensionPaths');
  function selection<T extends string>(input: unknown, allowed: readonly T[], label: string): 'inherit' | readonly T[] {
    if (input === 'inherit') return input;
    if (!Array.isArray(input) || input.some(name => typeof name !== 'string' || !allowed.includes(name as T)) || new Set(input).size !== input.length) {
      return reject(`${label} must be inherit or a unique list of ${allowed.join(', ')}`);
    }
    return Object.freeze([...input]) as readonly T[];
  }
  function paths(input: unknown, label: string): readonly string[] {
    if (!Array.isArray(input) || input.some(path => typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) || new Set(input).size !== input.length) {
      return reject(`${label} must be a unique list of absolute local paths`);
    }
    return Object.freeze([...input]);
  }
  const skillPaths = paths(raw.skillPaths, 'skillPaths');
  const extensionPaths = paths(raw.extensionPaths, 'extensionPaths');
  const builtinTools = selection(raw.builtinTools, BUILTINS, 'builtinTools');
  const extensions = selection(raw.extensions, EXTENSIONS, 'extensions');
  if (raw.userContext !== 'inherit' && raw.userContext !== 'excluded') reject('userContext must be inherit or excluded');
  return Object.freeze({ builtinTools, userContext: raw.userContext, extensions, skillPaths, extensionPaths }) as PiAgentToolPolicy;
}

export function hasPiAgentToolRestrictions(policy: PiAgentToolPolicy): boolean {
  return policy.builtinTools !== 'inherit' || policy.userContext !== 'inherit' || policy.extensions !== 'inherit' || policy.skillPaths.length > 0 || policy.extensionPaths.length > 0;
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
