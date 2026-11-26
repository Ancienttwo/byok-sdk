import type { ProviderStatus } from "@byok-sdk/keys";
import {
  applyModelRouteChange,
  createModelRouteDraft,
  modelRouteContext,
  type ModelRouteChange,
  type ModelRouteDraft,
} from "@byok-sdk/keys/model-route";
import { describe, expect, open, test } from "nsh/test";
import type { CustodyChange } from "../../../../src/custody/protocol.ts";
import { refusalOf, storedProfile, submitModelRoute } from "../../../../src/keys/submit.ts";
import { createBridge } from "../../bridge.ts";

function makeStoredStatus(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    profile_ref: "zai-main",
    display_name: "GLM Main",
    provider_kind: "zai",
    adapter: "openai_compatible",
    auth_mode: "bearer",
    base_url: "https://api.z.ai/api/coding/paas/v4",
    model: "glm-4.7",
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
        zaiToolStream: true,
        supportsStrictMode: true,
      },
    },
    capabilities: [],
    enabled: true,
    secret_configured: true,
    configuration_pending: false,
    profile_revision: "rev-1",
    profile_hash: "hash-1",
    created_at: "2026-11-24T00:00:00.000Z",
    updated_at: "2026-11-24T00:00:00.000Z",
    ...overrides,
  };
}

/** Adapter stand-ins for a started shell whose Host runs; `call` answers the bridge RPCs. */
function runningShell(call: (method: string, params: unknown) => unknown) {
  return {
    "byok-nsh-adapter": {
      "ByokShell.start": {
        started: true,
        alreadyStarted: false,
        state: { state: "running", pid: 1, activeWork: 0 },
      },
      "ByokShell.call": call,
    },
  };
}

describe("KeysScreen (#2461 Slice 2)", () => {
  test("loads stored providers, renders configuration_pending badge, and shows refusal on keys.list busy error", async () => {
    const stored = makeStoredStatus({
      profile_ref: "pending-key",
      display_name: "Pending Key Provider",
      secret_configured: false,
      configuration_pending: true,
    });

    const app = await open("../../../App.tsx", {
      platform: "macos",
      width: 1200,
      height: 860,
      modules: runningShell((method: string) => {
        if (method === "keys.list") {
          return [stored];
        }
        if (method === "k8.view") {
          return {
            bots: [],
            roles: [],
            models: [{ id: "zai-chat", label: "ZAI Chat" }],
            busy: false,
          };
        }
        return null;
      }),
    });

    await app.waitFor("id:keys-stored-pending-key");
    expect(app.shows("text:Pending Key Provider (pending-key)")).toBe(true);
    expect(app.shows("text:Unfinished key change: replace key")).toBe(true);
    expect(app.shows("text:ZAI Chat")).toBe(true);

    // Direct check that createBridge + refusalOf preserves typed error codes (while nsh/test
    // `modules` RPC wraps thrown mock errors across test/app boundary as ERR_NSH_HOST_ERROR).
    const busyBridge = createBridge(async () => {
      const err = new Error(
        "Cannot list provider keys while an app update or recovery action is running",
      ) as Error & { code: string };
      err.code = "PROVIDER_CONFIGURATION_BUSY";
      throw err;
    });
    let caughtBusy: unknown;
    try {
      await busyBridge.call("keys.list", undefined);
    } catch (error) {
      caughtBusy = error;
    }
    expect(refusalOf(caughtBusy)).toEqual({
      code: "PROVIDER_CONFIGURATION_BUSY",
      message: "Cannot list provider keys while an app update or recovery action is running",
    });

    const busyApp = await open("../../../App.tsx", {
      platform: "macos",
      width: 1200,
      height: 860,
      modules: runningShell((method: string) => {
        if (method === "keys.list") {
          const err = new Error(
            "Cannot list provider keys while an app update or recovery action is running",
          ) as Error & { code: string };
          err.code = "PROVIDER_CONFIGURATION_BUSY";
          throw err;
        }
        throw Object.assign(new Error("Host exited"), { code: "host_exited" });
      }),
    });

    await busyApp.waitFor("id:keys-list-refusal");
    expect(
      busyApp
        .texts()
        .some((text) =>
          text.includes("Cannot list provider keys while an app update or recovery action is running"),
        ),
    ).toBe(true);
    expect(busyApp.shows("id:keys-models-refusal")).toBe(true);
  });

  test("submits new provider configure via keys.submit, clears secret before bridge call, shows receipt, and reloads list", async () => {
    // Direct synchronous pre-bridge clearing check on shared submitModelRoute + createBridge.
    const ctx = modelRouteContext();
    const changes: ModelRouteChange[] = [
      { field: "profile_ref", value: "zai-direct" },
      { field: "display_name", value: "ZAI Direct" },
      { field: "provider_kind", value: "zai" },
      { field: "model", value: "glm-4.7", api: "openai-completions" },
      { field: "secret", value: { replace: "sk-direct-sync-secret" } },
    ];
    let currentDraft: ModelRouteDraft = changes.reduce(
      (acc, change) => applyModelRouteChange(acc, change, ctx),
      createModelRouteDraft(ctx),
    );
    let observedSecretAtInvoke: unknown = null;
    const directBridge = createBridge(async (method, params) => {
      observedSecretAtInvoke = currentDraft.secret;
      expect(method).toBe("keys.submit");
      expect(params).toMatchObject({
        op: "configure",
        secret: "sk-direct-sync-secret",
        configuration: { profile_ref: "zai-direct", provider_kind: "zai", model: "glm-4.7" },
      });
      return makeStoredStatus({ profile_ref: "zai-direct", display_name: "ZAI Direct" });
    });
    const directOutcome = await submitModelRoute(
      currentDraft,
      ctx,
      null,
      (change) => directBridge.call("keys.submit", change),
      (cleared) => {
        currentDraft = cleared;
      },
    );
    expect(observedSecretAtInvoke).toBe("none");
    expect(currentDraft.secret).toBe("none");
    expect("receipt" in directOutcome).toBe(true);

    // End-to-end UI flow inside KeysScreen.
    const calls: { method: string; params: unknown }[] = [];
    let listCalls = 0;
    const savedStatus = makeStoredStatus({
      profile_ref: "zai-ui",
      display_name: "ZAI UI",
      profile_revision: "rev-2",
    });

    let releaseSubmit = () => {};
    const submitGate = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });

    try {
      const app = await open("../../../App.tsx", {
        platform: "macos",
        width: 1200,
        height: 860,
        modules: runningShell(async (method: string, params: unknown) => {
          calls.push({ method, params });
          if (method === "keys.list") {
            listCalls += 1;
            return listCalls === 1 ? [] : [savedStatus];
          }
          if (method === "keys.submit") {
            await submitGate;
            return savedStatus;
          }
          if (method === "k8.view") {
            return { bots: [], roles: [], models: [], busy: false };
          }
          return null;
        }),
      });

      await app.waitFor("text:No provider profiles stored");

      await app.type("id:keys-field-profile_ref", "zai-ui");
      await app.type("id:keys-field-display_name", "ZAI UI");
      await app.press("id:keys-field-provider_kind");
      await app.press("text:Z.AI");
      await app.waitFor("id:keys-field-model");
      await app.press("id:keys-field-model-select");
      await app.press("text:glm-4.7 (openai-completions)");

      const uiSecret = "sk-ui-configure-secret-99";
      await app.type("id:keys-field-secret", uiSecret);
      expect(app.value("id:keys-field-secret")).toBe(uiSecret);
      expect(app.enabled("id:keys-save-btn")).toBe(true);

      const saving = app.press("id:keys-save-btn");
      await app.waitUntil(() => calls.some((entry) => entry.method === "keys.submit"));
      expect(app.value("id:keys-field-secret")).toBe("");
      releaseSubmit();
      await saving;
      await app.waitFor("id:keys-receipt");
      await app.waitFor("id:keys-stored-zai-ui");

      expect(listCalls).toBe(2);
      const submitCalls = calls.filter((entry) => entry.method === "keys.submit");
      expect(submitCalls).toHaveLength(1);
      const payload = submitCalls[0]!.params as Extract<CustodyChange, { op: "configure" }>;
      expect(payload.op).toBe("configure");
      expect(payload.secret).toBe(uiSecret);
      expect(payload.configuration.profile_ref).toBe("zai-ui");
      expect(payload.configuration.display_name).toBe("ZAI UI");
      expect(payload.configuration.provider_kind).toBe("zai");
      expect(payload.configuration.model).toBe("glm-4.7");

      expect(app.shows("text:Saved ZAI UI")).toBe(true);
      expect(app.texts().join("\n").includes(uiSecret)).toBe(false);
    } finally {
      // A failure or timeout above must not leave keys.submit waiting until the runner limit.
      releaseSubmit();
    }
  });

  test("editing stored profile preserves keep + enabled, and refusal shows code without resubmitting", async () => {
    const existing = makeStoredStatus({
      profile_ref: "zai-edit",
      display_name: "Original Name",
      enabled: false,
    });
    const submitPayloads: unknown[] = [];

    const app = await open("../../../App.tsx", {
      platform: "macos",
      width: 1200,
      height: 860,
      modules: runningShell((method: string, params: unknown) => {
        if (method === "keys.list") {
          return [existing];
        }
        if (method === "keys.submit") {
          submitPayloads.push(params);
          const err = new Error("Keys catalog refused: profile locked") as Error & { code: string };
          err.code = "custody_timeout";
          throw err;
        }
        if (method === "k8.view") {
          return { bots: [], roles: [], models: [], busy: false };
        }
        return null;
      }),
    });

    await app.waitFor("id:keys-stored-zai-edit");
    await app.press("id:keys-stored-zai-edit");
    expect(app.shows("text:Edit Original Name")).toBe(true);

    await app.clear("id:keys-field-display_name");
    await app.type("id:keys-field-display_name", "Renamed GLM");
    await app.press("id:keys-save-btn");

    await app.waitFor("id:keys-refusal");
    expect(submitPayloads).toHaveLength(1);
    const req = submitPayloads[0] as Extract<CustodyChange, { op: "configure" }>;
    expect(req.op).toBe("configure");
    expect(req.configuration.display_name).toBe("Renamed GLM");
    expect(req.configuration.enabled).toBe(false);
    expect("secret" in req).toBe(false);
    expect(
      app.texts().some((text) => text.includes("Keys catalog refused: profile locked")),
    ).toBe(true);

    // Also verify createBridge + submitModelRoute preserves typed error codes on refusal.
    const refusalBridge = createBridge(async () => {
      throw Object.assign(new Error("Keys catalog refused: profile locked"), {
        code: "custody_timeout",
      });
    });
    const ctx = modelRouteContext({ stored: storedProfile(existing) });
    const refusedOutcome = await submitModelRoute(
      createModelRouteDraft(ctx),
      ctx,
      existing,
      (change) => refusalBridge.call("keys.submit", change),
      () => {},
    );
    expect(refusedOutcome).toEqual({
      refusal: { code: "custody_timeout", message: "Keys catalog refused: profile locked" },
    });
  });

  test("ReplaceKeyForm clears masked signal before keys.submit replace_secret and never echoes secret", async () => {
    const existing = makeStoredStatus({
      profile_ref: "zai-replace",
      display_name: "ZAI Replace",
    });
    const submitPayloads: unknown[] = [];
    let releaseSubmit = () => {};
    const submitGate = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });

    try {
      const app = await open("../../../App.tsx", {
        platform: "macos",
        width: 1200,
        height: 860,
        modules: runningShell(async (method: string, params: unknown) => {
          if (method === "keys.list") {
            return [existing];
          }
          if (method === "keys.submit") {
            submitPayloads.push(params);
            await submitGate;
            return existing;
          }
          if (method === "k8.view") {
            return { bots: [], roles: [], models: [], busy: false };
          }
          return null;
        }),
      });

      await app.waitFor("id:keys-stored-zai-replace");
      await app.press("id:keys-stored-zai-replace");

      const nextKey = "sk-replaced-key-42";
      await app.type("id:keys-replace-secret", nextKey);
      expect(app.value("id:keys-replace-secret")).toBe(nextKey);

      const replacing = app.press("id:keys-replace-submit");
      await app.waitUntil(() => submitPayloads.length === 1);
      expect(app.value("id:keys-replace-secret")).toBe("");
      releaseSubmit();
      await replacing;
      await app.waitFor("id:keys-receipt");

      expect(submitPayloads).toEqual([
        {
          op: "replace_secret",
          profileRef: "zai-replace",
          secret: nextKey,
        },
      ]);
      expect(app.shows("text:Saved ZAI Replace")).toBe(true);
      expect(app.texts().join("\n").includes(nextKey)).toBe(false);
    } finally {
      // A failure or timeout above must not leave keys.submit waiting until the runner limit.
      releaseSubmit();
    }
  });

  test("Windows KeysScreen inputs preserve CJK provider names cleanly", async () => {
    const app = await open("../../../App.tsx", {
      platform: "windows",
      width: 1200,
      height: 860,
      modules: runningShell((method: string) => {
        if (method === "keys.list") {
          return [];
        }
        if (method === "k8.view") {
          return { bots: [], roles: [], models: [], busy: false };
        }
        return null;
      }),
    });

    await app.waitFor("id:keys-field-display_name");
    await app.type("id:keys-field-display_name", "中文配置名称");
    expect(app.value("id:keys-field-display_name")).toBe("中文配置名称");
  });
});
