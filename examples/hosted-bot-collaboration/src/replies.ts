import type { ReplyCheck, ReplyReadback } from '@byok-sdk/example-bot-collaboration/rules/commands';
import type { DueReplyCheck, HostedCollaborationStore } from './store';

/** The SDK reply readback of one tenant, as L binds `server.tasks.agentMessage`: the SDK `readTaskAgentMessage`. */
export interface HostedReplyPort {
  agentMessage(taskId: string, deviceId: string, agentRef: NonNullable<DueReplyCheck['task']>['agentRef']): Promise<ReplyReadback>;
}
export interface ReplyCheckerOptions {
  /** The SDK calls of the tenant that owns `scope`. */
  port: (scope: string) => HostedReplyPort;
  /** How long one SDK read may take. A read that takes longer counts as a failed read. */
  timeoutMs?: number;
  /** The clock that each settle reads under the scope lock. */
  now?: () => number;
}

/**
 * The H reply check (#793 S7), as L's `flushReplies`: for each due reply check of a scope, the chain end's SDK readback, then
 * the K8 `checkReply` decision. Each read runs outside any transaction; each settle is fenced, so a second checker that read
 * the same delegation applies nothing. A read that throws or times out is a failed read, as in L. A settle that throws
 * propagates. `delegationDue` puts each check time into `scope.due_at`, so the deployment runs the check from its due
 * scheduler `sync`, before `store.sync`, as L's pass syncs after its reply checks.
 */
export class HostedReplyChecker {
  private readonly now: () => number;
  constructor(private readonly store: HostedCollaborationStore, private readonly options: ReplyCheckerOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Checks each reply of `scope` that is due at `now`, and returns how many checks it applied. Each settle reads the clock. */
  async check(scope: string, now: number): Promise<number> {
    let applied = 0;
    for (const due of await this.store.replyChecks(scope, now)) {
      const check: ReplyCheck = due.task ? await this.read(scope, due.task) : { failed: true };
      if (await this.store.settleReplyCheck(scope, due.delegationId, due.fence, check, this.now)) applied++;
    }
    return applied;
  }

  private async read(scope: string, task: NonNullable<DueReplyCheck['task']>): Promise<ReplyCheck> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const readback = await Promise.race([this.options.port(scope).agentMessage(task.taskId, task.deviceId, task.agentRef),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('reply_check_timeout')), this.options.timeoutMs ?? 10_000); })]);
      return { taskId: task.taskId, failed: false, readback };
    } catch {
      return { taskId: task.taskId, failed: true };
    } finally {
      clearTimeout(timer);
    }
  }
}
