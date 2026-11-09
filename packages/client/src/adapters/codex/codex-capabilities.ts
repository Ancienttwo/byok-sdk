import type { RuntimeCapabilities, RuntimeIsolationAbsentSources } from '../../types';

/**
 * What the Codex adapter can do: the one authority for its descriptor, the
 * wire capability matrix and the generated docs/adapter-capabilities.md table
 * (#1103). The runtime contract suite refuses to skip a case for a capability
 * declared here.
 */
export const CODEX_RUNTIME_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  steer: true,
  resume: true,
  approvalInteractive: false,
  mcpToolsets: true,
  messageDraft: true,
  preparedLane: false,
  // Codex has no per-process switch for the user AGENTS.md or its thread store.
  isolation: Object.freeze({
    userInstructions: false, userOutputStyle: false, userMemory: false, userSkills: false, userHookContext: false,
    userMcpServers: true, sessionPersistence: false,
  }),
});

/** Isolation sources the qualified codex has none of, with evidence; the contract plan marks each `absent`. */
export const CODEX_ABSENT_ISOLATION_SOURCES: RuntimeIsolationAbsentSources = Object.freeze({});
