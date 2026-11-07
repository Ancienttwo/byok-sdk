import type { RuntimeCapabilities } from '../../types';

/** Native user configuration and transcripts are inherited. Host MCP toolsets await qualification. */
export const OPENCODE_RUNTIME_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  steer: false,
  resume: true,
  approvalInteractive: false,
  mcpToolsets: false,
  messageDraft: false,
  preparedLane: false,
  isolation: Object.freeze({ userContext: false, userMcpServers: false, sessionPersistence: false }),
});
