import type { RuntimeCapabilities, RuntimeIsolationAbsentSources } from '../../types.js';

/**
 * Best-case Pi capabilities on its ordinary RPC lane under its adapter options.
 * The descriptor projects these for the constructed options; the generated
 * capability table and runtime contract suite cover this best case (#1103).
 */
export const PI_RUNTIME_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  steer: true,
  resume: true,
  mcpToolsets: true,
  messageDraft: true,
  approvalInteractive: false,
  // The ordinary RPC lane with its native Pi subagents, and the prepared lane.
  toolAuthorizationAuto: true,
  preparedLane: true,
  // Pi has no user MCP configuration and no session persistence switch.
  isolation: Object.freeze({
    userInstructions: true, userOutputStyle: true, userMemory: true, userSkills: true, userHookContext: true,
    userMcpServers: false, sessionPersistence: false,
  }),
});

/** The durable Pi worker (`PiAdapterOptions.durableLane`): no steer, resume or prepared lane. */
export const PI_DURABLE_RUNTIME_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  ...PI_RUNTIME_CAPABILITIES,
  durableLane: true,
  steer: false,
  resume: false,
  preparedLane: false,
  // Agent resources (including excluded user context) only run on the RPC
  // lane, so the durable worker must not inherit this capability from
  // PI_RUNTIME_CAPABILITIES. #1197
  isolation: Object.freeze({
    userInstructions: false, userOutputStyle: false, userMemory: false, userSkills: false, userHookContext: false,
    userMcpServers: false, sessionPersistence: false,
  }),
});

/** Isolation sources the qualified pi has none of, with evidence; the contract plan marks each `absent`. */
export const PI_ABSENT_ISOLATION_SOURCES: RuntimeIsolationAbsentSources = Object.freeze({
  userOutputStyle: '@earendil-works/pi-coding-agent@1.5.2 dist/core/system-prompt.js (fixed preamble, no style field), dist/core/settings-schema.js (no style, personality or prompt setting); themes only color the UI and HTML export (docs/themes.md:3, dist/core/agent-session.js exportToHtml)',
  userMemory: '@earendil-works/pi-coding-agent@1.5.2 dist/{core,modes,extensions,utils}, dist/main.js, dist/config.js: no native memory source (searched for "memor"); the agent directory loads only SYSTEM.md, APPEND_SYSTEM.md, AGENTS.md, skills/, extensions/, prompts/ and themes/ (dist/core/resource-loader.js:959-980)',
});
