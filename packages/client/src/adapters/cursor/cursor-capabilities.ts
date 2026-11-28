import type { RuntimeCapabilities } from '../../types.js';

export const CURSOR_RUNTIME_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  steer: false,
  resume: true,
  approvalInteractive: false,
  mcpToolsets: true,
  messageDraft: true,
  preparedLane: false,
  isolation: Object.freeze({
    userInstructions: false,
    userOutputStyle: false,
    userMemory: false,
    userSkills: false,
    userHookContext: false,
    userMcpServers: false,
    sessionPersistence: false,
  }),
});
