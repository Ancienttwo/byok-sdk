import type { RuntimeCapabilities, RuntimeIsolationAbsentSources } from '../../types';

/**
 * What the Pi adapter can do on its ordinary RPC lane: the one authority for
 * its descriptor, the wire capability matrix and the generated
 * docs/adapter-capabilities.md table (#1103). The runtime contract suite
 * refuses to skip a case for a capability declared here.
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
    userInstructions: true, userOutputStyle: false, userMemory: false, userSkills: false, userHookContext: false,
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
export const PI_ABSENT_ISOLATION_SOURCES: RuntimeIsolationAbsentSources = Object.freeze({});
