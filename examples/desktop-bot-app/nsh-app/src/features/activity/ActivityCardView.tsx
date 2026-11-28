import { formatNumber, t } from "../../i18n.ts";
import { errorText } from "../../statusCopy.ts";
import { Text, View } from "nsh";
import type { ActivityCard } from "../../../../src/host/activity/cards.ts";
import { approvalDecision, cardExpanded, decideApproval, setCardExpanded } from "../../store.ts";
import { Badge, Button, Card, confirmAlert, Disclosure, type BadgeVariant } from "../../ui/index.ts";

type Timeline = NonNullable<ActivityCard["timeline"]>;
type TimelineItem = Timeline["items"][number];
type ApprovalItem = NonNullable<ActivityCard["approvals"]>["items"][number];

const APPROVAL_STATUS: Readonly<Record<ApprovalItem["status"], { variant: BadgeVariant; symbol: string }>> = {
  pending: { variant: "warning", symbol: "◐" },
  approved: { variant: "success", symbol: "✓" },
  rejected: { variant: "danger", symbol: "✕" },
};

function summaryLine({ summary }: ActivityCard): string {
  const parts = [t("activity.tools", { count: formatNumber(summary.tools) })];
  if (summary.activeTool !== undefined) parts.push(t("activity.running", { tool: summary.activeTool }));
  if (summary.failures > 0) parts.push(t("activity.failures", { count: formatNumber(summary.failures) }));
  if (summary.pendingApprovals > 0) parts.push(t("activity.pending", { count: formatNumber(summary.pendingApprovals) }));
  return parts.join(" · ");
}

function itemText(item: TimelineItem): string {
  switch (item.kind) {
    case "text-activity":
      return item.fragments.map((fragment) => fragment.text).join("");
    case "tool":
      return t("activity.tool", { tool: item.tool, status: t(`activity.tool.${item.state}`) });
    case "artifact":
      return t("activity.artifact", { name: item.name, type: item.contentType });
    case "usage":
      return t("activity.usage", { count: item.totalTokens === undefined ? "?" : formatNumber(item.totalTokens) });
    case "error":
      return t("activity.error");
    case "boundary":
      return "—";
    case "unknown":
      return t("activity.unknownEvent", { type: item.eventType });
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
  const label = kind === "approve" ? t("activity.approve") : t("activity.reject");
  return {
    title: t(kind === "approve" ? "activity.confirmApprove" : "activity.confirmReject"),
    description: t("activity.confirmDetail", { title, task: taskId }),
    actions: [
      { label: t("common.cancel"), role: "cancel", id: "cancel" },
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
  const title = () => props.item().summary ?? t("activity.approvalRequest");
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
        <Badge testID={`${testID()}-status`} variant={status().variant} symbol={status().symbol} label={t(`activity.status.${props.item().status}`)} />
        <If when={props.item().resolvedBy}>
          {(by) => <Text class="text-xs text-muted-foreground">{t("activity.resolvedBy", { name: by() })}</Text>}
        </If>
      </View>
      <If when={props.item().status === "pending"}>
        <If
          when={props.item().approvalId !== undefined}
          else={
            <View testID={`${testID()}-no-id`} role="alert">
              <Text class="text-xs text-destructive">
                {t("activity.noApprovalId")}
              </Text>
            </View>
          }
        >
          <View class="flex-row items-center gap-2">
            <Button
              testID={`${testID()}-approve`}
              size="sm"
              accessibilityHint={t("activity.approveHint")}
              loading={running() === "approve"}
              disabled={running() !== null}
              onPress={() => void decide("approve")}
            >
              {t("activity.approve")}
            </Button>
            <Button
              testID={`${testID()}-reject`}
              variant="outline"
              size="sm"
              accessibilityHint={t("activity.rejectHint")}
              loading={running() === "reject"}
              disabled={running() !== null}
              onPress={() => void decide("reject")}
            >
              {t("activity.reject")}
            </Button>
          </View>
        </If>
      </If>
      <If when={decision()?.error}>
        {(error) => (
          <View testID={`${testID()}-error`} role="alert">
            <Text class="text-xs text-destructive">{errorText(error())}</Text>
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
            else={<Text class="text-xs text-muted-foreground">{t("activity.noTimeline")}</Text>}
          >
            {(timeline) => (
              <View class="gap-1.5">
                <View role="list" accessibilityLabel={t("activity.timeline", { task: taskId() })} class="gap-1" selectable>
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
                    {t("activity.lostEvents", { count: formatNumber(lostEvents(timeline())) })}
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
