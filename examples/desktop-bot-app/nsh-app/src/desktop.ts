import { HOST_STATE_META } from "./ui/tokens.ts";
import { t } from "./i18n.ts";
import { effect, platform, type Bounds } from "nsh";
import {
  Application,
  isAvailable,
  Menu,
  Tray,
  type MenuItem,
  type WindowRef,
} from "nsh/desktop";
import trayIcon from "../assets/tray/tray.png";
// An SVG tray icon is an AppKit template on macOS: drawn in the menu bar's text color, so it stays visible on a dark bar.
import trayTemplateIcon from "../assets/tray/trayTemplate.svg";
import brand from "../../brand.config.ts";
import type { SupervisedHostState } from "../../src/bridge/protocol.ts";
import {
  bindMainWindow,
  hideMainWindow,
  showMainWindow,
  trayStatusLabel,
  type AppearanceMode,
  type ShellStart,
  type WorkspaceSection,
} from "./store.ts";

export interface TrayMenuBuildOptions {
  readonly host: SupervisedHostState | null;
  readonly start: ShellStart;
  readonly quitting: boolean;
  readonly recoveryBusy: boolean;
  readonly productName: string;
  readonly onShow: () => void;
  readonly onRestartHost: () => void;
  readonly onQuit: () => void;
}

export interface ApplicationMenuBuildOptions extends TrayMenuBuildOptions {
  readonly activeSection: WorkspaceSection;
  readonly appearance: AppearanceMode;
  readonly onSelectSection: (section: WorkspaceSection) => void;
  readonly onSelectAppearance: (mode: AppearanceMode) => void;
}

// No Host state means no supervisor yet (start pending) or none at all (start failed): a restart could only refuse
// with host_exited, so the menu disables it as the sidebar hides its button.
function canRestartFromMenu(options: TrayMenuBuildOptions): boolean {
  return !options.quitting && !options.recoveryBusy && options.host !== null && options.host.state !== "starting";
}

/**
 * Pure tray context menu builder wired strictly to unified store commands.
 * Matches Electron `trayMenu` semantics while adding explicit Host restart and Quit actions.
 */
export function buildTrayMenuItems(options: TrayMenuBuildOptions): MenuItem[] {
  const canRestart = canRestartFromMenu(options);
  return [
    { label: t("menu.showProduct", { product: options.productName }), onSelect: options.onShow },
    { label: `${HOST_STATE_META[options.host?.state ?? (options.start.status === "failed" ? "stopped" : "starting")].symbol} ${trayStatusLabel(options.host, options.start)}`, disabled: true },
    { type: "separator" },
    { label: t("host.restart"), disabled: !canRestart, onSelect: options.onRestartHost },
    { type: "separator" },
    { label: t("app.quit"), onSelect: options.onQuit },
  ];
}

/** Pure desktop application menu builder wired to store workspace & Host commands. */
export function buildApplicationMenuItems(options: ApplicationMenuBuildOptions): MenuItem[] {
  const canRestart = canRestartFromMenu(options);
  return [
    {
      label: options.productName,
      submenu: [
        ...(platform.os === "macos"
          ? [{ role: "about" as const, label: t("menu.about", { product: options.productName }) }, { type: "separator" as const }]
          : []),
        { label: t("menu.showProduct", { product: options.productName }), onSelect: options.onShow },
        {
          label: t("host.restart"),
          // A disabled item's shortcut chooses nothing, so the key follows canRestartFromMenu too.
          shortcut: "mod+shift+r",
          disabled: !canRestart,
          onSelect: options.onRestartHost,
        },
        { type: "separator" },
        platform.os === "macos"
          ? { role: "quit", label: t("menu.quitProduct", { product: options.productName }) }
          : { label: t("app.quit"), shortcut: "mod+q", onSelect: options.onQuit },
      ],
    },
    {
      label: t("menu.edit"),
      submenu: [
        { role: "undo", label: t("menu.undo") },
        { role: "redo", label: t("menu.redo") },
        { type: "separator" },
        { role: "cut", label: t("menu.cut") },
        { role: "copy", label: t("menu.copy") },
        { role: "paste", label: t("menu.paste") },
        { role: "selectAll", label: t("menu.selectAll") },
      ],
    },
    {
      label: t("menu.view"),
      submenu: [
        {
          label: t("section.conversation"),
          shortcut: "mod+1",
          when: "auto",
          checked: options.activeSection === "conversation",
          onSelect: () => options.onSelectSection("conversation"),
        },
        {
          label: t("section.activity"),
          shortcut: "mod+2",
          when: "auto",
          checked: options.activeSection === "activity",
          onSelect: () => options.onSelectSection("activity"),
        },
        {
          label: t("section.settings"),
          shortcut: "mod+3",
          when: "auto",
          checked: options.activeSection === "settings",
          onSelect: () => options.onSelectSection("settings"),
        },
        {
          label: t("section.keys"),
          shortcut: "mod+4",
          when: "auto",
          checked: options.activeSection === "keys",
          onSelect: () => options.onSelectSection("keys"),
        },
        { type: "separator" },
        {
          label: t("menu.light"),
          checked: options.appearance === "light",
          onSelect: () => options.onSelectAppearance("light"),
        },
        {
          label: t("menu.dark"),
          checked: options.appearance === "dark",
          onSelect: () => options.onSelectAppearance("dark"),
        },
        {
          label: t("menu.system"),
          checked: options.appearance === "system",
          onSelect: () => options.onSelectAppearance("system"),
        },
      ],
    },
    {
      label: t("menu.window"),
      submenu: [
        { role: "minimize", label: t("menu.minimize") },
        ...(platform.os === "macos" ? [{ role: "zoom" as const, label: t("menu.zoom") }] : []),
        { role: "close", label: t("common.close") },
      ],
    },
  ];
}

/** Synchronizes the desktop system tray and application menu from reactive store state. */
export function syncDesktopChrome(options: Omit<ApplicationMenuBuildOptions, "productName">): void {
  if (!isAvailable) {
    return;
  }
  const fullOptions: ApplicationMenuBuildOptions = {
    ...options,
    productName: brand.productName,
  };
  Tray.set({
    icon: platform.os === "macos" ? trayTemplateIcon : trayIcon,
    tooltip: brand.productName,
    menu: buildTrayMenuItems(fullOptions),
    onClick: options.onShow,
  });
  Menu.setApplicationMenu(buildApplicationMenuItems(fullOptions));
}

/**
 * The window bounds moved and shrunk into the display's work area (`visibleBounds`), or null when they already fit.
 * Both are in screen points.
 */
export function fitIntoWorkArea(bounds: Bounds, area: Bounds): Bounds | null {
  const width = Math.min(bounds.size.width, area.size.width);
  const height = Math.min(bounds.size.height, area.size.height);
  const x = Math.min(Math.max(bounds.origin.x, area.origin.x), area.origin.x + area.size.width - width);
  const y = Math.min(Math.max(bounds.origin.y, area.origin.y), area.origin.y + area.size.height - height);
  if (x === bounds.origin.x && y === bounds.origin.y && width === bounds.size.width && height === bounds.size.height) {
    return null;
  }
  return { origin: { x, y }, size: { width, height } };
}

/**
 * Fits the first window into its display's work area, once. NSH opens it at the hidden host's size (1200 × 800 pt)
 * and origin and does not clamp it to the work area, so at 150 % on a 1920 × 1080 display it opens partly off-screen
 * (#2532). Later moves are the user's and stay as they are.
 */
export function fitFirstWindow(win: WindowRef): void {
  let fitted = false;
  effect(() => {
    if (fitted) {
      return;
    }
    const state = win.state();
    if (!state?.display) {
      return;
    }
    fitted = true;
    const bounds = state.mode === "normal" ? fitIntoWorkArea(state.bounds, state.display.visibleBounds) : null;
    if (bounds) {
      win.setBounds(bounds);
    }
  });
}

/**
 * Configures desktop window close-to-tray (`closeOnPress: false` + hide on `closePress`)
 * and binds `reopen` / `secondInstance` to focus the preserved window.
 */
export function installDesktopShell(win: WindowRef | null): () => void {
  const unbindWindowRef = bindMainWindow(win);
  if (!isAvailable || !win) {
    return unbindWindowRef;
  }
  win.set({
    closeOnPress: false,
    minSize: { width: 840, height: 560 },
  });
  const stopClose = win.on("closePress", () => {
    hideMainWindow();
  });
  const stopReopen = Application.on("reopen", () => {
    showMainWindow();
  });
  const stopSecondInstance = Application.on("secondInstance", () => {
    showMainWindow();
  });
  return () => {
    stopSecondInstance();
    stopReopen();
    stopClose();
    Tray.set(null);
    Menu.setApplicationMenu(null);
    unbindWindowRef();
  };
}
