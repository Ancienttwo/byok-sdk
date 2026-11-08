import type { RuntimeCapabilities, RuntimeIsolationAbsentSources } from '../../types';

/** Native user configuration and transcripts are inherited. Host MCP toolsets await qualification. */
export const OPENCODE_RUNTIME_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  steer: false,
  resume: true,
  approvalInteractive: false,
  mcpToolsets: false,
  messageDraft: false,
  preparedLane: false,
  isolation: Object.freeze({
    userInstructions: false, userOutputStyle: false, userMemory: false, userSkills: false, userHookContext: false,
    userMcpServers: false, sessionPersistence: false,
  }),
});
