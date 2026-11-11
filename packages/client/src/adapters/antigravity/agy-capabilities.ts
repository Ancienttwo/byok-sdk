import type { RuntimeCapabilities, RuntimeIsolationAbsentSources } from '../../types.js';

/**
 * What the agy adapter can do: the one authority for its descriptor, the wire
 * capability matrix and the generated docs/adapter-capabilities.md table
 * (#1103). The runtime contract suite refuses to skip a case for a capability
 * declared here.
 *
 * The SDK-owned OS home keeps user instructions and MCP servers out. agy
 * always persists its conversations there, and resume needs them. It refuses
 * an MCP entry with `env` or `headers`, so `mcpToolsets` covers only
 * credential-free entries.
 */
export const AGY_RUNTIME_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  steer: true,
  resume: true,
  approvalInteractive: false,
  mcpToolsets: true,
  messageDraft: false,
  preparedLane: false,
  isolation: Object.freeze({
    userInstructions: true, userOutputStyle: true, userMemory: false, userSkills: true, userHookContext: true,
    userMcpServers: true, sessionPersistence: false,
  }),
});

/** Isolation sources the qualified agy has none of, with evidence; the contract plan marks each `absent`. */
export const AGY_ABSENT_ISOLATION_SOURCES: RuntimeIsolationAbsentSources = Object.freeze({
  userOutputStyle: 'https://antigravity.google/docs/cli/reference (settings keys: none selects a response style; `verbosity` only sets what the UI shows), agy 1.5.1 binary',
});
