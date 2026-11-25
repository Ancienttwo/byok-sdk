import { describe, expect, open, test } from "nsh/test";
import type { ConversationSnapshot } from "../../../../src/host/conversation/types.ts";
import type { BotView, ConversationItem } from "../../../../src/host/conversation/view.ts";

type Call = { method: string; params: any };

const ROLES = [{ id: "writer", label: "Writer", role: "Writes and edits text", persona: "Clear, short sentences." }];
const MODELS = [{ id: "zai-chat", label: "ZAI Chat" }];

function bot(id: string, overrides: Partial<BotView> = {}): BotView {
  return { id, name: `Bot ${id}`, role: "Writes", persona: "Short.", model: "zai-chat", archived: false, state: "idle", ...overrides };
}

function snapshot(
  bots: readonly BotView[],
  conversation?: { botId: string; items: readonly ConversationItem[]; cancellable?: readonly string[] },
  busy = false,
): ConversationSnapshot {
  return {
    bots,
    roles: ROLES,
    models: MODELS,
    busy,
    ...(conversation === undefined ? {} : { conversation: { cancellable: [], ...conversation } }),
  };
}

/**
 * A started shell whose Host runs; `view` answers `k8.view`, `command` the other k8 methods (null by default).
 * Every bridge call lands in `calls`.
 */
function conversationShell(
  calls: Call[],
  view: (params: { botId: string | null }) => unknown,
  command: (method: string, params: any) => unknown = () => null,
) {
  return {
    "byok-nsh-adapter": {
      "ByokShell.start": { started: true, alreadyStarted: false, state: { state: "running", pid: 1, activeWork: 0 } },
      "ByokShell.call": (method: string, params: any) => {
        calls.push({ method, params });
        if (method === "keys.list") return [];
        if (method === "k8.view") return view(params);
        return command(method, params);
      },
    },
  };
}

async function openConversation(modules: ReturnType<typeof conversationShell>, platform: "macos" | "windows" = "macos") {
  const app = await open("../../../App.tsx", { platform, width: 1280, height: 900, modules });
  await app.press("id:nav-conversation");
  return app;
}

const views = (calls: Call[]) => calls.filter((call) => call.method === "k8.view");

describe("ConversationScreen (#2461 Slice 4)", () => {
  test("one k8.view serves Keys and Conversation: section switches never read it again", async () => {
    const calls: Call[] = [];
    const app = await open("../../../App.tsx", {
      platform: "macos",
      width: 1280,
      height: 900,
      modules: conversationShell(calls, () => snapshot([bot("a")])),
    });
    await app.waitUntil(() => views(calls).length === 1);
    await app.press("id:nav-conversation");
    await app.waitFor("id:conv-bot-a");
    await app.press("id:nav-keys");
    await app.press("id:nav-conversation");
    await app.press("id:nav-settings");
    await app.press("id:nav-keys");
    await app.wait(50);
    expect(views(calls)).toEqual([{ method: "k8.view", params: { botId: null } }]);
  });

  test("switching Bots reads each Bot's conversation", async () => {
    const calls: Call[] = [];
    const bots = [bot("a", { state: "working" }), bot("b", { state: "waiting" })];
    const app = await openConversation(
      conversationShell(calls, (params) =>
        snapshot(
          bots,
          params.botId === null
            ? undefined
            : { botId: params.botId, items: [{ kind: "input", key: "e1", text: `Hello ${params.botId}`, at: 1, folded: false }] },
        ),
      ),
    );
    await app.waitFor("id:conv-bot-a");
    expect(app.shows("text:Select a Bot.")).toBe(true);
    expect(app.accessibility("id:conv-bot-a-state")?.label).toBe("Working");
    expect(app.accessibility("id:conv-bot-b-state")?.label).toBe("Waiting for you");

    await app.press("id:conv-bot-a");
    await app.waitFor("text:Hello a");
    expect(app.accessibility("id:conv-bot-a")?.selected).toBe(true);

    await app.press("id:conv-bot-b");
    await app.waitFor("text:Hello b");
    expect(app.shows("text:Hello a")).toBe(false);
    expect(app.accessibility("id:conv-bot-a")?.selected).toBe(false);
    expect(app.accessibility("id:conv-bot-b")?.selected).toBe(true);
    expect(views(calls).map((call) => call.params.botId)).toEqual([null, "a", "b"]);
  });

  test("a failed k8.view keeps the last snapshot under an alert without the previous Bot's transcript, and Retry reads again", async () => {
    const calls: Call[] = [];
    let fail = false;
    const app = await openConversation(
      conversationShell(calls, (params) => {
        if (fail) {
          throw Object.assign(new Error("Host busy"), { code: "host_busy" });
        }
        return snapshot(
          [bot("a"), bot("b")],
          params.botId === null
            ? undefined
            : { botId: params.botId, items: [{ kind: "input", key: "e1", text: `Hello ${params.botId}`, at: 1, folded: false }] },
        );
      }),
    );
    await app.press("id:conv-bot-a");
    await app.waitFor("text:Hello a");
    fail = true;
    await app.press("id:conv-bot-b");
    await app.waitFor("id:conv-view-error");
    expect(app.accessibility("id:conv-view-error")?.role).toBe("alert");
    // The resource keeps Bot a's snapshot after the failure: the rail stays, Bot a's transcript does not show under b.
    expect(app.shows("id:conv-bot-a")).toBe(true);
    expect(app.shows("text:Hello a")).toBe(false);
    expect(app.shows("id:conv-composer-input")).toBe(false);

    fail = false;
    await app.press("id:conv-view-retry");
    await app.waitFor("id:conv-view-error", { state: "gone" });
    await app.waitFor("text:Hello b");
    expect(views(calls).map((call) => call.params.botId)).toEqual([null, "a", "b", "b"]);
  });

  test("a busy view is read again after BUSY_REREAD_MS and the streaming draft updates in place", async () => {
    const calls: Call[] = [];
    const drafts = ["Drafting **the", "Drafting **the answer**"];
    const app = await openConversation(
      conversationShell(calls, (params) => {
        if (params.botId === null) {
          return snapshot([bot("a", { state: "working" })], undefined, true);
        }
        const index = Math.min(views(calls).filter((call) => call.params.botId === "a").length - 1, drafts.length - 1);
        const streaming = index < drafts.length - 1;
        return snapshot(
          [bot("a", { state: streaming ? "working" : "idle" })],
          {
            botId: "a",
            cancellable: streaming ? ["t1"] : [],
            items: [
              { kind: "input", key: "e1", text: "Write it", at: 1, folded: false },
              { kind: "working", key: "tt1", turnId: "t1", draft: { text: drafts[index], state: "open" } },
            ],
          },
          streaming,
        );
      }),
    );
    await app.press("id:conv-bot-a");
    await app.waitFor("id:conv-draft-t1");
    expect(app.texts().some((text) => text.includes("Drafting"))).toBe(true);
    expect(app.texts().some((text) => text.includes("answer"))).toBe(false);

    await app.waitUntil(() => app.texts().some((text) => text.includes("answer")), { timeout: 4000 });
    expect(views(calls).filter((call) => call.params.botId === "a").length).toBe(2);
    await app.wait(1700);
    expect(views(calls).filter((call) => call.params.botId === "a").length).toBe(2);
  });

  test("a failed send keeps its action id for a retry of the same text; edited text starts a new one", async () => {
    const calls: Call[] = [];
    let sends = 0;
    const app = await openConversation(
      conversationShell(
        calls,
        (params) => snapshot([bot("a")], params.botId === null ? undefined : { botId: "a", items: [] }),
        (method) => {
          if (method === "k8.send") {
            sends += 1;
            if (sends === 1) throw Object.assign(new Error("Host restarting"), { code: "host_exited" });
            return { turnId: `t${sends}` };
          }
          return null;
        },
      ),
    );
    await app.press("id:conv-bot-a");
    await app.waitFor("id:conv-composer-input");
    await app.type("id:conv-composer-input", "Hi there");
    await app.submit("id:conv-composer-input");
    await app.waitFor("id:conv-composer-error");
    expect(app.value("id:conv-composer-input")).toBe("Hi there");

    await app.press("id:conv-send");
    await app.waitUntil(() => app.value("id:conv-composer-input") === "");
    await app.type("id:conv-composer-input", "Next");
    await app.submit("id:conv-composer-input");
    await app.waitUntil(() => app.value("id:conv-composer-input") === "");

    const sent = calls.filter((call) => call.method === "k8.send").map((call) => call.params);
    expect(sent.length).toBe(3);
    expect(sent[0].text).toBe("Hi there");
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[2].text).toBe("Next");
    expect(sent[2].actionId === sent[0].actionId).toBe(false);
    expect(sent.every((params) => params.botId === "a")).toBe(true);
  });

  test("Cancel Turn cancels the oldest open Turn, Clear context sends a clear, and the composer locks for an archived Bot", async () => {
    const calls: Call[] = [];
    const app = await openConversation(
      conversationShell(calls, (params) => {
        const bots = [bot("a", { state: "working" }), bot("z", { archived: true, state: "archived" })];
        if (params.botId === "a") return snapshot(bots, { botId: "a", items: [], cancellable: ["t1", "t2"] });
        if (params.botId === "z") return snapshot(bots, { botId: "z", items: [] });
        return snapshot(bots);
      }),
    );
    await app.press("id:conv-bot-a");
    await app.waitFor("id:conv-cancel-turn");
    await app.press("id:conv-cancel-turn");
    await app.waitUntil(() => calls.some((call) => call.method === "k8.cancel"));
    await app.waitUntil(() => app.enabled("id:conv-clear"));
    await app.press("id:conv-clear");
    await app.waitUntil(() => calls.some((call) => call.method === "k8.clear"));
    expect(calls.find((call) => call.method === "k8.cancel")?.params).toEqual({ turnId: "t1" });
    const clear = calls.find((call) => call.method === "k8.clear")?.params;
    expect(clear.botId).toBe("a");
    expect(typeof clear.actionId).toBe("string");

    await app.press("id:conv-bot-z");
    await app.waitFor("text:This Bot is archived. Archiving is permanent; its conversation stays readable.");
    expect(app.enabled("id:conv-composer-input")).toBe(false);
    expect(app.enabled("id:conv-send")).toBe(false);
    expect(app.enabled("id:conv-clear")).toBe(false);
    expect(app.shows("id:conv-edit-profile")).toBe(false);
  });

  test("questions take a single-choice or a text answer through k8.answer", async () => {
    const calls: Call[] = [];
    const app = await openConversation(
      conversationShell(calls, (params) =>
        snapshot(
          [bot("a", { state: "waiting" })],
          params.botId === null
            ? undefined
            : {
                botId: "a",
                items: [
                  {
                    kind: "question",
                    key: "qq1",
                    id: "q1",
                    question: { question: "Which tone?", answerKind: "single_choice", options: [{ id: "warm", label: "Warm" }, { id: "dry", label: "Dry" }] },
                  },
                  { kind: "question", key: "qq2", id: "q2", question: { question: "Audience?", answerKind: "text" } },
                  { kind: "question", key: "qq3", id: "q3", question: { question: "Done?", answerKind: "text" }, answer: "yes" },
                ],
              },
        ),
      ),
    );
    await app.press("id:conv-bot-a");
    await app.waitFor("text:Which tone?");
    expect(app.shows("text:Answered: yes")).toBe(true);
    await app.press("id:conv-answer-q1-dry");
    await app.type("id:conv-answer-q2", "Engineers");
    await app.press("id:conv-answer-q2-submit");
    await app.waitUntil(() => calls.filter((call) => call.method === "k8.answer").length === 2);
    expect(calls.filter((call) => call.method === "k8.answer").map((call) => call.params)).toEqual([
      { questionId: "q1", answer: "dry" },
      { questionId: "q2", answer: "Engineers" },
    ]);
  });

  test("New by role saves under one id across a retry, then selects the new Bot", async () => {
    const calls: Call[] = [];
    let saves = 0;
    const app = await openConversation(
      conversationShell(
        calls,
        (params) => snapshot([bot("a")], params.botId === null ? undefined : { botId: params.botId, items: [] }),
        (method) => {
          if (method === "k8.saveBot") {
            saves += 1;
            if (saves === 1) throw Object.assign(new Error("Host restarting"), { code: "host_exited" });
          }
          return null;
        },
      ),
    );
    await app.waitFor("id:conv-new-by-role");
    await app.press("id:conv-new-by-role");
    await app.press("id:conv-new-writer");
    await app.waitFor("id:conv-profile");
    expect(app.value("id:conv-profile-name")).toBe("Writer");
    await app.press("id:conv-profile-save");
    await app.waitFor("id:conv-profile-error");
    await app.press("id:conv-profile-save");
    await app.waitFor("id:conv-profile", { state: "gone" });

    const saved = calls.filter((call) => call.method === "k8.saveBot").map((call) => call.params);
    expect(saved.length).toBe(2);
    expect(saved[1]).toEqual(saved[0]);
    expect(saved[0]).toMatchObject({ name: "Writer", role: "Writes and edits text", persona: "Clear, short sentences.", model: "zai-chat" });
    await app.waitUntil(() => views(calls).some((call) => call.params.botId === saved[0].id));
  });

  test("Archive asks first: Escape and Keep Bot keep it, Archive permanently archives it", async () => {
    const calls: Call[] = [];
    const app = await openConversation(
      conversationShell(calls, (params) => snapshot([bot("a")], params.botId === null ? undefined : { botId: "a", items: [] })),
    );
    await app.press("id:conv-bot-a");
    await app.press("id:conv-edit-profile");
    await app.press("id:conv-profile-archive");
    await app.waitFor("id:conv-archive-dialog");
    expect(app.accessibility("id:conv-archive-dialog")?.role).toBe("alertdialog");
    await app.keyboard.press("escape");
    await app.waitFor("id:conv-archive-dialog", { state: "gone" });

    await app.press("id:conv-profile-archive");
    await app.press("id:conv-archive-keep");
    await app.waitFor("id:conv-archive-dialog", { state: "gone" });
    expect(calls.some((call) => call.method === "k8.archiveBot")).toBe(false);

    await app.press("id:conv-profile-archive");
    await app.press("id:conv-archive-confirm");
    await app.waitFor("id:conv-profile", { state: "gone" });
    expect(calls.filter((call) => call.method === "k8.archiveBot").map((call) => call.params)).toEqual([{ id: "a" }]);
  });

  test("folded history opens per Bot and stays open across Bot switches", async () => {
    const calls: Call[] = [];
    const items = (botId: string): ConversationItem[] => [
      { kind: "input", key: "e1", text: `Old ${botId}`, at: 1, folded: true },
      { kind: "clear", key: "e2", at: 2 },
      { kind: "input", key: "e3", text: `New ${botId}`, at: 3, folded: false },
    ];
    const app = await openConversation(
      conversationShell(calls, (params) =>
        snapshot([bot("a"), bot("b")], params.botId === null ? undefined : { botId: params.botId, items: items(params.botId) }),
      ),
    );
    await app.press("id:conv-bot-a");
    await app.waitFor("text:New a");
    expect(app.shows("text:Old a")).toBe(false);
    await app.press("text:Show 1 earlier messages");
    await app.waitFor("text:Old a");

    await app.press("id:conv-bot-b");
    await app.waitFor("text:New b");
    expect(app.shows("text:Old b")).toBe(false);
    expect(app.shows("text:Show 1 earlier messages")).toBe(true);

    await app.press("id:conv-bot-a");
    await app.waitFor("text:New a");
    expect(app.shows("text:Old a")).toBe(true);
    expect(app.shows("text:Hide 1 earlier messages")).toBe(true);
  });

  test("a reply's link goes only through the links.ts allowlist (the brand allows no origin)", async () => {
    const calls: Call[] = [];
    const app = await openConversation(
      conversationShell(calls, (params) =>
        snapshot(
          [bot("a")],
          params.botId === null
            ? undefined
            : { botId: "a", items: [{ kind: "reply", key: "e1", text: "[guide](https://example.org/docs)", at: 1, folded: false }] },
        ),
      ),
    );
    await app.press("id:conv-bot-a");
    await app.waitFor("text:guide");
    await app.press("text:guide");
    await app.wait(20);
    expect(app.openedUrls()).toEqual([]);
  });

  test("Windows composer keeps CJK text", async () => {
    const calls: Call[] = [];
    const app = await openConversation(
      conversationShell(calls, (params) => snapshot([bot("a")], params.botId === null ? undefined : { botId: "a", items: [] })),
      "windows",
    );
    await app.press("id:conv-bot-a");
    await app.waitFor("id:conv-composer-input");
    await app.type("id:conv-composer-input", "你好，机器人");
    expect(app.value("id:conv-composer-input")).toBe("你好，机器人");
  });
});
