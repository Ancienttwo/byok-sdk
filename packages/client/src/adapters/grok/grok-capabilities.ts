import type { RuntimeCapabilities, RuntimeIsolationAbsentSources } from '../../types';

/**
 * Best-case Grok capabilities under its adapter options. The descriptor
 * projects these for the constructed options; the generated capability table
 * and runtime contract suite cover this best case (#1103).
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
