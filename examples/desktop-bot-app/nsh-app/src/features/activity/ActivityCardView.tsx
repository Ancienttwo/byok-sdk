import { Text, View } from "nsh";
import type { ActivityCard } from "../../../../src/host/activity/cards.ts";
import { approvalDecision, cardExpanded, decideApproval, setCardExpanded } from "../../store.ts";
import { Badge, Button, Card, confirmAlert, Disclosure, type BadgeVariant } from "../../ui/index.ts";

type Timeline = NonNullable<ActivityCard["timeline"]>;
type TimelineItem = Timeline["items"][number];
type ApprovalItem = NonNullable<ActivityCard["approvals"]>["items"][number];

const APPROVAL_STATUS: Readonly<Record<ApprovalItem["status"], { variant: BadgeVariant; symbol: string; label: string }>> = {
  pending: { variant: "warning", symbol: "◐", label: "Pending" },
  approved: { variant: "success", symbol: "✓", label: "Approved" },
  rejected: { variant: "danger", symbol: "✕", label: "Rejected" },
};

function summaryLine({ summary }: ActivityCard): string {
  const parts = [`${summary.tools} tool${summary.tools === 1 ? "" : "s"}`];
  if (summary.activeTool !== undefined) parts.push(`running ${summary.activeTool}`);
  if (summary.failures > 0) parts.push(`${summary.failures} failed`);
  if (summary.pendingApprovals > 0) parts.push(`${summary.pendingApprovals} waiting for you`);
  return parts.join(" · ");
}

function itemText(item: TimelineItem): string {
  switch (item.kind) {
    case "text-activity":
      return item.fragments.map((fragment) => fragment.text).join("");
    case "tool":
      return `${item.tool}: ${item.state}`;
    case "artifact":
      return `Artifact ${item.name} (${item.contentType})`;
    case "usage":
      return `Usage: ${item.totalTokens ?? "?"} tokens`;
    case "error":
      return `Error: ${item.message}`;
    case "boundary":
      return "—";
    case "unknown":
      return `Unrecognized event ${item.eventType}`;
  }
}

const itemKey = (item: TimelineItem) => `${item.orderKey.revision}:${item.orderKey.offset}`;

const lostEvents = (timeline: Timeline) => timeline.dropped + timeline.gaps.reduce((sum, gap) => sum + gap.missing, 0);

/**
 * The confirmation of one decision. No action has the `"default"` role: an OS alert focuses its default action first
 * (Windows presses the focused button on each repeated key-down), so Cancel, listed first, takes the initial focus and
 * a held Enter or Space cannot confirm an irreversible decision.
 */
export function approvalConfirmOptions(
  kind: "approve" | "reject",
  title: string,
  taskId: string,
): Parameters<typeof confirmAlert>[0] {
  const label = kind === "approve" ? "Approve" : "Reject";
  return {
    title: `${label} this request?`,
    description: `${title} (task ${taskId}). The decision cannot be undone.`,
    actions: [
      { label: "Cancel", role: "cancel", id: "cancel" },
      { label, role: "destructive", id: kind },
    ],
    closeOnEscape: true,
  };
}

/**
 * One approval. Only a pending request that names its approval id can be answered: the decision targets exactly it,
 * after the native alert confirms it. Its running and refused state lives in the store, keyed by task and approval id.
 */
function ApprovalRow(props: { taskId: string; item: () => ApprovalItem }) {
  const testID = () => `activity-approval-${props.taskId}-${props.item().firstRevision}`;
  const title = () => props.item().summary ?? "Approval request";
  const status = () => APPROVAL_STATUS[props.item().status];
  const decision = () => {
    const approvalId = props.item().approvalId;
    return approvalId === undefined ? undefined : approvalDecision(props.taskId, approvalId);
  };
  const running = () => decision()?.running ?? null;
  const decide = async (kind: "approve" | "reject") => {
    const approvalId = props.item().approvalId;
    if (approvalId === undefined || running() !== null) {
      return;
    }
    const answer = await confirmAlert(approvalConfirmOptions(kind, title(), props.taskId));
    if (answer.action === kind) {
      await decideApproval(props.taskId, approvalId, kind);
    }
  };
  return (
    <View testID={testID()} class="gap-1.5">
      <View class="flex-row flex-wrap items-center gap-2">
        <Text class="text-sm text-foreground">{title()}</Text>
        <Badge testID={`${testID()}-status`} variant={status().variant} symbol={status().symbol} label={status().label} />
        <If when={props.item().resolvedBy}>
          {(by) => <Text class="text-xs text-muted-foreground">{`(by ${by()})`}</Text>}
        </If>
      </View>
      <If when={props.item().status === "pending"}>
        <If
          when={props.item().approvalId !== undefined}
          else={
            <View testID={`${testID()}-no-id`} role="alert">
              <Text class="text-xs text-destructive">
                This request has no approval id and cannot be answered here.
              </Text>
            </View>
          }
        >
          <View class="flex-row items-center gap-2">
            <Button
              testID={`${testID()}-approve`}
              size="sm"
              accessibilityHint="Asks to confirm, then approves this request"
              loading={running() === "approve"}
              disabled={running() !== null}
              onPress={() => void decide("approve")}
            >
              Approve
            </Button>
            <Button
              testID={`${testID()}-reject`}
              variant="outline"
              size="sm"
              accessibilityHint="Asks to confirm, then rejects this request"
              loading={running() === "reject"}
              disabled={running() !== null}
              onPress={() => void decide("reject")}
            >
              Reject
            </Button>
          </View>
        </If>
      </If>
      <If when={decision()?.error}>
        {(error) => (
          <View testID={`${testID()}-error`} role="alert">
            <Text class="text-xs text-destructive">{error()}</Text>
          </View>
        )}
      </If>
    </View>
  );
}

/**
 * One task's card: the summary line folds the timeline the Host projected; approvals stay outside the fold, so a pending
 * one shows while the card is folded. Mount it once per `taskId`: it reads `card()` as that task's card updates.
 */
export function ActivityCardView(props: { card: () => ActivityCard }) {
  const taskId = () => props.card().taskId;
  return (
    <Card>
      <View testID={`activity-card-${taskId()}`} class="gap-3">
        <Text role="header" accessibilityLevel={2} class="text-sm font-mono text-foreground">
          {taskId()}
        </Text>
        <Disclosure
          testID={`activity-card-${taskId()}-toggle`}
          title={summaryLine(props.card())}
          open={cardExpanded(taskId())}
          onToggle={(open) => setCardExpanded(taskId(), open)}
        >
          <If
            when={props.card().timeline}
            else={<Text class="text-xs text-muted-foreground">No activity retained for this task.</Text>}
          >
            {(timeline) => (
              <View class="gap-1.5">
                <View role="list" accessibilityLabel={`Timeline of task ${taskId()}`} class="gap-1" selectable>
                  <Each of={timeline().items} key={itemKey}>
                    {(item) => (
                      <Text testID={`activity-item-${taskId()}-${item().kind}`} class="text-xs text-foreground">
                        {itemText(item())}
                      </Text>
                    )}
                  </Each>
                </View>
                <If when={lostEvents(timeline()) > 0}>
                  <Text class="text-xs text-muted-foreground">
                    {`${lostEvents(timeline())} earlier events are no longer retained.`}
                  </Text>
                </If>
              </View>
            )}
          </If>
        </Disclosure>
        <If when={props.card().approvals}>
          {(approvals) => (
            <View class="gap-2">
              <Each of={approvals().items} key={(item) => String(item.firstRevision)}>
                {(item) => <ApprovalRow taskId={taskId()} item={item} />}
              </Each>
            </View>
          )}
        </If>
      </View>
    </Card>
  );
}
