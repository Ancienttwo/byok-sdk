import { isAbsolute } from 'node:path';

/** Resource loading is independent of the task's tool authorization mode. */
export interface PiAgentResources {
  readonly agentUserContext: 'inherit' | 'excluded';
  readonly skillPaths: readonly string[];
  readonly extensionPaths: readonly string[];
}

export const INHERITED_PI_AGENT_RESOURCES: PiAgentResources = Object.freeze({
  agentUserContext: 'inherit', skillPaths: Object.freeze([]), extensionPaths: Object.freeze([]),
});

/** Shared by local adapter admission and the digest-bound RPC host boundary. */
export function parsePiAgentResources(value: {
  agentUserContext: unknown; skillPaths: unknown; extensionPaths: unknown;
}): PiAgentResources {
  if (value.agentUserContext !== 'inherit' && value.agentUserContext !== 'excluded') {
    throw new TypeError('Pi Agent resources: agentUserContext must be inherit or excluded');
  }
  function paths(input: unknown, label: string): readonly string[] {
    if (!Array.isArray(input) || input.some(path => typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) || new Set(input).size !== input.length) {
      throw new TypeError(`Pi Agent resources: ${label} must be a unique list of absolute local paths`);
    }
    return Object.freeze([...input]);
  }
  return Object.freeze({
    agentUserContext: value.agentUserContext,
    skillPaths: paths(value.skillPaths, 'skillPaths'),
    extensionPaths: paths(value.extensionPaths, 'extensionPaths'),
  });
}
