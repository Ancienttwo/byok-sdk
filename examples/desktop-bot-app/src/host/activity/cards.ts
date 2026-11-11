/**
 * The activity card view model (#1499 s1.8): the Host folds a task's activity tail and approval timeline with
 * ui-runtime and sends the result to the renderer, which renders it and folds nothing itself.
 */
import type { ByokServer } from '@byok-sdk/server';
import { replayApprovalTimeline, replayTimeline, type TaskApprovalSnapshot, type TaskTimelineSnapshot } from '@byok-sdk/ui-runtime';

type ActivityTail = NonNullable<Awaited<ReturnType<ByokServer['tasks']['activity']>>>;
type ApprovalTail = NonNullable<Awaited<ReturnType<ByokServer['tasks']['approvalTimeline']>>>;

/** The collapsed card line. */
export interface ActivitySummary {
  readonly tools: number;
  /** The latest tool still waiting for its result. */
  readonly activeTool?: string;
  /** Failed tool results and error items. */
  readonly failures: number;
  readonly pendingApprovals: number;
}

export interface ActivityCard {
  readonly taskId: string;
  /** `null` when the server retains no activity for the task. */
  readonly timeline: TaskTimelineSnapshot | null;
  /** `null` when the server retains no approval timeline for the task. */
  readonly approvals: TaskApprovalSnapshot | null;
  readonly summary: ActivitySummary;
}

export function activityCard(taskId: string, activity: ActivityTail | undefined, approvalTail: ApprovalTail | undefined): ActivityCard {
  const timeline = activity ? replayTimeline(activity) : null;
  const approvals = approvalTail ? replayApprovalTimeline(approvalTail) : null;
  let tools = 0;
  let failures = 0;
  let activeTool: string | undefined;
  for (const item of timeline?.items ?? []) {
    if (item.kind === 'error') failures += 1;
    if (item.kind !== 'tool') continue;
    tools += 1;
    if (item.state === 'output-error') failures += 1;
    if (item.state === 'input-available') activeTool = item.tool;
  }
  const pendingApprovals = approvals?.items.filter(item => item.status === 'pending').length ?? 0;
  return { taskId, timeline, approvals, summary: { tools, ...(activeTool === undefined ? {} : { activeTool }), failures, pendingApprovals } };
}
