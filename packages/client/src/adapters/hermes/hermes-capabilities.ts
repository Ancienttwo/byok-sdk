import type { RuntimeCapabilities } from '../../types';

/**
 * What the Hermes adapter can do: the one authority for its descriptor, the
 * wire capability matrix and the generated docs/adapter-capabilities.md table
 * (#1103). The runtime contract suite refuses to skip a case for a capability
 * declared here.
 */
export const HERMES_RUNTIME_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  steer: false,
  resume: false,
  approvalInteractive: false,
  mcpToolsets: true,
  messageDraft: true,
  preparedLane: false,
  // Each execution runs in a fresh profile home, so user context and user MCP
  // servers never reach it; there is no session persistence switch.
  isolation: Object.freeze({ userContext: true, userMcpServers: true, sessionPersistence: false }),
});
