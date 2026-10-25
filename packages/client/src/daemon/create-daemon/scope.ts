import type { Envelope } from '@byok-sdk/protocol';
import type { RuntimeAdapter } from '../../types';
import type { AgentReliableEgressRecord } from '../agent-egress-spool';
import type { ApprovalRegistry } from '../approvals';
import type { AuthManager } from '../auth-manager';
import type { ControlMethods } from '../control-server';
import type { AssertionIssueProbe, DaemonConfig, DaemonOverrides } from '../create-daemon';
import type { DeviceMemberStatus } from '../e2ee-key-package-notice';
import type { DaemonObserver } from '../observer';
import type { OutboundStatus } from '../outbound-settlement';
import type { RetentionRegistry } from '../retention/registry';
import type { RetentionSweeper } from '../retention/sweeper';
import type { TerminalCommitQueue } from '../terminal-commit-queue';
import type { DaemonConfigScope } from './config';
import type { DaemonFunctions } from './functions';
import type { DaemonState } from './state';
import type { DaemonStoreScope } from './stores';
import type { DaemonWorkspaceScope } from './workspaces';

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
}

/**
 * Everything one daemon's functions share (#926): the parameters, the values
 * each construction stage returned, the values built in the body, the one
 * {@link DaemonState}, and every daemon function bound to this scope. A
 * function in `create-daemon/` takes the scope first and destructures what it
 * reads; reassigned values are read and written through `daemonState`.
 */
export type DaemonScope = DaemonInputs & DaemonConfigScope & DaemonStoreScope & DaemonWorkspaceScope & DaemonBodyValues & DaemonFunctions;
