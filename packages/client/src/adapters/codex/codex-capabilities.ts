import type { RuntimeCapabilities, RuntimeIsolationAbsentSources } from '../../types';

/**
 * Best-case Codex capabilities under its adapter options. The descriptor
 * projects these for the constructed options; the generated capability table
 * and runtime contract suite cover this best case (#1103).
 */
export const CODEX_RUNTIME_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  steer: true,
  resume: true,
  approvalInteractive: false,
  mcpToolsets: true,
  messageDraft: true,
  preparedLane: false,
  // `agentUserContext: 'excluded'` moves CODEX_HOME; skills under $HOME/.agents, the hooks and the thread store stay the user's.
  isolation: Object.freeze({
    userInstructions: true, userOutputStyle: false, userMemory: true, userSkills: false, userHookContext: false,
    userMcpServers: true, sessionPersistence: false,
  }),
});

/** Isolation sources the qualified codex has none of, with evidence; the contract plan marks each `absent`. */
export const CODEX_ABSENT_ISOLATION_SOURCES: RuntimeIsolationAbsentSources = Object.freeze({});
