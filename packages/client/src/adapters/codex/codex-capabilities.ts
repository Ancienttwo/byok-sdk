import type { RuntimeCapabilities } from '../../types';

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
  isolation: Object.freeze({ userContext: false, userMcpServers: true, sessionPersistence: false }),
});
