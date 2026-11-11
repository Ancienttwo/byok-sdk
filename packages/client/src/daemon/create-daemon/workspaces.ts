import { OperationalHealthTracker } from '../operational-health.js';
import { OwnedProcessLedger } from '../owned-process-ledger.js';
import { CursorStore } from '../cursor-store.js';
import { AgentHomeManager, AgentHomeLeaseManager, stableAgentHomeOwnerId, type AgentHomeLeaseManagerOptions } from '../../agent-home.js';
import { AgentSessionHandoffStore } from '../agent-session-handoff-store.js';
import { resolveContentReadPolicies } from './support.js';
import { AgentEgressController } from '../agent-egress-controller.js';
import type { DaemonInputs } from './scope.js';
import type { DaemonStoreScope } from './stores.js';

/**
 * The third stage of `buildDaemonWithAdapters` (#926): builds the local
 * trackers and stores (operational health, the owned process ledger,
 * cursors), the Agent home manager and session handoffs, the content-read
 * policies, and the egress controller used until enrollment is loaded.
 */
export function composeDaemonWorkspaces(
  input: Pick<DaemonInputs & DaemonStoreScope, 'storeDir' | 'config' | 'egressPolicy'> & Required<Pick<AgentHomeLeaseManagerOptions, 'settleAgentMemoryCommit'>>,
) {
  const { storeDir, config, egressPolicy, settleAgentMemoryCommit } = input;
  const logMember = (message: string): void => console.warn(`[byok/client] ${message}`);
  const operationalHealth = new OperationalHealthTracker(storeDir);
  const ownedProcessLedger = new OwnedProcessLedger(storeDir);
  let maintenanceSequence = 0;
  const cursorStore = new CursorStore(storeDir);
  const agentHomeManager = config.agentHome === undefined
    ? undefined
    : new AgentHomeManager({
        hostStorageRoot: config.agentHome.hostStorageRoot,
        ...(config.agentHome.projection === undefined ? {} : { projection: config.agentHome.projection }),
        leaseManager: new AgentHomeLeaseManager({
          ownerId: stableAgentHomeOwnerId(storeDir, config.productId),
          settleAgentMemoryCommit,
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
  return {
    logMember, operationalHealth, ownedProcessLedger, cursorStore, agentHomeManager,
    agentSessionHandoffs, agentContentReadPolicies, initialAgentEgress,
  };
}

export type DaemonWorkspaceScope = ReturnType<typeof composeDaemonWorkspaces>;
