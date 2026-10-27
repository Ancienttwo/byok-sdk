import { AgentEgressController } from '../../daemon/agent-egress-controller';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../../daemon/agent-egress-policy';
import type { TaskRunnerDeps } from '../../daemon/task-runner';
import { advertiseEveryDeviceFlag } from '../support/advertised-capabilities';

/**
 * The `session` and `egressPolicy` of a fresh-session `task.offer`. Wire v4 has
 * no fresh offer without an egress policy, so a test whose subject is not the
 * session or egress itself runs its plain offer as this one and enables egress
 * on the receiver ({@link freshOfferRunnerDeps} for a bare TaskRunner,
 * {@link FRESH_DAEMON_EGRESS} for a daemon built through `createDaemon`).
 */
export const FRESH_OFFER = {
  session: { mode: 'fresh' },
  egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
} as const;

/** `DaemonConfig.agentEgress` that admits {@link FRESH_OFFER}. */
export const FRESH_DAEMON_EGRESS = { policy: DEFAULT_AGENT_EGRESS_POLICY };

/**
 * The `TaskRunnerDeps` a runner needs to admit {@link FRESH_OFFER} offers and
 * pass their progress through unchanged (a controller without a tenant leaves
 * events as the runtime produced them).
 */
export function freshOfferEgressDeps(): Pick<TaskRunnerDeps, 'agentEgressPolicy' | 'agentEgress'> {
  return {
    agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
    agentEgress: new AgentEgressController({ policy: DEFAULT_AGENT_EGRESS_POLICY }),
  };
}

/** {@link freshOfferEgressDeps} for a runner that also advertises every device flag. */
export function freshOfferRunnerDeps(): Pick<TaskRunnerDeps, 'advertisedCapabilities' | 'agentEgressPolicy' | 'agentEgress'> {
  return { advertisedCapabilities: advertiseEveryDeviceFlag, ...freshOfferEgressDeps() };
}

/** The `session` member of a resume offer. */
export function resumeSession(sessionRef: string) {
  return { session: { mode: 'resume' as const, sessionRef } };
}
