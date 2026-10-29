/**
 * `DaemonConfig` fields that no longer exist (#1094). The one table both the
 * validator and the generated schema (`x-byok-removedFields`) read: supplying
 * one of these is a typed {@link DaemonConfigFieldRemovedError} on every
 * surface, never an unknown-field warning, because the Host relied on it and
 * must change its config or code.
 *
 * Every entry points at the migration note in `docs/spec.md`.
 *
 * This module has no imports so the schema generator can load it with Node's
 * type stripping.
 */
export interface RemovedDaemonConfigField {
  /** Dotted path from the config root, e.g. `workspaceRoot` or `agentEgress.sanitizer`. */
  readonly path: string;
  /** What replaced it; the error message. */
  readonly message: string;
  /** Repo-relative `.md#anchor` of the migration note. */
  readonly migration: string;
}

export const REMOVED_DAEMON_CONFIG_FIELDS_MIGRATION = 'docs/spec.md#removed-daemonconfig-fields';

const removed = (path: string, message: string): RemovedDaemonConfigField =>
  Object.freeze({ path, message, migration: REMOVED_DAEMON_CONFIG_FIELDS_MIGRATION });

export const REMOVED_DAEMON_CONFIG_FIELDS: readonly RemovedDaemonConfigField[] = Object.freeze([
  removed('permissionDefaults', 'DaemonConfig.permissionDefaults was removed: the local agent\'s own permission settings apply'),
  removed('agentEgress.sanitizer', 'DaemonConfig.agentEgress.sanitizer was removed: Agent egress goes to the Host as is'),
  removed('mcpLaunchCwd', 'DaemonConfig.mcpLaunchCwd was removed: MCP servers start in the session cwd, as the agent runtime does'),
  removed('toolImplementationAuthority', 'DaemonConfig.toolImplementationAuthority was removed: the SDK does not attest tool or runtime executables'),
  removed('hostedJournal', 'DaemonConfig.hostedJournal was removed: every daemon journals; tune it under storage.journal and inject a journal as overrides.journal'),
  removed('strictAgentOnly', 'DaemonConfig.strictAgentOnly was removed: since wire v4 every offer is an Agent offer, so every daemon runs Agent offers only'),
  removed('gitWorkspace', 'DaemonConfig.gitWorkspace was removed: since wire v4 every offer is an Agent offer and runs in its SDK-owned Agent home, so there are no Git task workspaces (overrides.gitWorkspace is gone too); configure agentHome'),
  removed('workspaceRoot', 'DaemonConfig.workspaceRoot was removed: since wire v4 every offer runs in its SDK-owned Agent home, never in a workspaceRoot/<taskId> directory; configure agentHome'),
  removed('resultDocument', 'DaemonConfig.resultDocument was removed: a result-document offer carries its frozen schema and the runtime submits the outcome through the SDK-reserved submit_result tool'),
  removed('maxConcurrentMutableSessionsPerAgentHome', 'DaemonConfig.maxConcurrentMutableSessionsPerAgentHome was removed. A home has one writer Attempt; send concurrent tasks as homeAccess: \'memory-reader\' offers and set maxConcurrentReaderAttemptsPerAgentHome to limit them.'),
  removed('agentMemoryFilesystem', 'DaemonConfig.agentMemoryFilesystem is removed; an arbitrary helper is not admitted on this platform. Use the SDK release artifact.'),
]);
