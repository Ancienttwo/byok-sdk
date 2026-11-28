import type { ProviderStatus } from "@byok-sdk/keys";
import { describe, expect, open, test } from "nsh/test";
import type { SupervisedHostState } from "../../../../src/bridge/protocol.ts";
import { buildApplicationMenuItems, buildTrayMenuItems, fitIntoWorkArea } from "../../desktop.ts";
import { BridgeCallError } from "../../bridge.ts";
import { describeHostState, trayStatusLabel, type ShellStart } from "../../store.ts";

const RUNNING_HOST: SupervisedHostState = { state: "running", pid: 4100, activeWork: 0 };
const RETURNING_BOT = {
  id: "bot-1",
  name: "Writer",
  role: "Writes",
  persona: "Short.",
  model: "claude",
  archived: false,
  state: "idle",
};
const PENDING: ShellStart = { status: "pending" };
const STARTED: ShellStart = { status: "started" };
const START_FAILED: ShellStart = {
  status: "failed",
  error: new BridgeCallError("host_exited", "No packaged Host binary"),
};

function makeStoredStatus(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    profile_ref: "zai-tray",
    display_name: "ZAI Tray",
    enabled: true,
    provider_kind: "zai",
    adapter: "openai_compatible",
    auth_mode: "bearer",
    base_url: "https://api.z.ai/api/coding/paas/v4",
    model: "glm-4.7",
    capabilities: [],
    created_at: "2026-11-25T00:00:00.000Z",
    profile_revision: "rev-1",
    profile_hash: "0".repeat(64),
    secret_configured: true,
    configuration_pending: false,
    updated_at: "2026-11-25T00:00:00.000Z",
    pi_model: {
      api: "openai-completions",
      contextWindow: 204800,
      maxTokens: 131072,
      reasoning: true,
      thinkingLevel: "medium",
      compat: {
        supportsStore: false,
        supportsReasoningEffort: false,
        maxTokensField: "max_tokens",
        thinkingFormat: "zai",
      },
    },
    ...overrides,
  };
}

function shellModules(
  hostState: SupervisedHostState | null,
  onCall: (method: string, params: unknown) => unknown | Promise<unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    "byok-nsh-adapter": {
      "ByokShell.start": { started: true, alreadyStarted: false, state: hostState },
      "ByokShell.call": onCall,
      ...extra,
    },
  };
}

describe("BYOK NSH Shell, Recovery, Tray & Login Item (Slice 3)", () => {
  test("sidebar switches workspace sections with zero hidden trees and isolates Gallery preview", async () => {
    let k8ViewCalls = 0;
    const app = await open("../../../App.tsx", {
      platform: "macos",
      width: 1200,
      height: 820,
      modules: shellModules(RUNNING_HOST, (method) => {
        if (method === "keys.list") {
          return [makeStoredStatus()];
        }
        if (method === "k8.view") {
          k8ViewCalls += 1;
          return {
            bots: [],
            roles: [],
            models: [{ id: "zai/glm-4.7", label: "ZAI GLM-4.7", runtime: "pi", mcpToolsets: true, keyProfile: true }],
            busy: false,
          };
        }
        return null;
      }),
    });

    await app.waitFor("id:keys-bot-model-zai/glm-4.7");
    expect(app.accessibility("id:nav-keys")?.selected).toBe(true);
    expect(app.shows("text:BYOK Bots — Keys")).toBe(true);
    expect(app.shows("id:keys-screen")).toBe(true);
    expect(app.shows("id:conversation-section")).toBe(false);
    expect(app.shows("id:activity-section")).toBe(false);
    expect(app.shows("id:settings-section")).toBe(false);
    expect(app.shows("id:host-preview-failed")).toBe(false);

    await app.press("id:nav-conversation");
    await app.waitFor("id:conversation-section");
    expect(app.accessibility("id:nav-conversation")?.selected).toBe(true);
    expect(app.accessibility("id:nav-keys")?.selected).toBe(false);
    expect(app.shows("text:BYOK Bots — Conversation")).toBe(true);
    expect(app.shows("id:keys-screen")).toBe(false);
    expect(app.shows("id:activity-section")).toBe(false);
    expect(app.shows("id:settings-section")).toBe(false);

    await app.press("id:nav-activity");
    await app.waitFor("id:activity-section");
    expect(app.accessibility("id:nav-activity")?.selected).toBe(true);
    expect(app.shows("text:BYOK Bots — Activity")).toBe(true);
    expect(app.shows("id:conversation-section")).toBe(false);
    expect(app.shows("id:keys-screen")).toBe(false);

    await app.press("id:nav-settings");
    await app.waitFor("id:settings-section");
    expect(app.accessibility("id:nav-settings")?.selected).toBe(true);
    expect(app.shows("text:BYOK Bots — Settings")).toBe(true);
    expect(app.shows("id:activity-section")).toBe(false);

    // PR #2478 Gatekeeper P2: Gallery host preview stays visual-only and never disables live k8.view.
    await app.press("id:nav-gallery");
    await app.waitFor("id:host-preview-failed");
    expect(app.shows("text:BYOK Bots — Foundations Gallery")).toBe(true);
    expect(app.shows("id:settings-section")).toBe(false);
    await app.press("id:host-preview-failed");
    expect(app.shows("text:Failed")).toBe(true);

    await app.press("id:nav-keys");
    await app.waitFor("id:keys-screen");
    expect(app.shows("text:Running (0 active)")).toBe(true);
    expect(app.shows("id:shell-recovery-panel")).toBe(false);
    expect(app.shows("id:shell-failed-panel")).toBe(false);
    expect(app.shows("id:keys-bot-model-zai/glm-4.7")).toBe(true);
    expect(app.enabled("id:keys-models-refresh-btn")).toBe(true);
    // One store-owned k8.view load: remounting the Keys section neither reloads nor drops it.
    expect(k8ViewCalls).toBe(1);
  });

  test("close-to-tray hides main window and preserves active keys.submit lock across reopen", async () => {
    const initial = makeStoredStatus();
    const updated = makeStoredStatus({ display_name: "Renamed ZAI Tray", profile_revision: "rev-2" });
    let listCalls = 0;
    let submitCalls = 0;
    let releaseSubmit = () => {};
    const submitGate = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });

    const app = await open("../../../App.tsx", {
      platform: "macos",
      width: 1200,
      height: 820,
      modules: shellModules(RUNNING_HOST, async (method) => {
        if (method === "keys.list") {
          listCalls += 1;
          return listCalls === 1 ? [initial] : [updated];
        }
        if (method === "keys.submit") {
          submitCalls += 1;
          await submitGate;
          return updated;
        }
        if (method === "k8.view") {
          return { bots: [RETURNING_BOT], roles: [], models: [], busy: false };
        }
        return null;
      }),
    });

    await app.waitFor("id:keys-stored-zai-tray");
    await app.press("id:keys-stored-zai-tray");
    await app.clear("id:keys-field-display_name");
    await app.type("id:keys-field-display_name", "Renamed ZAI Tray");
    expect(app.enabled("id:keys-save-btn")).toBe(true);

    const saving = app.press("id:keys-save-btn");
    await app.waitUntil(() => submitCalls === 1 && !app.enabled("id:keys-save-btn"));

    await app.window("main").pressClose();
    expect(app.quit()).toBe(false);
    expect(app.window("main").state()?.visible).toBe(false);

    await app.reopen();
    expect(app.quit()).toBe(false);
    expect(app.window("main").state()?.visible).toBe(true);
    expect(app.shows("id:keys-screen")).toBe(true);
    expect(app.enabled("id:keys-save-btn")).toBe(false);
    expect(submitCalls).toBe(1);

    releaseSubmit();
    await saving;
    await app.waitFor("id:keys-receipt");
    expect(app.shows("text:Saved Renamed ZAI Tray")).toBe(true);
  });

  test("RecoveryPanel handles stopped S1 restore, Escape dismissal, refusal, startFresh, and diagnostics", async () => {
    const calls: string[] = [];
    const stoppedHost: SupervisedHostState = {
      state: "stopped",
      pid: 4100,
      reason: "Store schema is newer than this binary",
      storeRefused: true,
    };

    const app = await open("../../../App.tsx", {
      platform: "macos",
      width: 1200,
      height: 820,
      modules: shellModules(stoppedHost, (method) => {
        calls.push(method);
        if (method === "shell.state") {
          return {
            host: stoppedHost,
            restore: { version: "0.45.0", createdAt: "2026-11-24T00:00:00.000Z" },
            restoreError: null,
          };
        }
        if (method === "settings.exportDiagnostics") {
          return { path: "/tmp/byok-diagnostics.json" };
        }
        if (method === "shell.restore") {
          throw new Error("Snapshot directory locked");
        }
        if (method === "shell.startFresh") {
          return { moved: [{ from: "/tmp/data", to: "/tmp/data.aside-2" }] };
        }
        if (method === "keys.list") {
          return [];
        }
        return null;
      }),
    });

    await app.waitFor("id:shell-recovery-panel");
    expect(app.shows("text:The Host stopped")).toBe(true);
    expect(app.shows("text:Store schema is newer than this binary")).toBe(true);
    await app.waitFor("id:recovery-restore-btn");
    expect(app.shows("text:Restore data of version 0.45.0")).toBe(true);
    expect(app.shows("id:recovery-start-fresh-btn")).toBe(true);

    await app.press("id:recovery-export-diagnostics");
    await app.waitFor("id:recovery-export-diagnostics-status");
    expect(app.shows("text:Written to /tmp/byok-diagnostics.json")).toBe(true);

    // Escape closes alertdialog without running shell.restore.
    await app.press("id:recovery-restore-btn");
    await app.waitFor("id:recovery-restore-dialog");
    expect(app.accessibility("id:recovery-restore-dialog")?.role).toBe("alertdialog");
    await app.keyboard.press("escape");
    await app.waitUntil(() => !app.shows("id:recovery-restore-dialog"));
    expect(calls.includes("shell.restore")).toBe(false);

    // Restore refusal displays clear error and re-enables recovery controls.
    await app.press("id:recovery-restore-btn");
    await app.waitFor("id:recovery-restore-confirm");
    await app.press("id:recovery-restore-confirm");
    await app.waitFor("id:recovery-error");
    expect(app.texts().join("\n")).toContain("Restore failed:");
    expect(app.texts().join("\n")).toContain("Snapshot directory locked");
    expect(app.enabled("id:recovery-start-fresh-btn")).toBe(true);

    // Start fresh confirms and calls shell.startFresh.
    await app.press("id:recovery-start-fresh-btn");
    await app.waitFor("id:recovery-start-fresh-dialog");
    await app.press("id:recovery-start-fresh-confirm");
    await app.waitUntil(() => calls.includes("shell.startFresh"));
    expect(calls.filter((entry) => entry === "shell.startFresh")).toHaveLength(1);
    expect(app.enabled("id:sidebar-restart-host")).toBe(false);
    expect(app.enabled("id:recovery-start-fresh-btn")).toBe(false);
  });

  test("RecoveryPanel disables its diagnostics export once the app starts quitting", async () => {
    const stoppedHost: SupervisedHostState = { state: "stopped", pid: 4100, reason: "Host crashed", storeRefused: false };
    const app = await open("../../../App.tsx", {
      platform: "macos",
      width: 1200,
      height: 820,
      modules: shellModules(stoppedHost, (method) => {
        if (method === "shell.state") return { host: stoppedHost, restore: null, restoreError: null };
        if (method === "keys.list") return [];
        return null;
      }),
    });
    await app.waitFor("id:recovery-export-diagnostics");
    expect(app.enabled("id:recovery-export-diagnostics")).toBe(true);
    // The adapter's quit hook hears the request and announces the drain (`ByokShell.onQuitting`).
    await app.quitRequest();
    await app.waitFor("text:Platform: macos • Hints: 0 • Quitting: yes");
    expect(app.enabled("id:recovery-export-diagnostics")).toBe(false);
  });

  test("blocks sidebar Restart Host while shell.restore is in flight and re-enables on refusal", async () => {
    const stoppedHost: SupervisedHostState = {
      state: "stopped",
      pid: 4100,
      reason: "Store schema is newer than this binary",
      storeRefused: true,
    };
    let restoreCalls = 0;
    let restartCalls = 0;
    let rejectRestore = (_err: Error) => {};
    const restoreGate = new Promise<never>((_resolve, reject) => {
      rejectRestore = reject;
    });

    const app = await open("../../../App.tsx", {
      platform: "macos",
      width: 1200,
      height: 820,
      modules: shellModules(
        stoppedHost,
        (method) => {
          if (method === "shell.state") {
            return {
              host: stoppedHost,
              restore: { version: "0.45.0", createdAt: "2026-11-24T00:00:00.000Z" },
              restoreError: null,
            };
          }
          if (method === "shell.restore") {
            restoreCalls += 1;
            return restoreGate;
          }
          if (method === "keys.list") {
            return [];
          }
          return null;
        },
        {
          "ByokShell.restart": () => {
            restartCalls += 1;
          },
        },
      ),
    });

    await app.waitFor("id:recovery-restore-btn");
    expect(app.enabled("id:sidebar-restart-host")).toBe(true);
    await app.press("id:recovery-restore-btn");
    await app.waitFor("id:recovery-restore-confirm");

    const confirming = app.press("id:recovery-restore-confirm");
    await app.waitUntil(() => restoreCalls === 1 && !app.enabled("id:sidebar-restart-host"));
    await app.keyboard.press("mod+shift+r");
    expect(restartCalls).toBe(0);

    rejectRestore(new Error("Restore snapshot corrupt"));
    await confirming;
    await app.waitFor("id:recovery-error");
    expect(app.texts().join("\n")).toContain("Restore snapshot corrupt");
    expect(app.enabled("id:sidebar-restart-host")).toBe(true);
    expect(restartCalls).toBe(0);
  });

  test("RecoveryPanel failed Host card restarts via ByokShell.restart without fetching shell.state", async () => {
    const calls: string[] = [];
    let restartCalls = 0;

    const app = await open("../../../App.tsx", {
      platform: "macos",
      width: 1200,
      height: 820,
      modules: shellModules(
        { state: "failed", reason: "Host exited with status 42" },
        (method) => {
          calls.push(method);
          if (method === "keys.list") {
            return [];
          }
          return null;
        },
        {
          "ByokShell.restart": () => {
            restartCalls += 1;
          },
        },
      ),
    });

    await app.waitFor("id:shell-failed-panel");
    expect(app.shows("text:The Host failed")).toBe(true);
    expect(app.shows("text:Host exited with status 42")).toBe(true);
    expect(app.shows("id:sidebar-restart-host")).toBe(true);
    expect(calls.includes("shell.state")).toBe(false);
    // The exited Host cannot export diagnostics; the card points to Restart Host instead.
    expect(app.shows("id:failed-export-diagnostics")).toBe(false);
    expect(app.shows("id:shell-failed-hint")).toBe(true);

    await app.press("id:recovery-restart-host");
    await app.waitUntil(() => restartCalls === 1);
    expect(restartCalls).toBe(1);

    // The application menu's Restart Host shortcut reaches the same guarded store command.
    await app.keyboard.press("mod+shift+r");
    await app.waitUntil(() => restartCalls === 2);
  });

  test("LoginItemControl lazy-loads on Settings and toggles OS setting", async () => {
    const calls: { method: string; params: unknown }[] = [];
    let enabled = false;

    const app = await open("../../../App.tsx", {
      platform: "macos",
      width: 1200,
      height: 820,
      modules: shellModules(RUNNING_HOST, (method, params) => {
        calls.push({ method, params });
        if (method === "settings.loginItem") {
          return { supported: true, enabled };
        }
        if (method === "settings.setLoginItem") {
          const next = (params as { enabled?: boolean } | null)?.enabled;
          enabled = Boolean(next);
          return { supported: true, enabled };
        }
        if (method === "keys.list") {
          return [];
        }
        if (method === "k8.view") {
          return { bots: [RETURNING_BOT], roles: [], models: [], busy: false };
        }
        return null;
      }),
    });

    await app.waitFor("id:keys-screen");
    expect(calls.some((entry) => entry.method === "settings.loginItem")).toBe(false);

    await app.press("id:nav-settings");
    await app.waitFor("id:login-item-switch");
    expect(calls.filter((entry) => entry.method === "settings.loginItem")).toHaveLength(1);
    expect(app.accessibility("id:login-item-switch")?.checked).toBe("false");

    await app.press("id:login-item-switch");
    await app.waitUntil(() => app.accessibility("id:login-item-switch")?.checked === "true");
    expect(calls.some((entry) => entry.method === "settings.setLoginItem")).toBe(true);
    const setCall = calls.find((entry) => entry.method === "settings.setLoginItem");
    expect(setCall?.params).toEqual({ enabled: true });
  });

  test("LoginItemControl shows non-toggle notice on unsupported Linux platform", async () => {
    const app = await open("../../../App.tsx", {
      platform: "linux",
      width: 1200,
      height: 820,
      modules: shellModules(RUNNING_HOST, (method) => {
        if (method === "settings.loginItem") {
          return { supported: false, enabled: false };
        }
        if (method === "keys.list") {
          return [];
        }
        if (method === "k8.view") {
          return { bots: [RETURNING_BOT], roles: [], models: [], busy: false };
        }
        return null;
      }),
    });

    await app.press("id:nav-settings");
    await app.waitFor("id:login-item-unsupported");
    expect(app.shows("text:Not available on this platform.")).toBe(true);
    expect(app.shows("id:login-item-switch")).toBe(false);
  });

  test("trayStatusLabel, describeHostState, buildTrayMenuItems, and buildApplicationMenuItems map all Host states", () => {
    expect(trayStatusLabel(null, PENDING)).toBe("Host starting");
    expect(trayStatusLabel(null, START_FAILED)).toBe("Host stopped: No packaged Host binary");
    expect(trayStatusLabel({ state: "starting", pid: 7 }, STARTED)).toBe("Host starting");
    expect(trayStatusLabel({ state: "running", pid: 7, activeWork: 2 }, STARTED)).toBe("Active tasks: 2");
    expect(trayStatusLabel({ state: "restarting", inMs: 1200, reason: "crash" }, STARTED)).toBe(
      "Host restarting: crash",
    );
    expect(trayStatusLabel({ state: "stopped", pid: 7, reason: "schema mismatch", storeRefused: true }, STARTED)).toBe(
      "Host stopped: schema mismatch",
    );
    expect(trayStatusLabel({ state: "failed", reason: "exit 1" }, STARTED)).toBe("Host failed: exit 1");

    expect(describeHostState(null, PENDING)).toBe("Host starting");
    expect(describeHostState(null, START_FAILED)).toBe("Host stopped: No packaged Host binary");
    expect(describeHostState({ state: "starting", pid: 7 }, STARTED)).toBe("Host starting");
    expect(describeHostState({ state: "running", pid: 7, activeWork: 0 }, STARTED)).toBe("Host running");
    expect(describeHostState({ state: "restarting", inMs: 1200, reason: "oops" }, STARTED)).toBe(
      "Host restarting in 2 s: oops",
    );
    expect(describeHostState({ state: "stopped", pid: 7, reason: "halted", storeRefused: false }, STARTED)).toBe(
      "Host stopped: halted",
    );
    expect(describeHostState({ state: "failed", reason: "boom" }, STARTED)).toBe("Host failed: boom");

    let shown = 0;
    let restarted = 0;
    let quit = 0;
    const trayRunning = buildTrayMenuItems({
      host: { state: "running", pid: 7, activeWork: 2 },
      start: STARTED,
      quitting: false,
      recoveryBusy: false,
      productName: "BYOK Bots",
      onShow: () => {
        shown += 1;
      },
      onRestartHost: () => {
        restarted += 1;
      },
      onQuit: () => {
        quit += 1;
      },
    });
    expect(trayRunning.map((item) => ("type" in item ? item.type : item.label))).toEqual([
      "Show BYOK Bots",
      "Active tasks: 2",
      "separator",
      "Restart Host",
      "separator",
      "Quit",
    ]);
    const showItem = trayRunning[0] as { onSelect?: () => void };
    const statusItem = trayRunning[1] as { disabled?: boolean };
    const restartItem = trayRunning[3] as { disabled?: boolean; onSelect?: () => void };
    const quitItem = trayRunning[5] as { onSelect?: () => void };
    expect(statusItem.disabled).toBe(true);
    expect(restartItem.disabled).toBe(false);
    showItem.onSelect?.();
    restartItem.onSelect?.();
    quitItem.onSelect?.();
    expect(shown).toBe(1);
    expect(restarted).toBe(1);
    expect(quit).toBe(1);

    const trayStarting = buildTrayMenuItems({
      host: { state: "starting", pid: 7 },
      start: STARTED,
      quitting: false,
      recoveryBusy: false,
      productName: "BYOK Bots",
      onShow: () => {},
      onRestartHost: () => {},
      onQuit: () => {},
    });
    expect((trayStarting[3] as { disabled?: boolean }).disabled).toBe(true);

    // A failed start leaves no supervisor: the menu disables Restart Host, as the sidebar hides its button.
    const trayStartFailed = buildTrayMenuItems({
      host: null,
      start: START_FAILED,
      quitting: false,
      recoveryBusy: false,
      productName: "BYOK Bots",
      onShow: () => {},
      onRestartHost: () => {},
      onQuit: () => {},
    });
    expect((trayStartFailed[1] as { label?: string }).label).toBe("Host stopped: No packaged Host binary");
    expect((trayStartFailed[3] as { disabled?: boolean }).disabled).toBe(true);

    const trayQuitting = buildTrayMenuItems({
      host: { state: "failed", reason: "exit" },
      start: STARTED,
      quitting: true,
      recoveryBusy: false,
      productName: "BYOK Bots",
      onShow: () => {},
      onRestartHost: () => {},
      onQuit: () => {},
    });
    expect((trayQuitting[3] as { disabled?: boolean }).disabled).toBe(true);

    const trayRecoveryBusy = buildTrayMenuItems({
      host: { state: "stopped", pid: 7, reason: "halted", storeRefused: true },
      start: STARTED,
      quitting: false,
      recoveryBusy: true,
      productName: "BYOK Bots",
      onShow: () => {},
      onRestartHost: () => {},
      onQuit: () => {},
    });
    expect((trayRecoveryBusy[3] as { disabled?: boolean }).disabled).toBe(true);

    const selectedSections: string[] = [];
    const selectedAppearances: string[] = [];
    const appMenu = buildApplicationMenuItems({
      host: { state: "running", pid: 7, activeWork: 0 },
      start: STARTED,
      quitting: false,
      recoveryBusy: false,
      productName: "BYOK Bots",
      activeSection: "settings",
      appearance: "dark",
      onShow: () => {},
      onRestartHost: () => {},
      onQuit: () => {},
      onSelectSection: (section) => selectedSections.push(section),
      onSelectAppearance: (mode) => selectedAppearances.push(mode),
    });
    const viewMenu = appMenu.find((item) => "label" in item && item.label === "View") as {
      submenu: { label?: string; checked?: boolean; onSelect?: () => void }[];
    };
    expect(viewMenu.submenu.find((entry) => entry.label === "Settings")?.checked).toBe(true);
    expect(viewMenu.submenu.find((entry) => entry.label === "Keys")?.checked).toBe(false);
    expect(viewMenu.submenu.find((entry) => entry.label === "Dark Appearance")?.checked).toBe(true);
    expect(viewMenu.submenu.find((entry) => entry.label === "Light Appearance")?.checked).toBe(false);
    viewMenu.submenu.find((entry) => entry.label === "Keys")?.onSelect?.();
    viewMenu.submenu.find((entry) => entry.label === "Light Appearance")?.onSelect?.();
    expect(selectedSections).toEqual(["keys"]);
    expect(selectedAppearances).toEqual(["light"]);

    const appMenuRecoveryBusy = buildApplicationMenuItems({
      host: { state: "failed", reason: "exit" },
      start: STARTED,
      quitting: false,
      recoveryBusy: true,
      productName: "BYOK Bots",
      activeSection: "keys",
      appearance: "light",
      onShow: () => {},
      onRestartHost: () => {},
      onQuit: () => {},
      onSelectSection: () => {},
      onSelectAppearance: () => {},
    });
    const appSubmenu = appMenuRecoveryBusy.find(
      (item) => "label" in item && item.label === "BYOK Bots",
    ) as { submenu: { label?: string; disabled?: boolean }[] };
    expect(appSubmenu.submenu.find((entry) => entry.label === "Restart Host")?.disabled).toBe(true);
  });

  test("fitIntoWorkArea moves and shrinks a first window that overflows the work area, and leaves one that fits", () => {
    // #2516 win2: 1920 × 1080 at 150 % with a 48 px taskbar is a 1280 × 688 pt work area; the window opened at
    // 190,190 px with 1822 × 1106 px outer bounds.
    const workArea = { origin: { x: 0, y: 0 }, size: { width: 1280, height: 688 } };
    const opened = { origin: { x: 190 / 1.5, y: 190 / 1.5 }, size: { width: 1822 / 1.5, height: 1106 / 1.5 } };
    expect(fitIntoWorkArea(opened, workArea)).toEqual({ origin: { x: 1280 - 1822 / 1.5, y: 0 }, size: { width: 1822 / 1.5, height: 688 } });
    expect(fitIntoWorkArea({ origin: { x: 40, y: 30 }, size: { width: 900, height: 600 } }, workArea)).toBeNull();
  });
});
