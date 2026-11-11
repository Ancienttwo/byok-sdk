import type { RuntimeCapabilities, RuntimeIsolationAbsentSources } from '../../types.js';

/**
 * Best-case Claude capabilities under its adapter options. The descriptor
 * projects these for the constructed options; the generated capability table
 * and runtime contract suite cover this best case (#1103).
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
