import type { RuntimeCapabilities } from '../../types';

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
  // The ordinary RPC lane and its native Pi subagents; the daemon never
  // offers `auto` to the prepared lane.
  toolAuthorizationAuto: true,
  preparedLane: true,
  // Pi has no user MCP configuration and no session persistence switch.
  isolation: Object.freeze({ userContext: true, userMcpServers: false, sessionPersistence: false }),
});

/** The durable Pi worker (`PiAdapterOptions.durablePi`): no steer, resume, `auto` or prepared lane. */
export const PI_DURABLE_RUNTIME_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  ...PI_RUNTIME_CAPABILITIES,
  durablePi: true,
  steer: false,
  resume: false,
  toolAuthorizationAuto: false,
  preparedLane: false,
});
