import type { RuntimeCapabilities, RuntimeIsolationAbsentSources } from '../../types.js';

/** Native user configuration and transcripts are inherited. */
export const OPENCODE_RUNTIME_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  steer: false,
  resume: true,
  approvalInteractive: false,
  mcpToolsets: true,
  messageDraft: false,
  preparedLane: false,
  isolation: Object.freeze({
    userInstructions: false, userOutputStyle: false, userMemory: false, userSkills: false, userHookContext: false,
    userMcpServers: false, sessionPersistence: false,
  }),
});
