import { ByokShell } from "byok-nsh-adapter";
import { setColorScheme, signal } from "nsh";
import type { WindowRef } from "nsh/desktop";
import type { LoginItemView } from "../../src/bridge/domains/settings.ts";
import type { ShellView } from "../../src/bridge/domains/shell.ts";
import type { SupervisedHostState } from "../../src/bridge/protocol.ts";
import { BridgeCallError, bridge, toBridgeCallError } from "./bridge.ts";

export type AppearanceMode = "light" | "dark" | "system";
export type WorkspaceSection = "conversation" | "activity" | "settings" | "keys" | "gallery";

/** Outcome of the app-startup `ByokShell.start`: Keys bridge calls wait for `started`. */
export type ShellStart =
  | { readonly status: "pending" }
  | { readonly status: "started" }
  | { readonly status: "failed"; readonly error: BridgeCallError };

const liveHostStateSignal = signal<SupervisedHostState | null>(null);
const previewHostStateSignal = signal<SupervisedHostState | null>(null);
const powerErrorSignal = signal<string | null>(null);
const quittingSignal = signal(false);
const recoveryBusySignal = signal(false);
const stateHintCountSignal = signal(0);
const appearanceSignal = signal<AppearanceMode>("light");
const activeSectionSignal = signal<WorkspaceSection>("keys");
const shellStartSignal = signal<ShellStart>({ status: "pending" });

let mainWindowRef: WindowRef | null = null;

/** Latest live Host supervisor state mirrored from Rust (null before first state arrives). */
export const hostState = () => liveHostStateSignal();

/** Isolated preview Host state used exclusively inside the Foundations Gallery showcase. */
export const previewHostState = () => previewHostStateSignal();

/** Latest keep-awake acquisition error message from Rust, if any. */
export const powerError = () => powerErrorSignal();

/** True once app shutdown drain has started. */
export const isQuitting = () => quittingSignal();

/** True while S1 store restore/start-fresh recovery is running or handing over to restart. */
export const isRecoveryBusy = () => recoveryBusySignal();

/** Counter incremented on each 50 ms coalesced Host state hint. */
export const stateHintCount = () => stateHintCountSignal();

/** Latest `ByokShell.start` outcome (`pending` until startup or a retry settles). */
export const shellStart = () => shellStartSignal();

/** True once the shell started and the live supervised Host reports `running`. */
export const hostReady = () =>
  shellStartSignal().status === "started" && liveHostStateSignal()?.state === "running";

/** Active appearance override selected in the UI shell. */
export const appearance = () => appearanceSignal();

/** Active main workspace section (no hidden mounted trees). */
export const activeSection = () => activeSectionSignal();

/** Allows Gallery / showcase previews to inspect every Host-state badge token without touching live `hostReady()`. */
export function setPreviewHostState(next: SupervisedHostState | null): void {
  previewHostStateSignal.set(next);
}

/** Switches the active workspace section cleanly through the single store authority. */
export function setActiveSection(section: WorkspaceSection): void {
  activeSectionSignal.set(section);
}

/** Registers the active desktop main window ref so Show/Hide commands share one target. */
export function bindMainWindow(win: WindowRef | null): () => void {
  mainWindowRef = win;
  return () => {
    if (mainWindowRef === win) {
      mainWindowRef = null;
    }
  };
}

/** Shows, restores (if minimized), and focuses the desktop main window. */
export function showMainWindow(): void {
  const win = mainWindowRef;
  if (!win) {
    return;
  }
  if (win.state()?.minimized) {
    win.restore();
  }
  win.show();
  win.focus();
}

/** Hides the desktop main window to keep reactive UI state and active locks alive in tray. */
export function hideMainWindow(): void {
  mainWindowRef?.hide();
}

/** Human-readable status text matching Electron `HostStatus` copy. */
export function describeHostState(host: SupervisedHostState | null): string {
  if (host === null) {
    return "Host starting";
  }
  switch (host.state) {
    case "starting":
      return "Host starting";
    case "running":
      return "Host running";
    case "restarting":
      return `Host restarting in ${Math.ceil(host.inMs / 1000)} s: ${host.reason}`;
    case "stopped":
      return `Host stopped: ${host.reason}`;
    case "failed":
      return `Host failed: ${host.reason}`;
  }
}

/** Concise tray status line matching Electron `trayMenu`. */
export function trayStatusLabel(state: SupervisedHostState | null): string {
  if (state === null) {
    return "Host starting";
  }
  switch (state.state) {
    case "running":
      return `Active tasks: ${state.activeWork}`;
    case "stopped":
      return `Host stopped: ${state.reason}`;
    case "restarting":
      return `Host restarting: ${state.reason}`;
    case "failed":
      return `Host failed: ${state.reason}`;
    case "starting":
      return "Host starting";
  }
}

function readPowerMessage(raw: unknown): string | null {
  if (typeof raw === "object" && raw !== null && "message" in raw) {
    const msg = (raw as { readonly message?: unknown }).message;
    return typeof msg === "string" ? msg : null;
  }
  return null;
}

/**
 * Subscribes the store's mirror signals to the Rust singleton supervisor and registers
 * native desktop quit hooks. Returns one idempotent cleanup callback.
 */
export function connectShell(): () => void {
  const initialState = ByokShell.state() as SupervisedHostState | null;
  if (initialState !== null) {
    liveHostStateSignal.set(initialState);
  }
  powerErrorSignal.set(readPowerMessage(ByokShell.powerError()));

  const stopHooks = ByokShell.installQuitHooks();
  const stopState = ByokShell.onState((next) => {
    liveHostStateSignal.set((next as SupervisedHostState | null) ?? null);
  });
  const stopHint = ByokShell.onStateHint(() => {
    stateHintCountSignal.update((count) => count + 1);
  });
  const stopPower = ByokShell.onPowerError((err) => {
    powerErrorSignal.set(readPowerMessage(err));
  });
  const stopQuit = ByokShell.onQuitting(() => {
    quittingSignal.set(true);
  });

  return () => {
    stopQuit();
    stopPower();
    stopHint();
    stopState();
    stopHooks();
  };
}

/**
 * Starts (or confirms) the process-wide Host supervisor and records the outcome in `shellStart`.
 * Runs once from app startup after `connectShell` subscribed to state, and again only on an
 * explicit user retry. The returned state seeds `hostState`; later transitions arrive via `onState`.
 */
export async function startShell(): Promise<void> {
  shellStartSignal.set({ status: "pending" });
  try {
    const result = (await ByokShell.start()) as { readonly state: SupervisedHostState | null };
    if (result.state !== null) {
      liveHostStateSignal.set(result.state);
    }
    shellStartSignal.set({ status: "started" });
  } catch (error) {
    shellStartSignal.set({ status: "failed", error: toBridgeCallError(error) });
  }
}

/** Single app-wide command for setting color appearance. */
export function setAppearance(mode: AppearanceMode): void {
  appearanceSignal.set(mode);
  setColorScheme(mode);
}

/** Single app-wide command for triggering unified graceful shutdown. */
export function requestQuit(): void {
  ByokShell.requestQuit();
}

/** Single app-wide command for restarting the supervised Host process off the engine thread. */
export async function restartHost(): Promise<void> {
  if (quittingSignal() || recoveryBusySignal()) {
    return;
  }
  await ByokShell.restart();
}

async function withRecoveryLock<T>(operation: () => Promise<T>): Promise<T> {
  if (recoveryBusySignal() || quittingSignal()) {
    throw new BridgeCallError(
      "RECOVERY_IN_PROGRESS",
      "Another recovery or shutdown operation is already in progress.",
    );
  }
  recoveryBusySignal.set(true);
  try {
    return await operation();
  } catch (error) {
    recoveryBusySignal.set(false);
    throw error;
  }
}

/** Reads recovery snapshot state (`shell.state`) from the Rust shell. */
export async function readShellView(): Promise<ShellView> {
  return await bridge.call("shell.state", undefined);
}

/** Triggers S1 store restore and app restart (`shell.restore`). */
export async function runShellRestore(): Promise<{ asidePath: string }> {
  return await withRecoveryLock(() => bridge.call("shell.restore", undefined));
}

/** Triggers S1 start-fresh move-aside and app restart (`shell.startFresh`). */
export async function runShellStartFresh(): Promise<{ moved: readonly unknown[] }> {
  return await withRecoveryLock(() => bridge.call("shell.startFresh", undefined));
}

/** Exports diagnostics bundle under the Host's diagnostics directory (`settings.exportDiagnostics`). */
export async function exportDiagnostics(): Promise<{ path: string }> {
  return await bridge.call("settings.exportDiagnostics", undefined);
}

/** Reads the OS login-item setting (`settings.loginItem`). */
export async function readLoginItem(): Promise<LoginItemView> {
  return await bridge.call("settings.loginItem", undefined);
}

/** Updates the OS login-item setting and returns the OS-reported state (`settings.setLoginItem`). */
export async function updateLoginItem(enabled: boolean): Promise<LoginItemView> {
  return await bridge.call("settings.setLoginItem", { enabled });
}
