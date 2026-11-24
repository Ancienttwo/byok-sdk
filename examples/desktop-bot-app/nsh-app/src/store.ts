import { ByokShell } from "byok-nsh-adapter";
import { setColorScheme, signal } from "nsh";
import type { SupervisedHostState } from "../../src/bridge/protocol.ts";

export type AppearanceMode = "light" | "dark" | "system";

const hostStateSignal = signal<SupervisedHostState | null>(null);
const powerErrorSignal = signal<string | null>(null);
const quittingSignal = signal(false);
const stateHintCountSignal = signal(0);
const appearanceSignal = signal<AppearanceMode>("light");

/** Latest Host supervisor state mirrored from Rust (null before first state arrives). */
export const hostState = () => hostStateSignal();

/** Latest keep-awake acquisition error message from Rust, if any. */
export const powerError = () => powerErrorSignal();

/** True once app shutdown drain has started. */
export const isQuitting = () => quittingSignal();

/** Counter incremented on each 50 ms coalesced Host state hint. */
export const stateHintCount = () => stateHintCountSignal();

/** Active appearance override selected in the UI shell. */
export const appearance = () => appearanceSignal();

/** Allows Gallery / showcase previews to inspect every Host-state badge token when live Host is idle. */
export function setPreviewHostState(next: SupervisedHostState | null): void {
  hostStateSignal.set(next);
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
    hostStateSignal.set(initialState);
  }
  powerErrorSignal.set(readPowerMessage(ByokShell.powerError()));

  const stopHooks = ByokShell.installQuitHooks();
  const stopState = ByokShell.onState((next) => {
    hostStateSignal.set((next as SupervisedHostState | null) ?? null);
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

/** Single app-wide command for setting color appearance. */
export function setAppearance(mode: AppearanceMode): void {
  appearanceSignal.set(mode);
  setColorScheme(mode);
}

/** Single app-wide command for triggering unified graceful shutdown. */
export function requestQuit(): void {
  ByokShell.requestQuit();
}

/** Single app-wide command for restarting the supervised Host process. */
export function restartHost(): void {
  ByokShell.restart();
}
