import { describe, expect, open, test } from "nsh/test";
import type { DeviceView, DreamingSetting, RuntimeView } from "../../../../src/host/settings/types.ts";
import {
  runtimeSignInGuidance,
  runtimeStatus,
  runtimeStatusMeta,
  UNKNOWN_SIGN_IN_NOTE,
} from "./runtimeStatus.ts";

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
    device?: (params: any) => DeviceView | Promise<DeviceView>;
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
        if (method === "settings.device") return options.device ? options.device(params) : DEVICE;
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

  test("a save that outlives a section switch keeps Refresh disabled and holds the remounted read until it settles", async () => {
    const calls: Call[] = [];
    let stored: DreamingSetting = { enabled: true, models: ["m1"] };
    let releaseSave = () => {};
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const app = await open("../../../App.tsx", {
      platform: "macos",
      width: 1280,
      height: 900,
      // A manual clock: a step taken while the save waits then does not wait out the runner's 2 s limit for a quiet app.
      clock: {},
      modules: settingsShell(calls, {
        dreaming: () => stored,
        save: async (setting) => {
          await saveGate;
          stored = setting;
          return { dreaming: setting };
        },
      }),
    });
    try {
      await app.press("id:nav-settings");
      await app.waitFor("id:settings-dreaming-form");
      await app.press("id:settings-dreaming-model-m2");
      const saving = app.press("id:settings-dreaming-save");
      await app.waitUntil(() => count(calls, "settings.setDreaming") === 1);
      await app.press("id:nav-keys");
      await app.press("id:nav-settings");
      await app.waitFor("id:settings-refresh");
      expect(app.enabled("id:settings-refresh")).toBe(false);
      expect(app.shows("id:settings-dreaming-form")).toBe(false);
      await app.waitUntil(() => count(calls, "settings.device") === 2);
      expect(count(calls, "settings.get")).toBe(1);

      releaseSave();
      await saving;
      await app.waitFor("id:settings-dreaming-form");
      expect(count(calls, "settings.get")).toBe(2);
      expect(app.accessibility("id:settings-dreaming-model-m2")?.label).toBe("Model Two (#2)");
      expect(app.enabled("id:settings-refresh")).toBe(true);
    } finally {
      releaseSave();
    }
  });

  test("a Settings view left before a running save settles sends no read once it settles", async () => {
    const calls: Call[] = [];
    let releaseSave = () => {};
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const app = await open("../../../App.tsx", {
      platform: "macos",
      width: 1280,
      height: 900,
      // A manual clock: a step taken while the save waits then does not wait out the runner's 2 s limit for a quiet app.
      clock: {},
      modules: settingsShell(calls, {
        save: async (setting) => {
          await saveGate;
          return { dreaming: setting };
        },
      }),
    });
    try {
      await app.press("id:nav-settings");
      await app.waitFor("id:settings-dreaming-form");
      await app.press("id:settings-dreaming-model-m2");
      const saving = app.press("id:settings-dreaming-save");
      await app.waitUntil(() => count(calls, "settings.setDreaming") === 1);
      await app.press("id:nav-keys");
      await app.press("id:nav-settings");
      await app.waitFor("id:settings-refresh");
      await app.press("id:nav-keys");
      await app.waitFor("id:settings-section", { state: "gone" });

      releaseSave();
      await saving;
      await app.wait(100);
      expect(count(calls, "settings.get")).toBe(1);
    } finally {
      releaseSave();
    }
  });

  test("Save waits while a Refresh read runs, so the read cannot replace the form under a running save", async () => {
    const calls: Call[] = [];
    let releaseRead = () => {};
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const modules = settingsShell(calls);
    const shell = modules["byok-nsh-adapter"];
    const answer = shell["ByokShell.call"];
    shell["ByokShell.call"] = async (method: string, params: any) => {
      if (method === "settings.get" && count(calls, "settings.get") === 1) {
        calls.push({ method, params });
        await readGate;
        return { dreaming: { enabled: true, models: ["m1"] } };
      }
      return answer(method, params);
    };
    // A manual clock: a step taken while the read waits then does not wait out the runner's 2 s limit for a quiet app.
    const app = await open("../../../App.tsx", { platform: "macos", width: 1280, height: 900, clock: {}, modules });
    try {
      await app.press("id:nav-settings");
      await app.waitFor("id:settings-dreaming-form");
      expect(app.enabled("id:settings-dreaming-save")).toBe(true);
      // Not awaited: the press settles once the read it starts does.
      const refreshing = app.press("id:settings-refresh");
      await app.waitUntil(() => count(calls, "settings.get") === 2);
      expect(app.enabled("id:settings-dreaming-save")).toBe(false);

      releaseRead();
      await refreshing;
      await app.waitUntil(() => app.enabled("id:settings-dreaming-save"));
      await app.press("id:settings-dreaming-save");
      await app.waitFor("id:settings-dreaming-result");
      expect(count(calls, "settings.setDreaming")).toBe(1);
    } finally {
      releaseRead();
    }
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

  test("at the 840 px minimum window width, the version policy and agent status badges stay inside their rows", async () => {
    const calls: Call[] = [];
    const app = await open("../../../App.tsx", { platform: "linux", width: 840, height: 560, modules: settingsShell(calls) });
    await app.press("id:nav-settings");
    await app.waitFor("id:settings-runtime-codex-verdict");
    for (const id of ["pi", "codex"]) {
      const row = app.layout(`id:settings-runtime-${id}`)!;
      const badge = app.layout(`id:settings-runtime-${id}-verdict`)!;
      expect(badge.x + badge.width <= row.x + row.width).toBe(true);

      const agentRow = app.layout(`id:settings-agent-${id}`)!;
      const agentBadge = app.layout(`id:settings-agent-${id}-status`)!;
      expect(agentBadge.x + agentBadge.width <= agentRow.x + agentRow.width).toBe(true);
    }
  });

  test("AgentsPanel renders every runtime state, sign-in guidance without copy buttons, and Check again sends checkAuth: true", async () => {
    const calls: Call[] = [];
    const initialRuntimes: RuntimeView[] = [
      {
        id: "claude",
        present: true,
        outcome: "available",
        version: "2.1.0",
        verdict: "allow",
        authPresent: false,
        executablePath: "/usr/local/bin/claude",
        executableSource: "path",
      },
      {
        id: "codex",
        present: true,
        outcome: "available",
        version: "0.50.0",
        verdict: "warn",
        qualifiedVersion: "0.49.0",
        authPresent: false,
        upgrade: {
          state: "available",
          installedVersion: "0.50.0",
          qualifiedVersion: "0.51.0",
          command: "upgradeRuntime({ installRoot, runtimeId: 'codex' })",
        },
      },
      {
        id: "opencode",
        present: true,
        outcome: "available",
        version: "0.9.0",
      },
      {
        id: "grok",
        present: false,
        outcome: "timeout",
      },
      {
        id: "dsh",
        present: true,
        outcome: "available",
        version: "0.1.0",
        verdict: "block",
      },
      {
        id: "agy",
        present: false,
        outcome: "not-found",
      },
      {
        id: "pi",
        present: false,
        outcome: "refused",
        reason: "runtime_environment_unavailable",
      },
    ];
    let checked = false;
    const app = await open("../../../App.tsx", {
      platform: "macos",
      width: 1280,
      height: 900,
      modules: settingsShell(calls, {
        device: (params) => {
          if (params?.checkAuth === true) {
            checked = true;
            return {
              ...DEVICE,
              runtimes: initialRuntimes.map((rt) =>
                rt.id === "claude" ? { ...rt, authPresent: true } : rt,
              ),
            };
          }
          return { ...DEVICE, runtimes: initialRuntimes };
        },
      }),
    });

    await app.press("id:nav-settings");
    await app.waitFor("id:settings-agents");

    expect(app.accessibility("id:settings-agent-claude-status")?.label).toBe("signed out");
    expect(app.shows("id:settings-agent-claude-signin-cmd")).toBe(true);
    expect(app.shows("text:claude auth login")).toBe(true);
    expect(app.shows("text:Executable (path)")).toBe(true);
    expect(app.shows("id:settings-agent-claude-executable")).toBe(true);
    expect(app.accessibility("id:settings-agent-claude-executable")?.label).toBe("Executable (path): /usr/local/bin/claude");
    expect(app.shows("text:Copy")).toBe(false);

    expect(app.accessibility("id:settings-agent-codex-status")?.label).toBe("signed out");
    expect(app.shows("text:codex login")).toBe(true);
    expect(app.shows("id:settings-agent-codex-qualified")).toBe(true);
    expect(app.shows("id:settings-agent-codex-upgrade")).toBe(true);

    expect(app.accessibility("id:settings-agent-opencode-status")?.label).toBe("not checked");
    expect(app.shows("id:settings-agent-opencode-signin-cmd")).toBe(false);
    expect(app.shows(`text:${UNKNOWN_SIGN_IN_NOTE}`)).toBe(true);

    expect(app.accessibility("id:settings-agent-grok-status")?.label).toBe("check timed out");
    expect(app.accessibility("id:settings-agent-dsh-status")?.label).toBe("version blocked");
    expect(app.accessibility("id:settings-agent-agy-status")?.label).toBe("not installed");
    expect(app.accessibility("id:settings-agent-pi-status")?.label).toBe("can't run");
    expect(app.shows("text:refused: runtime_environment_unavailable")).toBe(true);

    // Initial load sends default (no checkAuth: true).
    const initialCalls = calls.filter((call) => call.method === "settings.device");
    expect(initialCalls).toHaveLength(1);
    expect(initialCalls[0]?.params).toBeNull();

    // Check again sends { checkAuth: true } without reloading settings.get.
    await app.press("id:settings-agents-check-again");
    await app.waitUntil(() => checked && app.accessibility("id:settings-agent-claude-status")?.label === "signed in");
    expect(app.shows("id:settings-agent-claude-signin")).toBe(false);
    expect(count(calls, "settings.get")).toBe(1);
    const deviceCalls = calls.filter((call) => call.method === "settings.device");
    expect(deviceCalls).toHaveLength(2);
    expect(deviceCalls[1]?.params).toEqual({ checkAuth: true });

    // Refresh stays on the default no-probe call.
    await app.press("id:settings-refresh");
    await app.waitUntil(() => count(calls, "settings.device") === 3);
    expect(calls.filter((call) => call.method === "settings.device")[2]?.params).toBeNull();
  });
});

describe("runtimeStatus shared vocabulary (#2543)", () => {
  test("maps every runtime state to its unique vocabulary entry with symbol and label", () => {
    const cases: Array<[Parameters<typeof runtimeStatus>[0], Parameters<typeof runtimeStatus>[1], string, string]> = [
      [{ outcome: "available", verdict: "allow", authPresent: true }, undefined, "signed-in", "signed in"],
      [{ outcome: "available", verdict: "allow", authPresent: false }, undefined, "signed-out", "signed out"],
      [{ outcome: "available", verdict: "allow", authPresent: undefined }, undefined, "not-checked", "not checked"],
      [{ outcome: "timeout" }, undefined, "check-timed-out", "check timed out"],
      [{ outcome: "available", verdict: "warn", authPresent: true }, undefined, "untested-version", "untested version"],
      [{ outcome: "available", verdict: "block", authPresent: true }, undefined, "version-blocked", "version blocked"],
      [{ outcome: "not-found" }, undefined, "not-installed", "not installed"],
      [{ outcome: "refused" }, undefined, "cant-run", "can't run"],
      [{ outcome: "available", verdict: "allow", authPresent: true }, { rejectedDuringTurn: true }, "rejected-during-turn", "rejected during a turn"],
    ];
    for (const [input, options, expectedKey, expectedLabel] of cases) {
      const meta = runtimeStatus(input, options);
      expect(meta.key).toBe(expectedKey);
      expect(meta.label).toBe(expectedLabel);
      expect(meta.symbol.length).toBeGreaterThan(0);
      expect(runtimeStatusMeta(meta.key)).toEqual(meta);
    }
  });

  test("returns known login commands only for claude and codex and the generic note for other CLIs", () => {
    expect(runtimeSignInGuidance("claude")).toMatchObject({ kind: "command", command: "claude auth login" });
    expect(runtimeSignInGuidance("codex")).toMatchObject({ kind: "command", command: "codex login" });
    expect(runtimeSignInGuidance("pi")).toMatchObject({ kind: "byok" });
    for (const id of ["grok", "agy", "opencode", "dsh"]) {
      expect(runtimeSignInGuidance(id)).toEqual({ kind: "cli-unknown", note: UNKNOWN_SIGN_IN_NOTE });
    }
  });
});
