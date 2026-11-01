import type { RuntimeCapabilities } from '../../types';

/**
 * What the dsh adapter can do: the one authority for its descriptor, the wire
 * capability matrix and the generated docs/adapter-capabilities.md table
 * (#1103). The runtime contract suite refuses to skip a case for a capability
 * declared here.
 *
 * dsh's ACP server sends each assistant message only once it is committed, so
 * there is no draft. Its only pre-execution ask is a sandbox escalation, so
 * there is no `auto` gate. The SDK-owned `DSH_HOME` and an empty
 * `DSH_AGENTS_HOME` keep user instructions, skills and MCP servers out; the
 * acp profile always persists sessions, which resume needs.
 */
export const DSH_RUNTIME_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  steer: false,
  resume: true,
  approvalInteractive: false,
  mcpToolsets: true,
  messageDraft: false,
  preparedLane: false,
  isolation: Object.freeze({ userContext: true, userMcpServers: true, sessionPersistence: false }),
});
