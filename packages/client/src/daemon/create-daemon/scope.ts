import type { Envelope } from '@byok-sdk/protocol';
import type { RuntimeAdapter } from '../../types.js';
import type { AgentReliableEgressRecord } from '../agent-egress-spool.js';
import type { ApprovalRegistry } from '../approvals.js';
import type { AuthManager } from '../auth-manager.js';
import type { ControlMethods } from '../control-server.js';
import type { AssertionIssueProbe, DaemonConfig, DaemonOverrides } from '../create-daemon.js';
import type { DeviceMemberStatus } from '../e2ee-key-package-notice.js';
import type { DaemonObserver } from '../observer.js';
import type { OutboundStatus } from '../outbound-settlement.js';
import type { RetentionRegistry } from '../retention/registry.js';
import type { RetentionSweeper } from '../retention/sweeper.js';
import type { TerminalCommitQueue } from '../terminal-commit-queue.js';
import type { DaemonConfigScope } from './config.js';
import type { DaemonFunctions } from './functions.js';
import type { DaemonState } from './state.js';
import type { DaemonStoreScope } from './stores.js';
import type { DaemonWorkspaceScope } from './workspaces.js';
import type { DaemonEffectiveConfig } from '../config-schema/effective.js';

/** `buildDaemonWithAdapters`' own parameters, as its stages receive them (#926). */
export interface DaemonInputs {
  readonly config: DaemonConfig;
  readonly adapters: RuntimeAdapter[];
  readonly overrides: DaemonOverrides;
  readonly assertionProbe: AssertionIssueProbe | undefined;
}

/** The values `buildDaemonWithAdapters` still constructs in its own body. */
interface DaemonBodyValues {
  readonly memberStatus: () => DeviceMemberStatus;
  readonly retentionRegistry: RetentionRegistry;
  readonly retentionSweeper: RetentionSweeper;
  readonly terminalCommits: TerminalCommitQueue;
  readonly outbound: OutboundStatus;
  readonly observer: DaemonObserver;
  readonly approvalRegistry: ApprovalRegistry;
  readonly capabilityDiscoveryTimeoutMs: number;
  readonly pendingLateMutationBarriers: Set<Promise<void>>;
  readonly buildAuthManager: () => AuthManager;
  readonly daemonState: DaemonState;
  readonly controlMethods: ControlMethods;
  readonly reliableEnvelopes: WeakMap<AgentReliableEgressRecord, Envelope>;
  readonly effectiveConfig: DaemonEffectiveConfig;
}

/**
 * Everything one daemon's functions share (#926): the parameters, the values
 * each construction stage returned, the values built in the body, the one
 * {@link DaemonState}, and every daemon function bound to this scope. A
 * function in `create-daemon/` takes the scope first and destructures what it
 * reads; reassigned values are read and written through `daemonState`.
 */
export type DaemonScope = DaemonInputs & DaemonConfigScope & DaemonStoreScope & DaemonWorkspaceScope & DaemonBodyValues & DaemonFunctions;
