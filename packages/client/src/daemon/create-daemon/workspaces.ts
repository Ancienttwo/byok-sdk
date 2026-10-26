import { OperationalHealthTracker } from '../operational-health';
import { OwnedProcessLedger } from '../owned-process-ledger';
import { CursorStore } from '../cursor-store';
import { SessionWorkspaceStore } from '../session-workspace-store';
import { AgentHomeManager, AgentHomeLeaseManager, stableAgentHomeOwnerId } from '../../agent-home';
import { AgentSessionHandoffStore } from '../agent-session-handoff-store';
import { resolveContentReadPolicies } from './support';
import { AgentEgressController } from '../agent-egress-controller';
import { GitWorkspaceManager, stableGitWorkspaceOwnerId } from '../git-workspace';
import { GitWorkspaceStore } from '../git-workspace-store';
import type { DaemonInputs } from './scope';
import type { DaemonStoreScope } from './stores';

/**
 * The third stage of `buildDaemonWithAdapters` (#926): builds the local
 * trackers and stores (operational health, the owned process ledger, cursors,
 * session workspaces), the Agent home manager and session handoffs, the
 * content-read policies, the egress controller used until enrollment is
 * loaded, and the Git workspace manager and store.
 */
export function composeDaemonWorkspaces(input: Pick<DaemonInputs & DaemonStoreScope, 'storeDir' | 'config' | 'egressPolicy' | 'overrides'>) {
  const { storeDir, config, egressPolicy, overrides } = input;
  const logMember = (message: string): void => console.warn(`[byok/client] ${message}`);
  const operationalHealth = new OperationalHealthTracker(storeDir);
  const ownedProcessLedger = new OwnedProcessLedger(storeDir);
  let maintenanceSequence = 0;
  const cursorStore = new CursorStore(storeDir);
  const sessionWorkspaces = new SessionWorkspaceStore(storeDir);
  const agentHomeManager = config.agentHome === undefined
    ? undefined
    : new AgentHomeManager({
        hostStorageRoot: config.agentHome.hostStorageRoot,
        ...(config.agentHome.projection === undefined ? {} : { projection: config.agentHome.projection }),
        leaseManager: new AgentHomeLeaseManager({
          ownerId: stableAgentHomeOwnerId(storeDir, config.productId),
        }),
      });
  const agentSessionHandoffs = config.agentHome === undefined ? undefined : new AgentSessionHandoffStore();
  // Construction performs only non-mutating path/config validation. The real
  // writable preflight runs after daemon ownership below and before transport
  // or capability publication, so relocation can exclude it race-free.
  agentHomeManager?.preflightSync();
  const agentContentReadPolicies = resolveContentReadPolicies(egressPolicy, config.agentEgress?.contentRead);
  // Before authenticated enrollment is loaded, egress is deliberately unable
  // to persist or acknowledge tenant-scoped records. startUnderLease replaces
  // this with the exact loaded DeviceRecord binding before it accepts work.
  const initialAgentEgress = new AgentEgressController({
    policy: egressPolicy,
  });
  // resolveDaemonConfig requires workspaceRoot for Git workspace mode.
  const gitWorkspaceManager = config.gitWorkspace ? overrides.gitWorkspace?.manager ?? new GitWorkspaceManager(config.workspaceRoot!, { ownerId: stableGitWorkspaceOwnerId(storeDir, config.productId) }) : undefined;
  const gitWorkspaceStore = config.gitWorkspace ? overrides.gitWorkspace?.store ?? new GitWorkspaceStore(storeDir) : undefined;
  return {
    logMember, operationalHealth, ownedProcessLedger, cursorStore, sessionWorkspaces, agentHomeManager,
    agentSessionHandoffs, agentContentReadPolicies, initialAgentEgress, gitWorkspaceManager,
    gitWorkspaceStore,
  };
}

export type DaemonWorkspaceScope = ReturnType<typeof composeDaemonWorkspaces>;
