import type { RuntimeCapabilities } from '../../types';

/**
 * What the agy adapter can do: the one authority for its descriptor, the wire
 * capability matrix and the generated docs/adapter-capabilities.md table
 * (#1103). The runtime contract suite refuses to skip a case for a capability
 * declared here.
 *
 * The SDK-owned OS home keeps user instructions and MCP servers out. agy
 * always persists its conversations there, and resume needs them. It refuses
 * an MCP entry with `env` or `headers`, so `mcpToolsets` covers only
 * credential-free entries. Steer exists natively but is not enabled.
 */
export const AGY_RUNTIME_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  steer: false,
  resume: true,
  approvalInteractive: false,
  mcpToolsets: true,
  messageDraft: false,
  preparedLane: false,
  isolation: Object.freeze({ userContext: true, userMcpServers: true, sessionPersistence: false }),
});
