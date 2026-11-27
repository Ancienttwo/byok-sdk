import { describe, expect, open, test } from "nsh/test";

interface TokenSnapshot {
  appearance: string;
  colorScheme: string;
  radius: number;
  background: string;
  foreground: string;
  card: string;
  popover: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  muted: string;
  mutedForeground: string;
  tertiaryForeground: string;
  success: string;
  warning: string;
  destructive: string;
  border: string;
  segmentedThumb: string;
  sidebar: string;
  hostStarting: string;
  hostStartingFg: string;
  hostRunning: string;
  hostRunningFg: string;
  hostRestarting: string;
  hostRestartingFg: string;
  hostStopped: string;
  hostStoppedFg: string;
  hostFailed: string;
  hostFailedFg: string;
}

function readSnapshot(texts: string[]): TokenSnapshot {
  const raw = texts.find((entry) => entry.startsWith('{"appearance":'));
  if (!raw) {
    throw new Error(`Missing token snapshot in rendered texts: ${JSON.stringify(texts)}`);
  }
  return JSON.parse(raw) as TokenSnapshot;
}

describe("iOS-native theme tokens and src/ui variants (#2540)", () => {
  test("resolves iOS semantic light/dark token sets, cold-starts in OS dark under system mode, and follows OS switches", async () => {
    const app = await open("./theme.fixture.tsx", {
      platform: "macos",
      width: 1000,
      height: 760,
      colorScheme: "dark",
    });

    // Cold start in OS dark mode: initial appearance follows system and resolves the dark iOS set.
    const darkSnap = readSnapshot(app.texts());
    expect(darkSnap).toEqual({
      appearance: "system",
      colorScheme: "dark",
      radius: 10,
      background: "#000000ff",
      foreground: "#ffffffff",
      card: "#1c1c1eff",
      popover: "#2c2c2eff",
      primary: "#0a84ffff",
      primaryForeground: "#ffffffff",
      secondary: "#7878805c",
      muted: "#7878805c",
      mutedForeground: "#ebebf599",
      tertiaryForeground: "#ebebf54d",
      success: "#30d158ff",
      warning: "#ff9f0aff",
      destructive: "#ff453aff",
      border: "#54545899",
      segmentedThumb: "#636366ff",
      sidebar: "#1c1c1eff",
      hostStarting: "#0a84ff3d",
      hostStartingFg: "#ffffffff",
      hostRunning: "#30d1583d",
      hostRunningFg: "#ffffffff",
      hostRestarting: "#ff9f0a3d",
      hostRestartingFg: "#ffffffff",
      hostStopped: "#7878805c",
      hostStoppedFg: "#ffffffff",
      hostFailed: "#ff453a3d",
      hostFailedFg: "#ffffffff",
    });
    expect(app.viewStyle("id:theme-root")?.backgroundColor).toBe("#000000ff");
    expect(app.viewStyle("id:grouped-card")?.backgroundColor).toBe("#1c1c1eff");
    expect(app.viewStyle("id:muted-surface")?.backgroundColor).toBe("#7878805c");
    expect(app.viewStyle("id:btn-primary")?.backgroundColor).toBe("#0a84ffff");
    expect(app.viewStyle("id:host-running")?.backgroundColor).toBe("#30d1583d");
    expect(app.spanStyle("id:host-running >> text:Running (2 active)").color).toBe("#ffffffff");

    // Switching OS appearance while System is selected updates tokens reactively.
    await app.setColorScheme("light");
    const lightSnap = readSnapshot(app.texts());
    expect(lightSnap).toEqual({
      appearance: "system",
      colorScheme: "light",
      radius: 10,
      background: "#f2f2f7ff",
      foreground: "#000000ff",
      card: "#ffffffff",
      popover: "#ffffffff",
      primary: "#007affff",
      primaryForeground: "#ffffffff",
      secondary: "#78788033",
      muted: "#78788033",
      mutedForeground: "#3c3c4399",
      tertiaryForeground: "#3c3c434d",
      success: "#34c759ff",
      warning: "#ff9500ff",
      destructive: "#ff3b30ff",
      border: "#3c3c434a",
      segmentedThumb: "#ffffffff",
      sidebar: "#ffffffff",
      hostStarting: "#007aff29",
      hostStartingFg: "#000000ff",
      hostRunning: "#34c75929",
      hostRunningFg: "#000000ff",
      hostRestarting: "#ff950029",
      hostRestartingFg: "#000000ff",
      hostStopped: "#78788033",
      hostStoppedFg: "#000000ff",
      hostFailed: "#ff3b3029",
      hostFailedFg: "#000000ff",
    });
    expect(app.viewStyle("id:theme-root")?.backgroundColor).toBe("#f2f2f7ff");
    expect(app.viewStyle("id:grouped-card")?.backgroundColor).toBe("#ffffffff");
    expect(app.viewStyle("id:muted-surface")?.backgroundColor).toBe("#78788033");
    expect(app.viewStyle("id:btn-primary")?.backgroundColor).toBe("#007affff");
    expect(app.viewStyle("id:host-running")?.backgroundColor).toBe("#34c75929");
    expect(app.spanStyle("id:host-running >> text:Running (2 active)").color).toBe("#000000ff");

    // Explicit Dark and Light overrides ignore OS switches until switched back to System.
    await app.press("id:mode-dark");
    expect(readSnapshot(app.texts()).colorScheme).toBe("dark");
    await app.setColorScheme("light");
    expect(readSnapshot(app.texts()).colorScheme).toBe("dark");

    await app.setColorScheme("dark");
    await app.press("id:mode-light");
    expect(readSnapshot(app.texts()).colorScheme).toBe("light");

    await app.press("id:mode-system");
    expect(readSnapshot(app.texts()).appearance).toBe("system");
    expect(readSnapshot(app.texts()).colorScheme).toBe("dark");
  });

  test("applies iOS component metrics and variants across Card, ListItem, Button, Switch, Tabs, and HostStateBadge", async () => {
    const app = await open("./theme.fixture.tsx", {
      platform: "macos",
      width: 1000,
      height: 760,
      colorScheme: "light",
    });

    // Inset grouped row meets iOS 44 pt minimum height.
    expect(app.layout("id:grouped-row")?.height ?? 0).toBeGreaterThanOrEqual(44);

    // Filled buttons use systemBlue/systemRed with white label and iOS semibold (600) text weight;
    // quiet variants keep medium (500) weight with label text.
    expect(app.viewStyle("id:btn-primary")?.backgroundColor).toBe("#007affff");
    expect(app.spanStyle("id:btn-primary >> text:Primary").color).toBe("#ffffffff");
    expect(app.spanStyle("id:btn-primary >> text:Primary").fontWeight).toBe(600);

    expect(app.viewStyle("id:btn-danger")?.backgroundColor).toBe("#ff3b30ff");
    expect(app.spanStyle("id:btn-danger >> text:Danger").color).toBe("#ffffffff");
    expect(app.spanStyle("id:btn-danger >> text:Danger").fontWeight).toBe(600);

    expect(app.spanStyle("id:btn-secondary >> text:Secondary").color).toBe("#000000ff");
    expect(app.spanStyle("id:btn-secondary >> text:Secondary").fontWeight).toBe(500);
    expect(app.viewStyle("id:btn-outline")?.backgroundColor).toBe("#ffffffff");
    expect(app.spanStyle("id:btn-outline >> text:Outline").fontWeight).toBe(500);
    expect(app.viewStyle("id:btn-ghost")?.backgroundColor ?? null).toBeNull();
    expect(app.spanStyle("id:btn-ghost >> text:Ghost").fontWeight).toBe(500);

    // Switch toggles checked state cleanly.
    expect(app.accessibility("id:ios-switch")?.checked).toBe("false");
    await app.press("id:ios-switch");
    expect(app.accessibility("id:ios-switch")?.checked).toBe("true");

    // Segmented control uses semibold on selected tab and medium on unselected tab.
    expect(app.spanStyle("id:seg-a >> text:First").fontWeight).toBe(600);
    expect(app.spanStyle("id:seg-b >> text:Second").fontWeight).toBe(500);
    await app.press("id:seg-b");
    expect(app.spanStyle("id:seg-b >> text:Second").fontWeight).toBe(600);
    expect(app.spanStyle("id:seg-a >> text:First").fontWeight).toBe(500);

    // Host state pills pair distinct non-color glyphs + labels with label text on system-color tints.
    const hostCases = [
      ["id:host-starting", "◐", "Starting"],
      ["id:host-running", "●", "Running (2 active)"],
      ["id:host-restarting", "↻", "Restarting (2s)"],
      ["id:host-stopped", "■", "Stopped"],
      ["id:host-failed", "▲", "Failed"],
      ["id:host-offline", "■", "Offline"],
    ] as const;
    for (const [selector, glyph, label] of hostCases) {
      expect(app.shows(`${selector} >> text:${glyph}`)).toBe(true);
      expect(app.shows(`${selector} >> text:${label}`)).toBe(true);
      expect(app.spanStyle(`${selector} >> text:${label}`).color).toBe("#000000ff");
      expect(app.viewStyle(selector)?.backgroundColor).toBeTruthy();
    }

    // Semantic Badge variants use the Host badge pattern: system-color tint with label text (light and dark).
    const lightBadges = [
      ["id:badge-neutral", null, "Neutral", "#78788033"],
      ["id:badge-primary", null, "Primary", "#007aff29"],
      ["id:badge-success", "✓", "Success", "#34c75929"],
      ["id:badge-warning", "!", "Warning", "#ff950029"],
      ["id:badge-danger", "×", "Danger", "#ff3b3029"],
    ] as const;
    for (const [selector, glyph, label, bg] of lightBadges) {
      expect(app.viewStyle(selector)?.backgroundColor).toBe(bg);
      expect(app.spanStyle(`${selector} >> text:${label}`).color).toBe("#000000ff");
      if (glyph) {
        expect(app.spanStyle(`${selector} >> text:${glyph}`).color).toBe("#000000ff");
      }
    }

    await app.setColorScheme("dark");
    const darkBadges = [
      ["id:badge-neutral", null, "Neutral", "#7878805c"],
      ["id:badge-primary", null, "Primary", "#0a84ff3d"],
      ["id:badge-success", "✓", "Success", "#30d1583d"],
      ["id:badge-warning", "!", "Warning", "#ff9f0a3d"],
      ["id:badge-danger", "×", "Danger", "#ff453a3d"],
    ] as const;
    for (const [selector, glyph, label, bg] of darkBadges) {
      expect(app.viewStyle(selector)?.backgroundColor).toBe(bg);
      expect(app.spanStyle(`${selector} >> text:${label}`).color).toBe("#ffffffff");
      if (glyph) {
        expect(app.spanStyle(`${selector} >> text:${glyph}`).color).toBe("#ffffffff");
      }
    }
  });

  test("App cold start in OS dark mode selects System Appearance in the sidebar", async () => {
    const app = await open("../../App.tsx", {
      platform: "macos",
      width: 1200,
      height: 820,
      colorScheme: "dark",
      modules: {
        "byok-nsh-adapter": {
          "ByokShell.start": { started: true, alreadyStarted: false, state: null },
        },
      },
    });

    expect(app.accessibility("id:theme-system")?.selected).toBe(true);
    expect(app.accessibility("id:theme-light")?.selected).toBe(false);
    expect(app.accessibility("id:theme-dark")?.selected).toBe(false);

    await app.setColorScheme("light");
    expect(app.accessibility("id:theme-system")?.selected).toBe(true);
  });
});
