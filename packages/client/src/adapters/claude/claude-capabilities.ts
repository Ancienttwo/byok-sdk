import type { RuntimeCapabilities, RuntimeIsolationAbsentSources } from '../../types';

/**
 * What the Claude adapter can do: the one authority for its descriptor, the
 * wire capability matrix and the generated docs/adapter-capabilities.md table
 * (#1103). The runtime contract suite refuses to skip a case for a capability
 * declared here.
 */
export const CLAUDE_RUNTIME_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  steer: false,
  resume: true,
  approvalInteractive: false,
  toolAuthorizationAuto: true,
  mcpToolsets: true,
  messageDraft: true,
  preparedLane: false,
  isolation: Object.freeze({
    userInstructions: true, userOutputStyle: true, userMemory: true, userSkills: false, userHookContext: false,
    userMcpServers: true, sessionPersistence: true,
  }),
});

/** Isolation sources the qualified claude has none of, with evidence; the contract plan marks each `absent`. */
export const CLAUDE_ABSENT_ISOLATION_SOURCES: RuntimeIsolationAbsentSources = Object.freeze({});
