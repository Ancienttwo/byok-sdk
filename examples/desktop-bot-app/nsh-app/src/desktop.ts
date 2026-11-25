import { platform } from "nsh";
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
  type WorkspaceSection,
} from "./store.ts";

export interface TrayMenuBuildOptions {
  readonly host: SupervisedHostState | null;
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

function canRestartFromMenu(options: TrayMenuBuildOptions): boolean {
  return !options.quitting && !options.recoveryBusy && options.host?.state !== "starting";
}

/**
 * Pure tray context menu builder wired strictly to unified store commands.
 * Matches Electron `trayMenu` semantics while adding explicit Host restart and Quit actions.
 */
export function buildTrayMenuItems(options: TrayMenuBuildOptions): MenuItem[] {
  const canRestart = canRestartFromMenu(options);
  return [
    { label: `Show ${options.productName}`, onSelect: options.onShow },
    { label: trayStatusLabel(options.host), disabled: true },
    { type: "separator" },
    { label: "Restart Host", disabled: !canRestart, onSelect: options.onRestartHost },
    { type: "separator" },
    { label: "Quit", onSelect: options.onQuit },
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
          ? [{ role: "about" as const }, { type: "separator" as const }]
          : []),
        { label: `Show ${options.productName}`, onSelect: options.onShow },
        {
          label: "Restart Host",
          // A disabled item's shortcut chooses nothing, so the key follows canRestartFromMenu too.
          shortcut: "mod+shift+r",
          disabled: !canRestart,
          onSelect: options.onRestartHost,
        },
        { type: "separator" },
        platform.os === "macos"
          ? { role: "quit" }
          : { label: "Quit", shortcut: "mod+q", onSelect: options.onQuit },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Conversation",
          shortcut: "mod+1",
          when: "auto",
          checked: options.activeSection === "conversation",
          onSelect: () => options.onSelectSection("conversation"),
        },
        {
          label: "Activity",
          shortcut: "mod+2",
          when: "auto",
          checked: options.activeSection === "activity",
          onSelect: () => options.onSelectSection("activity"),
        },
        {
          label: "Settings",
          shortcut: "mod+3",
          when: "auto",
          checked: options.activeSection === "settings",
          onSelect: () => options.onSelectSection("settings"),
        },
        {
          label: "Keys",
          shortcut: "mod+4",
          when: "auto",
          checked: options.activeSection === "keys",
          onSelect: () => options.onSelectSection("keys"),
        },
        { type: "separator" },
        {
          label: "Light Appearance",
          checked: options.appearance === "light",
          onSelect: () => options.onSelectAppearance("light"),
        },
        {
          label: "Dark Appearance",
          checked: options.appearance === "dark",
          onSelect: () => options.onSelectAppearance("dark"),
        },
        {
          label: "System Appearance",
          checked: options.appearance === "system",
          onSelect: () => options.onSelectAppearance("system"),
        },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        ...(platform.os === "macos" ? [{ role: "zoom" as const }] : []),
        { role: "close" },
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
