import type { RuntimeCapabilities, RuntimeIsolationAbsentSources } from '../../types.js';

/**
 * What the dsh adapter can do: the one authority for its descriptor, the wire
 * capability matrix and the generated docs/adapter-capabilities.md table
 * (#1103). The runtime contract suite refuses to skip a case for a capability
 * declared here.
 *
 * The adapter reads each assistant message once it is committed, so there is no
 * draft. dsh's only pre-execution ask is a sandbox escalation, so there is no
 * `auto` gate. The SDK-owned `DSH_HOME` and an empty `DSH_AGENTS_HOME` keep user
 * instructions, skills, the persona and MCP servers out; the acp profile always persists
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
    userInstructions: true, userOutputStyle: true, userMemory: true, userSkills: true, userHookContext: false,
    userMcpServers: true, sessionPersistence: false,
  }),
});

/** Isolation sources the qualified dsh has none of, with evidence; the contract plan marks each `absent`. */
export const DSH_ABSENT_ISOLATION_SOURCES: RuntimeIsolationAbsentSources = Object.freeze({
  userMemory: '@deepseek-ai/dsh@0.2.2-rc.1 package.json and its @deepseek-ai/* packages: no memory package; docs/user/guide/mcp-memory.md covers a third-party MCP server the user configures, which userMcpServers isolates',
});
