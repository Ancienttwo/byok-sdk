import { describe, expect, open, test } from "nsh/test";
import type { ActivityCard } from "../../../../src/host/activity/cards.ts";

type Call = { method: string; params: any };
type TimelineItem = NonNullable<ActivityCard["timeline"]>["items"][number];
type ApprovalItem = NonNullable<ActivityCard["approvals"]>["items"][number];

const order = (taskId: string, offset: number) => ({ eventKeys: [], orderKey: { taskId, revision: 1, offset } });

function approval(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    kind: "approval",
    approvalId: "ap-1",
    lifecycle: "approval-requested",
    status: "pending",
    correlation: "unpaired-request",
    firstRevision: 3,
    sourceRevisions: [3],
    sourceEnvelopeIds: ["env-3"],
    summary: "Run the build script",
    ...overrides,
  };
}

function card(
  taskId: string,
  options: { items?: TimelineItem[]; approvals?: ApprovalItem[]; timeline?: null; dropped?: number; missing?: number } = {},
): ActivityCard {
  const items = options.items ?? [{ kind: "text-activity", ...order(taskId, 0), fragments: [{ eventKey: { sourceEnvelopeId: "e", eventIndex: 0 }, text: `Working on ${taskId}` }] }];
  const pending = (options.approvals ?? []).filter((item) => item.status === "pending").length;
  return {
    taskId,
    timeline:
      options.timeline === null
        ? null
        : {
            taskId,
            items,
            gaps: options.missing === undefined ? [] : [{ kind: "event", after: order(taskId, 0).orderKey, before: order(taskId, 9).orderKey, missing: options.missing }],
            dropped: options.dropped ?? 0,
          },
    approvals: options.approvals === undefined ? null : { taskId, items: options.approvals, dropped: 0 },
    summary: { tools: 0, failures: 0, pendingApprovals: pending },
  };
}

/** A started shell whose Host runs; `cards` answers `activity.cards`, `decide` the approve and reject calls. */
function activityShell(
  calls: Call[],
  cards: () => ActivityCard[],
  decide: (method: string, params: any) => unknown = () => null,
) {
  return {
    "byok-nsh-adapter": {
      "ByokShell.start": { started: true, alreadyStarted: false, state: { state: "running", pid: 1, activeWork: 0 } },
      "ByokShell.call": (method: string, params: any) => {
        calls.push({ method, params });
        if (method === "keys.list") return [];
        if (method === "k8.view") return { bots: [], roles: [], models: [], busy: false };
        if (method === "activity.cards") return cards();
        return decide(method, params);
      },
    },
  };
}

async function openActivity(modules: ReturnType<typeof activityShell>) {
  const app = await open("../../../App.tsx", { platform: "macos", width: 1280, height: 900, modules });
  await app.press("id:nav-activity");
  return app;
}

const cardReads = (calls: Call[]) => calls.filter((call) => call.method === "activity.cards").length;
const decisions = (calls: Call[]) => calls.filter((call) => call.method === "activity.approve" || call.method === "activity.reject");
const refusal = (message: string) => Object.assign(new Error(message), { code: "method_failed" });

describe("ActivityScreen (#2461 Slice 5)", () => {
  test("cards load only while Activity shows, and a folded card still shows its pending approval", async () => {
    const calls: Call[] = [];
    const app = await open("../../../App.tsx", {
      platform: "macos",
      width: 1280,
      height: 900,
      modules: activityShell(calls, () => [card("task-a", { approvals: [approval()] })]),
    });
    await app.waitUntil(() => calls.some((call) => call.method === "k8.view"));
    expect(cardReads(calls)).toBe(0);

    await app.press("id:nav-activity");
    await app.waitFor("id:activity-card-task-a");
    expect(app.accessibility("id:activity-card-task-a-toggle")?.expanded).toBe(false);
    expect(app.shows("text:Working on task-a")).toBe(false);
    expect(app.shows("text:Run the build script")).toBe(true);
    expect(app.accessibility("id:activity-approval-task-a-3-status")?.label).toBe("Pending");
    expect(app.shows("id:activity-approval-task-a-3-approve")).toBe(true);
    expect(app.shows("id:activity-approval-task-a-3-reject")).toBe(true);

    await app.press("id:activity-card-task-a-toggle");
    await app.waitFor("text:Working on task-a");

    await app.press("id:nav-settings");
    await app.press("id:nav-keys");
    await app.wait(50);
    expect(cardReads(calls)).toBe(1);
  });

  test("Approve and Reject ask first: cancel and Escape send nothing, a confirmed decision goes out and reloads the cards", async () => {
    const calls: Call[] = [];
    const app = await openActivity(activityShell(calls, () => [card("task-a", { approvals: [approval()] })]));
    await app.waitFor("id:activity-approval-task-a-3-approve");

    app.onDialog(() => null);
    await app.press("id:activity-approval-task-a-3-approve");
    app.onDialog((dialog) => (dialog.buttons.includes("Cancel") ? "Cancel" : null));
    await app.press("id:activity-approval-task-a-3-reject");
    await app.wait(50);
    expect(app.dialogs().map((dialog) => dialog.title)).toEqual(["Approve this request?", "Reject this request?"]);
    expect(app.dialogs()[0].buttons).toEqual(["Cancel", "Approve"]);
    expect(decisions(calls)).toEqual([]);
    expect(cardReads(calls)).toBe(1);

    app.onDialog(() => "Reject");
    await app.press("id:activity-approval-task-a-3-reject");
    await app.waitUntil(() => cardReads(calls) === 2);
    app.onDialog(() => "Approve");
    await app.press("id:activity-approval-task-a-3-approve");
    await app.waitUntil(() => cardReads(calls) === 3);
    expect(decisions(calls)).toEqual([
      { method: "activity.reject", params: { taskId: "task-a", approvalId: "ap-1" } },
      { method: "activity.approve", params: { taskId: "task-a", approvalId: "ap-1" } },
    ]);
    expect(app.shows("id:activity-approval-task-a-3-error")).toBe(false);
  });

  test("a stale approval decided by the other entry shows the refusal and the decided card", async () => {
    const calls: Call[] = [];
    let decided = false;
    const app = await openActivity(
      activityShell(
        calls,
        () => [card("task-a", { approvals: [decided ? approval({ status: "approved", decision: "approve", resolvedBy: "local" }) : approval()] })],
        () => {
          decided = true;
          throw Object.assign(new Error("The approval was already resolved"), { code: "StaleApprovalError" });
        },
      ),
    );
    app.onDialog(() => "Approve");
    await app.press("id:activity-approval-task-a-3-approve");
    await app.waitFor("id:activity-approval-task-a-3-error");
    expect(app.accessibility("id:activity-approval-task-a-3-error")?.role).toBe("alert");
    expect(app.shows("text:The approval was already resolved")).toBe(true);
    await app.waitUntil(() => app.accessibility("id:activity-approval-task-a-3-status")?.label === "Approved");
    expect(app.shows("text:(by local)")).toBe(true);
    expect(app.shows("id:activity-approval-task-a-3-approve")).toBe(false);
    expect(cardReads(calls)).toBe(2);
  });

  test("a recycled cell showing another task keeps no state of the previous card", async () => {
    const calls: Call[] = [];
    let shown = "a";
    const app = await openActivity(
      activityShell(
        calls,
        () =>
          shown === "a"
            ? [card("task-a", { approvals: [approval()] })]
            : [card("task-b", { approvals: [approval({ approvalId: "ap-b", summary: "Deploy" })] })],
        (method, params) => {
          shown = params.taskId === "task-a" ? "b" : "a";
          if (params.taskId === "task-a") throw refusal("Host busy");
          return null;
        },
      ),
    );
    app.onDialog(() => "Approve");
    await app.press("id:activity-card-task-a-toggle");
    await app.waitFor("text:Working on task-a");
    await app.press("id:activity-approval-task-a-3-approve");

    await app.waitFor("id:activity-card-task-b");
    expect(app.shows("id:activity-card-task-a")).toBe(false);
    expect(app.accessibility("id:activity-card-task-b-toggle")?.expanded).toBe(false);
    expect(app.shows("text:Working on task-b")).toBe(false);
    expect(app.shows("text:Host busy")).toBe(false);
    expect(app.shows("text:Deploy")).toBe(true);

    await app.press("id:activity-approval-task-b-3-approve");
    await app.waitFor("id:activity-card-task-a");
    expect(app.accessibility("id:activity-card-task-a-toggle")?.expanded).toBe(true);
    expect(app.shows("text:Working on task-a")).toBe(true);
    expect(app.shows("text:Host busy")).toBe(true);
  });

  test("the card renders all seven timeline kinds, lost events, an empty timeline, and an unanswerable approval", async () => {
    const calls: Call[] = [];
    const items: TimelineItem[] = [
      { kind: "text-activity", ...order("task-a", 0), fragments: [{ eventKey: { sourceEnvelopeId: "e", eventIndex: 0 }, text: "Hello " }, { eventKey: { sourceEnvelopeId: "e", eventIndex: 1 }, text: "world" }] },
      { kind: "tool", ...order("task-a", 1), tool: "bash", state: "output-available" },
      { kind: "artifact", ...order("task-a", 2), name: "report.md", contentType: "text/markdown" },
      { kind: "usage", ...order("task-a", 3), totalTokens: 42 },
      { kind: "error", ...order("task-a", 4), message: "boom" },
      { kind: "boundary", ...order("task-a", 5) },
      { kind: "unknown", ...order("task-a", 6), eventType: "custom.thing", classification: "unknown-event" },
    ];
    const app = await openActivity(
      activityShell(calls, () => [
        card("task-a", { items, dropped: 2, missing: 3 }),
        card("task-b", { timeline: null, approvals: [approval({ approvalId: undefined, summary: undefined })] }),
      ]),
    );
    await app.press("id:activity-card-task-a-toggle");
    await app.waitFor("text:Hello world");
    for (const text of [
      "bash: output-available",
      "Artifact report.md (text/markdown)",
      "Usage: 42 tokens",
      "Error: boom",
      "—",
      "Unrecognized event custom.thing",
      "5 earlier events are no longer retained.",
    ]) {
      expect(app.shows(`text:${text}`)).toBe(true);
    }
    for (const kind of ["text-activity", "tool", "artifact", "usage", "error", "boundary", "unknown"]) {
      expect(app.count(`id:activity-item-task-a-${kind}`)).toBe(1);
    }

    await app.press("id:activity-card-task-b-toggle");
    await app.waitFor("text:No activity retained for this task.");
    expect(app.shows("text:Approval request")).toBe(true);
    expect(app.accessibility("id:activity-approval-task-b-3-no-id")?.role).toBe("alert");
    expect(app.shows("id:activity-approval-task-b-3-approve")).toBe(false);
    expect(app.shows("id:activity-approval-task-b-3-reject")).toBe(false);
  });

  test("a failed activity.cards shows an alert with Retry and no stale cards", async () => {
    const calls: Call[] = [];
    let fail = false;
    const app = await openActivity(
      activityShell(
        calls,
        () => {
          if (fail) throw refusal("Host busy");
          return [card("task-a", { approvals: [approval()] })];
        },
        () => {
          fail = true;
          return null;
        },
      ),
    );
    app.onDialog(() => "Approve");
    await app.press("id:activity-approval-task-a-3-approve");
    await app.waitFor("id:activity-error");
    expect(app.accessibility("id:activity-error")?.role).toBe("alert");
    expect(app.shows("text:Activity unavailable: Host busy")).toBe(true);
    expect(app.shows("id:activity-card-task-a")).toBe(false);

    fail = false;
    await app.press("id:activity-retry");
    await app.waitFor("id:activity-error", { state: "gone" });
    await app.waitFor("id:activity-card-task-a");
    expect(cardReads(calls)).toBe(3);
  });
});
