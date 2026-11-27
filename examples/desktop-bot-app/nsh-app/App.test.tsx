import { ByokShell } from "byok-nsh-adapter";
import { describe, expect, open, test } from "nsh/test";
import { createBridge, submitSecret } from "./src/bridge.ts";
import { parseAllowedExternalUrl } from "./src/links.ts";

const RUNNING_HOST = { state: "running", pid: 1, activeWork: 0 };

/** Adapter stand-ins so `open("./App.tsx")` never starts a real Host supervisor; `stubs` add or override members. */
function headlessShell(stubs: Record<string, {} | null | ((...args: any[]) => unknown)> = {}) {
  return {
    "byok-nsh-adapter": {
      "ByokShell.start": { started: true, alreadyStarted: false, state: null },
      ...stubs,
    },
  };
}

describe("BYOK NSH Foundations Gallery", () => {
  test("mounts desktop gallery, switches Light/Dark appearance, and previews Host states", async () => {
    const app = await open("./App.tsx", {
      platform: "macos",
      width: 1200,
      height: 820,
      colorScheme: "light",
      modules: headlessShell(),
    });

    await app.press("id:nav-gallery");
    expect(app.shows("text:BYOK Bots — Foundations Gallery")).toBe(true);
    expect(app.shows("id:host-state-badge")).toBe(true);

    await app.press("id:theme-dark");
    expect(app.accessibility("id:theme-dark")?.selected).toBe(true);

    await app.press("id:theme-light");
    expect(app.accessibility("id:theme-light")?.selected).toBe(true);

    await app.press("id:host-preview-running");
    expect(app.shows("text:Running (2 active)")).toBe(true);

    await app.press("id:host-preview-failed");
    expect(app.shows("text:Failed")).toBe(true);
  });

  test("interacts cleanly with Disclosure, Switch, Checkbox, Tabs, and Escape-dismissible Dialog", async () => {
    const app = await open("./App.tsx", { platform: "macos", width: 1200, height: 820, modules: headlessShell() });
    await app.press("id:nav-gallery");

    expect(app.accessibility("id:disclosure-trigger")?.expanded).toBe(false);
    await app.press("id:disclosure-trigger");
    expect(app.accessibility("id:disclosure-trigger")?.expanded).toBe(true);
    expect(app.shows("text:Expanded")).toBe(true);
    await app.press("id:disclosure-trigger");
    expect(app.accessibility("id:disclosure-trigger")?.expanded).toBe(false);

    await app.press("id:toggle-autosave");
    expect(app.shows("text:Auto-save Off")).toBe(true);

    await app.press("id:check-terms");
    expect(app.shows("text:Audit Confirmed")).toBe(true);

    await app.press("id:tab-tokens");
    expect(app.shows("text:Selected tab: tokens • Runtime: pi")).toBe(true);

    await app.press("id:open-dialog-btn");
    expect(app.shows("text:Foundations Dialog")).toBe(true);
    await app.keyboard.press("escape");
    expect(app.shows("text:Foundations Dialog")).toBe(false);
  });

  test("ADR-052 D2 Option A: clears masked credential signal before ByokShell.call('keys.submit')", async () => {
    let signalAtInvoke: string | null = null;
    let signal = "sk-sync-order-secret";
    await submitSecret({
      buildPayload: () => ({
        op: "replace_secret",
        profileRef: "foundations-demo",
        secret: signal,
      }),
      clearSecret: () => {
        signal = "";
      },
      client: createBridge(async (method, params) => {
        signalAtInvoke = signal;
        expect(method).toBe("keys.submit");
        expect(params).toEqual({
          op: "replace_secret",
          profileRef: "foundations-demo",
          secret: "sk-sync-order-secret",
        });
        return {
          profile_ref: "foundations-demo",
          provider: "openai",
          configured: true,
          has_secret: true,
        };
      }),
    });
    expect(signalAtInvoke).toBe("");
    expect(signal).toBe("");

    const calls: { method: string; params: unknown }[] = [];
    const app = await open("./App.tsx", {
      platform: "macos",
      width: 1200,
      height: 820,
      modules: headlessShell({
        "ByokShell.call": (method: string, params: unknown) => {
          calls.push({ method, params });
          if (method === "keys.list") {
            return [];
          }
          if (method === "k8.view") {
            return { bots: [], roles: [], models: [], busy: false };
          }
          return {
            profile_ref: "foundations-demo",
            provider: "openai",
            configured: true,
            has_secret: true,
          };
        },
      }),
    });

    await app.press("id:nav-gallery");
    const testSecret = "sk-test-secret-42";
    await app.type("id:secret-input", testSecret);
    expect(app.value("id:secret-input")).toBe(testSecret);

    await app.press("id:secret-submit");
    await app.waitFor("text:Secret status: Submitted (signal cleared before bridge call)");

    expect(calls.filter((entry) => entry.method === "keys.submit")).toEqual([
      {
        method: "keys.submit",
        params: {
          op: "replace_secret",
          profileRef: "foundations-demo",
          secret: testSecret,
        },
      },
    ]);
    expect(app.value("id:secret-input")).toBe("");
    expect(app.texts().join("\n").includes(testSecret)).toBe(false);
  });

  test("app startup starts the Host supervisor once before the first Keys bridge call", async () => {
    const calls: string[] = [];
    const app = await open("./App.tsx", {
      platform: "macos",
      width: 1200,
      height: 820,
      modules: {
        "byok-nsh-adapter": {
          "ByokShell.start": () => {
            calls.push("start");
            return { started: true, alreadyStarted: false, state: RUNNING_HOST };
          },
          "ByokShell.call": (method: string) => {
            calls.push(method);
            if (method === "keys.list") {
              return [];
            }
            if (method === "k8.view") {
              return { bots: [], roles: [], models: [], busy: false };
            }
            return null;
          },
        },
      },
    });

    await app.waitUntil(() => calls.includes("keys.list") && calls.includes("k8.view"));
    expect(calls[0]).toBe("start");
    expect(calls.filter((method) => method === "start")).toHaveLength(1);
    await app.waitFor("text:No provider profiles stored");
  });

  test("a failed Host start shows the Keys refusal and retries only on Reload", async () => {
    const calls: string[] = [];
    const app = await open("./App.tsx", {
      platform: "macos",
      width: 1200,
      height: 820,
      modules: {
        "byok-nsh-adapter": {
          "ByokShell.start": () => {
            calls.push("start");
            throw Object.assign(new Error("No packaged Host binary"), { code: "host_exited" });
          },
          "ByokShell.call": (method: string) => {
            calls.push(method);
            return null;
          },
        },
      },
    });

    await app.waitFor("id:keys-list-refusal");
    expect(calls).toEqual(["start"]);
    // The sidebar reads the same start refusal: no supervisor runs, so it never reports "Host starting".
    expect(app.shows("text:Host stopped: No packaged Host binary")).toBe(true);
    expect(app.shows("text:Host starting")).toBe(false);

    // A valid draft still cannot be saved: keys.submit would only refuse with host_exited.
    await app.type("id:keys-field-profile_ref", "zai-ui");
    await app.type("id:keys-field-display_name", "ZAI UI");
    await app.press("id:keys-field-provider_kind");
    await app.press("text:Z.AI");
    await app.waitFor("id:keys-field-model");
    await app.type("id:keys-field-model", "glm-4.7");
    await app.type("id:keys-field-secret", "sk-failed-start-secret");
    expect(app.enabled("id:keys-save-btn")).toBe(false);
    expect(app.enabled("id:keys-reload-btn")).toBe(true);
    expect(calls).toEqual(["start"]);

    await app.press("id:keys-reload-btn");
    await app.waitUntil(() => calls.length === 2);
    await app.waitFor("id:keys-list-refusal");
    expect(calls).toEqual(["start", "start"]);
  });

  test("real ByokShell adapter enforces bridge contract allowlist and exposes Stop listeners", async () => {
    expect(ByokShell.bridgeVersion()).toBe(2);

    for (const forbidden of ["hello", "shutdown", "keys.profilesChanged", "unknown.op"]) {
      await expect(ByokShell.call(forbidden, null)).rejects.toMatchObject({ code: "unknown_method" });
    }
    await expect(ByokShell.call("status", null)).rejects.toMatchObject({ code: "host_exited" });
    await expect(ByokShell.restart()).rejects.toMatchObject({ code: "host_exited" });

    const stops = [
      ByokShell.onState(() => {}),
      ByokShell.onStateHint(() => {}),
      ByokShell.onPowerError(() => {}),
      ByokShell.onQuitting(() => {}),
    ];
    for (const stop of stops) {
      expect(typeof stop).toBe("function");
      stop();
    }
  });

  test("UI-layer external link allowlist permits only allowlisted https origins and drops unsafe schemes", async () => {
    expect(parseAllowedExternalUrl("https://docs.byok.test/guide", ["https://docs.byok.test"])).toBe(
      "https://docs.byok.test/guide",
    );
    expect(parseAllowedExternalUrl("https://other.byok.test/guide", ["https://docs.byok.test"])).toBeNull();
    expect(parseAllowedExternalUrl("http://docs.byok.test/guide", ["https://docs.byok.test"])).toBeNull();
    expect(parseAllowedExternalUrl("javascript:alert(1)", ["https://docs.byok.test"])).toBeNull();
    expect(parseAllowedExternalUrl("file:///etc/passwd", ["https://docs.byok.test"])).toBeNull();

    const app = await open("./App.tsx", { platform: "macos", width: 1200, height: 820, modules: headlessShell() });
    await app.press("id:nav-gallery");
    await app.press("id:link-blocked");
    expect(app.openedUrls()).toEqual([]);
    expect(app.shows("text:Link status: Blocked https://evil.example/phish")).toBe(true);

    await app.press("id:link-allowed");
    expect(app.openedUrls()).toEqual(["https://example.org/docs"]);
  });

  test("Windows platform preserves CJK text in Input and Textarea cleanly", async () => {
    const app = await open("./App.tsx", { platform: "windows", width: 1200, height: 820, modules: headlessShell() });
    await app.press("id:nav-gallery");

    await app.type("id:text-input", "你好世界");
    expect(app.value("id:text-input")).toBe("你好世界");

    await app.type("id:text-area", "中文笔记");
    expect(app.value("id:text-area")).toBe("中文笔记");
  });

  test("native quit hook handles desktop quitRequest and quits gracefully", async () => {
    const app = await open("./App.tsx", { platform: "macos", width: 1200, height: 820, modules: headlessShell() });
    expect(app.quit()).toBe(false);
    await app.quitRequest();
    await app.waitUntil(() => app.quit());
    expect(app.quit()).toBe(true);
  });
});
