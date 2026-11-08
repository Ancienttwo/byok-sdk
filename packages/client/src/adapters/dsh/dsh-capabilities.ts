import type { RuntimeCapabilities, RuntimeIsolationAbsentSources } from '../../types';

/**
 * What the dsh adapter can do: the one authority for its descriptor, the wire
 * capability matrix and the generated docs/adapter-capabilities.md table
 * (#1103). The runtime contract suite refuses to skip a case for a capability
 * declared here.
 *
 * The adapter reads each assistant message once it is committed, so there is no
 * draft. dsh's only pre-execution ask is a sandbox escalation, so there is no
 * `auto` gate. The SDK-owned `DSH_HOME` and an empty `DSH_AGENTS_HOME` keep user
 * instructions, skills and MCP servers out; the acp profile always persists
 * sessions, which resume needs.
 */
export const DSH_RUNTIME_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  steer: true,
  resume: true,
  approvalInteractive: false,
  mcpToolsets: true,
  messageDraft: false,
  preparedLane: false,
  isolation: Object.freeze({
    userInstructions: true, userOutputStyle: false, userMemory: false, userSkills: false, userHookContext: false,
    userMcpServers: true, sessionPersistence: false,
  }),
});

/** Isolation sources the qualified dsh has none of, with evidence; the contract plan marks each `absent`. */
export const DSH_ABSENT_ISOLATION_SOURCES: RuntimeIsolationAbsentSources = Object.freeze({});
