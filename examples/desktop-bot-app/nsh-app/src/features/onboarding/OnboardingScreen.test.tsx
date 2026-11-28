import { describe, expect, open, test } from "nsh/test";
import type { ModelChoice, RolePreset } from "../../../../src/host/conversation/catalog.ts";
import type { ConversationSnapshot } from "../../../../src/host/conversation/types.ts";
import type { BotView } from "../../../../src/host/conversation/view.ts";
import type { DeviceView, RuntimeView } from "../../../../src/host/settings/types.ts";

type Call = { method: string; params: any };

const ROLES: readonly RolePreset[] = [{ id: "writer" }];

const CATALOG_MODELS: readonly ModelChoice[] = [
  { id: "pi", label: "Pi", runtime: "pi", mcpToolsets: true, keyProfile: false },
  { id: "claude", label: "Claude Code", runtime: "claude", mcpToolsets: true, keyProfile: false },
  { id: "codex", label: "Codex", runtime: "codex", mcpToolsets: true, keyProfile: false },
  { id: "opencode", label: "OpenCode", runtime: "opencode", mcpToolsets: false, keyProfile: false },
  { id: "grok", label: "Grok", runtime: "grok", mcpToolsets: false, keyProfile: false },
];

function makeDevice(runtimes: readonly RuntimeView[]): DeviceView {
  return {
    paired: true,
    deviceId: "dev-1",
    lifecycle: { phase: "running", connection: "open" },
    activeTaskCount: 0,
    pendingTerminalCommits: 0,
    runtimes,
    clockSkew: { status: "unknown", reason: "not-observed" },
    doctor: { generatedAt: "2026-11-28T00:00:00.000Z", worst: "pass", checks: [] },
  };
}

function onboardingShell(
  calls: Call[],
  options: {
    view: (params: { botId: string | null }) => ConversationSnapshot;
    device: (params: any) => DeviceView;
    saveBot?: (profile: any) => unknown;
  },
) {
  return {
    "byok-nsh-adapter": {
      "ByokShell.start": {
        started: true,
        alreadyStarted: false,
        state: { state: "running", pid: 1, activeWork: 0 },
      },
      "ByokShell.call": (method: string, params: any) => {
        calls.push({ method, params });
        if (method === "keys.list") return [];
        if (method === "k8.view") return options.view(params);
        if (method === "settings.device") return options.device(params);
        if (method === "k8.saveBot") return options.saveBot ? options.saveBot(params) : null;
        if (method === "k8.memory") return { resident: null, notes: null, lastDream: null, nextDream: null };
        return null;
      },
    },
  };
}

const count = (calls: Call[], method: string) => calls.filter((call) => call.method === method).length;

describe("OnboardingScreen (#2547)", () => {
  test("signed-in CLI Continue retries idempotently with the same Bot id, reloads k8.view, and opens Conversation", async () => {
    const calls: Call[] = [];
    const savedBots: BotView[] = [];
    let saveAttempts = 0;

    const app = await open("../../../App.tsx", {
      platform: "macos",
      width: 1200,
      height: 860,
      modules: onboardingShell(calls, {
        view: (params) => ({
          bots: savedBots,
          roles: ROLES,
          models: CATALOG_MODELS,
          busy: false,
          ...(params.botId !== null && savedBots.some((bot) => bot.id === params.botId)
            ? { conversation: { botId: params.botId, items: [], cancellable: [] } }
            : {}),
        }),
        device: () =>
          makeDevice([
            { id: "claude", present: true, outcome: "available", version: "2.1.0", verdict: "allow", authPresent: true },
          ]),
        saveBot: (profile) => {
          saveAttempts += 1;
          if (saveAttempts === 1) {
            throw Object.assign(new Error("Host busy saving"), { code: "method_failed" });
          }
          savedBots.push({ ...profile, archived: false, state: "idle" });
          return null;
        },
      }),
    });

    await app.waitFor("id:onboarding-cli-claude");
    expect(app.accessibility("id:onboarding-cli-claude")?.selected).toBe(true);
    expect(app.accessibility("id:onboarding-cli-claude-status")?.label).toBe("signed in");
    expect(app.enabled("id:onboarding-continue")).toBe(true);

    // First attempt fails: stays on onboarding with role="alert" banner.
    await app.press("id:onboarding-continue");
    await app.waitFor("id:onboarding-save-error");
    expect(app.accessibility("id:onboarding-save-error")?.role).toBe("alert");
    expect(app.shows("text:The operation failed.")).toBe(true);
    expect(app.shows("text:Host busy saving")).toBe(false);
    expect(app.shows("id:onboarding-screen")).toBe(true);

    // Retry sends the exact same generated id and transitions to Conversation with the Bot selected.
    await app.press("id:onboarding-continue");
    await app.waitFor("id:onboarding-screen", { state: "gone" });
    await app.waitFor("id:conversation-section");
    expect(app.accessibility("id:nav-conversation")?.selected).toBe(true);

    const savePayloads = calls.filter((call) => call.method === "k8.saveBot").map((call) => call.params);
    expect(savePayloads).toHaveLength(2);
    expect(savePayloads[0]).toEqual(savePayloads[1]);
    expect(savePayloads[1]).toEqual({
      id: savePayloads[0].id,
      name: "Writer",
      role: "Writes and edits text",
      persona: "Clear, short sentences. Ask when the audience is unclear.",
      model: "claude",
    });
    expect(typeof savePayloads[0].id).toBe("string");
    expect(savePayloads[0].id.length).toBeGreaterThan(0);

    await app.waitFor(`id:conv-bot-${savePayloads[0].id}`);
    expect(app.accessibility(`id:conv-bot-${savePayloads[0].id}`)?.selected).toBe(true);
    const k8Views = calls.filter((call) => call.method === "k8.view");
    expect(k8Views.some((call) => call.params?.botId === savePayloads[0].id)).toBe(true);
  });

  test("signed-out CLI is disabled with selectable sign-in command (no copy button); Check again enables Continue", async () => {
    const calls: Call[] = [];
    const savedBots: BotView[] = [];
    let signedIn = false;

    const app = await open("../../../App.tsx", {
      platform: "macos",
      width: 1200,
      height: 860,
      modules: onboardingShell(calls, {
        view: () => ({ bots: savedBots, roles: ROLES, models: CATALOG_MODELS, busy: false }),
        device: (params) => {
          if (params?.checkAuth === true) {
            signedIn = true;
          }
          return makeDevice([
            {
              id: "claude",
              present: true,
              outcome: "available",
              version: "2.1.0",
              verdict: "allow",
              authPresent: signedIn,
            },
          ]);
        },
        saveBot: (profile) => {
          savedBots.push({ ...profile, archived: false, state: "idle" });
          return null;
        },
      }),
    });

    await app.waitFor("id:onboarding-cli-claude");
    expect(app.enabled("id:onboarding-cli-claude")).toBe(false);
    expect(app.accessibility("id:onboarding-cli-claude")?.disabled).toBe(true);
    expect(app.accessibility("id:onboarding-cli-claude-status")?.label).toBe("signed out");
    expect(app.shows("text:○")).toBe(true);
    expect(app.shows("id:onboarding-cli-claude-signin-cmd")).toBe(true);
    expect(app.shows("text:claude auth login")).toBe(true);
    expect(app.shows("text:Copy")).toBe(false);
    expect(app.enabled("id:onboarding-continue")).toBe(false);

    // Check again probes authPresent and auto-selects Claude once signed in.
    await app.press("id:onboarding-check-again");
    await app.waitUntil(() => app.accessibility("id:onboarding-cli-claude-status")?.label === "signed in");
    expect(app.shows("id:onboarding-cli-claude-signin")).toBe(false);
    expect(app.enabled("id:onboarding-cli-claude")).toBe(true);
    expect(app.accessibility("id:onboarding-cli-claude")?.selected).toBe(true);
    expect(app.enabled("id:onboarding-continue")).toBe(true);

    const deviceCalls = calls.filter((call) => call.method === "settings.device");
    expect(deviceCalls).toHaveLength(2);
    expect(deviceCalls[0]?.params).toBeNull();
    expect(deviceCalls[1]?.params).toEqual({ checkAuth: true });

    await app.press("id:onboarding-continue");
    await app.waitFor("id:conversation-section");
    expect(count(calls, "k8.saveBot")).toBe(1);
  });

  test("hides not-installed and unreported runtimes, disables blocked/timed-out entries, and omits Pi from CLI rows", async () => {
    const calls: Call[] = [];

    const app = await open("../../../App.tsx", {
      platform: "macos",
      width: 1200,
      height: 860,
      modules: onboardingShell(calls, {
        view: () => ({ bots: [], roles: ROLES, models: CATALOG_MODELS, busy: false }),
        device: () =>
          makeDevice([
            { id: "pi", present: true, outcome: "available", version: "1.3.0", verdict: "allow" },
            { id: "claude", present: false, outcome: "not-found", reason: "not on PATH" },
            { id: "codex", present: true, outcome: "available", version: "0.1.0", verdict: "block", authPresent: true },
            { id: "opencode", present: false, outcome: "timeout" },
          ]),
      }),
    });

    await app.waitFor("id:onboarding-cli-codex");
    expect(app.shows("id:onboarding-cli-claude")).toBe(false);
    expect(app.shows("id:onboarding-cli-grok")).toBe(false);
    expect(app.shows("id:onboarding-cli-pi")).toBe(false);

    expect(app.enabled("id:onboarding-cli-codex")).toBe(false);
    expect(app.accessibility("id:onboarding-cli-codex-status")?.label).toBe("version blocked");
    expect(app.enabled("id:onboarding-cli-opencode")).toBe(false);
    expect(app.accessibility("id:onboarding-cli-opencode-status")?.label).toBe("check timed out");

    expect(app.enabled("id:onboarding-continue")).toBe(false);
    expect(app.shows("id:onboarding-pi-key")).toBe(true);
    expect(app.enabled("id:onboarding-pi-key")).toBe(true);
  });

  test("zero selectable CLIs disables Continue and Pi with your own key dismisses onboarding to Keys", async () => {
    const calls: Call[] = [];

    const app = await open("../../../App.tsx", {
      platform: "macos",
      width: 1200,
      height: 860,
      modules: onboardingShell(calls, {
        view: () => ({ bots: [], roles: ROLES, models: CATALOG_MODELS, busy: false }),
        device: () =>
          makeDevice([
            { id: "codex", present: false, outcome: "not-found" },
            { id: "claude", present: true, outcome: "available", version: "2.1.0", verdict: "allow", authPresent: false },
          ]),
      }),
    });

    await app.waitFor("id:onboarding-no-selectable");
    expect(app.enabled("id:onboarding-continue")).toBe(false);
    expect(app.enabled("id:onboarding-pi-key")).toBe(true);

    await app.press("id:onboarding-pi-key");
    await app.waitFor("id:onboarding-screen", { state: "gone" });
    await app.waitFor("id:keys-screen");
    expect(app.accessibility("id:nav-keys")?.selected).toBe(true);
  });

  test("never shows onboarding or calls settings.device when a Bot (even archived) or a Pi key profile exists", async () => {
    // Path (a): archived Bot exists.
    const archivedCalls: Call[] = [];
    const archivedBot: BotView = {
      id: "bot-archived",
      name: "Old Writer",
      role: "Writes",
      persona: "Short.",
      model: "claude",
      archived: true,
      state: "archived",
    };
    const archivedApp = await open("../../../App.tsx", {
      platform: "macos",
      width: 1200,
      height: 860,
      modules: onboardingShell(archivedCalls, {
        view: () => ({ bots: [archivedBot], roles: ROLES, models: CATALOG_MODELS, busy: false }),
        device: () => makeDevice([]),
      }),
    });

    await archivedApp.waitFor("id:keys-screen");
    expect(archivedApp.shows("id:onboarding-screen")).toBe(false);
    expect(count(archivedCalls, "settings.device")).toBe(0);

    // Path (b): zero Bots, but a Pi BYOK key profile model exists.
    const keyProfileCalls: Call[] = [];
    const keyProfileApp = await open("../../../App.tsx", {
      platform: "macos",
      width: 1200,
      height: 860,
      modules: onboardingShell(keyProfileCalls, {
        view: () => ({
          bots: [],
          roles: ROLES,
          models: [
            ...CATALOG_MODELS,
            { id: "pi:work", label: "Work key", runtime: "pi", mcpToolsets: true, keyProfile: true },
          ],
          busy: false,
        }),
        device: () => makeDevice([]),
      }),
    });

    await keyProfileApp.waitFor("id:keys-screen");
    expect(keyProfileApp.shows("id:onboarding-screen")).toBe(false);
    expect(count(keyProfileCalls, "settings.device")).toBe(0);
  });
});
