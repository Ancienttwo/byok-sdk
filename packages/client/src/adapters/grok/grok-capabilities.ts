import type { RuntimeCapabilities, RuntimeIsolationAbsentSources } from '../../types';

/**
 * What the Grok adapter can do: the one authority for its descriptor, the
 * wire capability matrix and the generated docs/adapter-capabilities.md table
 * (#1103). The runtime contract suite refuses to skip a case for a capability
 * declared here.
 */
export const GROK_RUNTIME_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  steer: false,
  resume: true,
  approvalInteractive: false,
  mcpToolsets: true,
  messageDraft: true,
  preparedLane: false,
  isolation: Object.freeze({
    userInstructions: false, userOutputStyle: false, userMemory: false, userSkills: false, userHookContext: false,
    userMcpServers: true, sessionPersistence: false,
  }),
});

/** Isolation sources the qualified grok has none of, with evidence; the contract plan marks each `absent`. */
export const GROK_ABSENT_ISOLATION_SOURCES: RuntimeIsolationAbsentSources = Object.freeze({});
