import { describe, expect, open, test } from "nsh/test";
import type { DeviceView, DreamingSetting } from "../../../../src/host/settings/types.ts";

type Call = { method: string; params: any };

const MODELS = [
  { id: "m1", label: "Model One" },
  { id: "m2", label: "Model Two" },
];

const DEVICE: DeviceView = {
  paired: true,
  deviceId: "dev-1",
  lifecycle: { phase: "running", connection: "open" },
  activeTaskCount: 2,
  pendingTerminalCommits: 0,
  runtimes: [
    { id: "pi", present: true, outcome: "available", version: "1.3.0", verdict: "allow" },
    { id: "codex", present: false, outcome: "not-found", reason: "not on PATH" },
  ],
  clockSkew: { status: "unknown", reason: "not-observed" },
  doctor: {
    generatedAt: "2026-11-26T00:00:00.000Z",
    worst: "warn",
    checks: [
      { id: "runtimes", status: "warn", summary: "codex not found" },
      { id: "config", status: "pass", summary: "ok" },
    ],
  },
};

/**
 * A started shell (Host `running` unless `host` says otherwise); `dreaming` answers `settings.get`, `save` the
 * `settings.setDreaming` call.
 */
function settingsShell(
  calls: Call[],
  options: {
    dreaming?: () => DreamingSetting;
    save?: (setting: DreamingSetting) => unknown;
    host?: { state: string };
  } = {},
) {
  return {
    "byok-nsh-adapter": {
      "ByokShell.start": {
        started: true,
        alreadyStarted: false,
        state: options.host ?? { state: "running", pid: 1, activeWork: 0 },
      },
      "ByokShell.call": (method: string, params: any) => {
        calls.push({ method, params });
        if (method === "keys.list") return [];
        if (method === "k8.view") return { bots: [], roles: [], models: MODELS, busy: false };
        if (method === "settings.device") return DEVICE;
        if (method === "settings.get") return { dreaming: (options.dreaming ?? (() => ({ enabled: true, models: ["m1"] })))() };
        if (method === "settings.setDreaming") return options.save?.(params) ?? { dreaming: params };
        if (method === "settings.loginItem") return { supported: true, enabled: false };
        return null;
      },
    },
  };
}

const count = (calls: Call[], method: string) => calls.filter((call) => call.method === method).length;

describe("SettingsScreen (#2461 Slice 5)", () => {
  // Headless runs cannot send a Host state hint (a module stub gets the app's listener as data), so no test drives one;
  // the reads' source is the Host readiness and the Refresh count only.
  test("loads device and settings only on section entry, and shows the device facts", async () => {
    const calls: Call[] = [];
    const app = await open("../../../App.tsx", { platform: "macos", width: 1280, height: 900, modules: settingsShell(calls) });
    await app.waitUntil(() => count(calls, "k8.view") === 1);
    expect(count(calls, "settings.device")).toBe(0);
    expect(count(calls, "settings.get")).toBe(0);

    await app.press("id:nav-settings");
    await app.waitFor("id:settings-device");
    expect(app.shows("text:Running, connected")).toBe(true);
    expect(app.shows("text:Not measured: not-observed")).toBe(true);
    expect(app.accessibility("id:settings-runtime-pi-verdict")?.label).toBe("allow");
    expect(app.accessibility("id:settings-runtime-codex-verdict")?.label).toBe("none reported");
    expect(app.shows("text:not-found: not on PATH")).toBe(true);
    expect(app.accessibility("id:settings-doctor-worst")?.label).toBe("warn");
    expect(app.shows("text:runtimes: codex not found")).toBe(true);

    await app.wait(50);
    expect(count(calls, "settings.device")).toBe(1);
    expect(count(calls, "settings.get")).toBe(1);

    await app.press("id:nav-keys");
    await app.press("id:nav-settings");
    await app.waitUntil(() => count(calls, "settings.device") === 2);
    expect(count(calls, "settings.get")).toBe(2);
  });

  test("Refresh reads again and resets the draft; the models come from the shared k8.view", async () => {
    const calls: Call[] = [];
    const app = await open("../../../App.tsx", { platform: "macos", width: 1280, height: 900, modules: settingsShell(calls) });
    await app.press("id:nav-settings");
    await app.waitFor("id:settings-dreaming-form");
    expect(app.accessibility("id:settings-dreaming-switch")?.checked).toBe("true");

    await app.press("id:settings-dreaming-switch");
    await app.press("id:settings-dreaming-model-m2");
    expect(app.accessibility("id:settings-dreaming-switch")?.checked).toBe("false");
    expect(app.accessibility("id:settings-dreaming-model-m2")?.label).toBe("Model Two (#2)");

    await app.press("id:settings-refresh");
    await app.waitUntil(() => count(calls, "settings.get") === 2);
    await app.waitUntil(() => app.accessibility("id:settings-dreaming-switch")?.checked === "true");
    expect(app.accessibility("id:settings-dreaming-model-m2")?.label).toBe("Model Two");
    expect(count(calls, "settings.device")).toBe(2);
    expect(count(calls, "k8.view")).toBe(1);
  });

  test("models are chosen in order, a model that left the catalog stays, and Save sends that order", async () => {
    const calls: Call[] = [];
    const app = await open("../../../App.tsx", {
      platform: "macos",
      width: 1280,
      height: 900,
      modules: settingsShell(calls, { dreaming: () => ({ enabled: true, models: ["gone"] }) }),
    });
    await app.press("id:nav-settings");
    await app.waitFor("id:settings-dreaming-model-gone");
    expect(app.accessibility("id:settings-dreaming-model-gone")?.label).toBe("gone (#1, no longer in the catalog)");

    await app.press("id:settings-dreaming-model-m2");
    await app.press("id:settings-dreaming-model-m1");
    expect(app.accessibility("id:settings-dreaming-model-m2")?.label).toBe("Model Two (#2)");
    expect(app.accessibility("id:settings-dreaming-model-m1")?.label).toBe("Model One (#3)");

    await app.press("id:settings-dreaming-model-gone");
    expect(app.shows("id:settings-dreaming-model-gone")).toBe(false);
    expect(app.accessibility("id:settings-dreaming-model-m2")?.label).toBe("Model Two (#1)");

    await app.press("id:settings-dreaming-save");
    await app.waitFor("id:settings-dreaming-result");
    expect(calls.filter((call) => call.method === "settings.setDreaming").map((call) => call.params)).toEqual([
      { enabled: true, models: ["m2", "m1"] },
    ]);
    // A save keeps the form: no new settings read, the draft stays as saved.
    expect(count(calls, "settings.get")).toBe(1);
    expect(app.accessibility("id:settings-dreaming-model-m1")?.label).toBe("Model One (#2)");
  });

  test("Refresh waits while a save runs, so the save's reply lands on its own form", async () => {
    const calls: Call[] = [];
    // `press` resolves once the app is quiet, after the save settled; the save stub reads Refresh while it runs.
    let refreshWhileSaving: { enabled: boolean; busy: boolean | undefined } | undefined;
    const app = await open("../../../App.tsx", {
      platform: "macos",
      width: 1280,
      height: 900,
      modules: settingsShell(calls, {
        save: (setting) =>
          new Promise((resolve) =>
            setTimeout(() => {
              refreshWhileSaving = {
                enabled: app.enabled("id:settings-refresh"),
                busy: app.accessibility("id:settings-refresh")?.busy,
              };
              resolve({ dreaming: setting });
            }, 50),
          ),
      }),
    });
    await app.press("id:nav-settings");
    await app.waitFor("id:settings-dreaming-form");
    await app.press("id:settings-dreaming-model-m2");
    await app.press("id:settings-dreaming-save");
    await app.waitFor("id:settings-dreaming-result");
    expect(refreshWhileSaving).toEqual({ enabled: false, busy: true });
    expect(count(calls, "settings.get")).toBe(1);
    expect(app.accessibility("id:settings-dreaming-model-m2")?.label).toBe("Model Two (#2)");
    expect(app.enabled("id:settings-refresh")).toBe(true);
  });

  test("while the Host does not run, nothing loads and diagnostics export is disabled with its note", async () => {
    const calls: Call[] = [];
    const app = await open("../../../App.tsx", {
      platform: "macos",
      width: 1280,
      height: 900,
      modules: settingsShell(calls, { host: { state: "starting" } }),
    });
    await app.press("id:nav-settings");
    await app.waitFor("id:settings-diagnostics-note");
    expect(app.shows("text:Start or restart the Host to export diagnostics.")).toBe(true);
    expect(app.enabled("id:settings-diagnostics-btn")).toBe(false);
    expect(app.enabled("id:settings-refresh")).toBe(false);
    await app.wait(50);
    expect(count(calls, "settings.device")).toBe(0);
    expect(count(calls, "settings.get")).toBe(0);
    expect(count(calls, "settings.exportDiagnostics")).toBe(0);
  });
});
