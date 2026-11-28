import { formatNumber, t } from "./i18n.ts";
import { errorText, restartSeconds } from "./statusCopy.ts";
import { ByokShell } from "byok-nsh-adapter";
import { resource, setColorScheme, signal, untracked } from "nsh";
import type { WindowRef } from "nsh/desktop";
import type { BotProfile } from "../../src/host/store/types.ts";
import type { ActivityCard } from "../../src/host/activity/cards.ts";
import type { DeviceParams, DeviceView, DreamingSetting, HostSettings } from "../../src/host/settings/types.ts";
import type { LoginItemView } from "../../src/bridge/domains/settings.ts";
import type { ShellView } from "../../src/bridge/domains/shell.ts";
import type { BridgeMethods, SupervisedHostState } from "../../src/bridge/protocol.ts";
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
const appearanceSignal = signal<AppearanceMode>("system");
const activeSectionSignal = signal<WorkspaceSection>("keys");
const onboardingDismissedSignal = signal(false);
const shellStartSignal = signal<ShellStart>({ status: "pending" });
const selectedBotIdSignal = signal<string | null>(null);
const k8ReloadSignal = signal(0);
const k8BusyRereadSignal = signal(0);
const botMemoryReloadSignal = signal(0);
const unfoldedBotsSignal = signal<ReadonlySet<string>>(new Set());
const activityReloadSignal = signal(0);
const expandedCardsSignal = signal<ReadonlySet<string>>(new Set());
const approvalDecisionsSignal = signal<ReadonlyMap<string, ApprovalDecision>>(new Map());
const dreamingSavingSignal = signal(false);

/** One approval decision's state: the decision running, or the Host's refusal of the last attempt. */
export interface ApprovalDecision {
  readonly running: "approve" | "reject" | null;
  readonly error: string | null;
}

/** How soon `k8.view` is read again while some Bot is busy: a runtime or profile catching up reaches no Host hint. */
export const BUSY_REREAD_MS = 1500;
let busyRereadTimer: ReturnType<typeof setTimeout> | undefined;

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

/**
 * The app's one `k8.view` load for the selected Bot: it starts once the Host runs and reloads on each Host state
 * hint, on a Bot switch, on `reloadK8View`, and after {@link BUSY_REREAD_MS} while the last read said `busy` and the
 * Conversation section shows (`armBusyReread`).
 * Module-scoped, so a section switch neither drops nor repeats it and no screen polls on its own. The resource keeps
 * its last value while it loads again and after a failure, so a failed read leaves the last snapshot on screen.
 */
export const k8View = resource(
  () =>
    hostReady()
      ? {
          botId: selectedBotIdSignal(),
          tick: stateHintCount() + k8ReloadSignal() + k8BusyRereadSignal(),
        }
      : false,
  async (source, info) => {
    clearTimeout(busyRereadTimer);
    const snapshot = await bridge.call("k8.view", { botId: source.botId });
    if (!info.signal.aborted) {
      armBusyReread(snapshot.busy);
      // Drop the Bots the snapshot no longer lists, so the set does not grow with every Bot ever seen.
      const live = new Set(snapshot.bots.map((bot) => bot.id));
      unfoldedBotsSignal.update((current) =>
        [...current].every((id) => live.has(id)) ? current : new Set([...current].filter((id) => live.has(id))),
      );
    }
    return snapshot;
  },
);

/**
 * Schedules the next busy reread, only while the Conversation section shows: the rail and transcript are what follow
 * a runtime or profile catching up. Leaving the section cancels it; the section stays out of `k8View`'s source, so a
 * section switch never reads `k8.view` by itself.
 */
function armBusyReread(busy: boolean): void {
  clearTimeout(busyRereadTimer);
  if (busy && untracked(() => activeSectionSignal()) === "conversation") {
    busyRereadTimer = setTimeout(() => k8BusyRereadSignal.update((n) => n + 1), BUSY_REREAD_MS);
  }
}

/** The Bot whose conversation `k8View` reads (null: none selected). */
export const selectedBotId = () => selectedBotIdSignal();

/** Selects the Bot whose conversation `k8View` reads. */
export function selectBot(id: string | null): void {
  selectedBotIdSignal.set(id);
}

/** Reads `k8.view` again (the Retry of a failed read). */
export function reloadK8View(): void {
  k8ReloadSignal.update((n) => n + 1);
}

/**
 * The selected Bot's one `k8.memory` read. It runs only while the Conversation section shows that Bot (its header
 * summary, or the Memory tab of its profile editor), and again on each Host state hint and on `reloadBotMemory`. The
 * value names its Bot: the resource keeps the last value while the next Bot's read runs.
 */
export const botMemory = resource(
  () => {
    const botId = selectedBotIdSignal();
    return hostReady() && activeSectionSignal() === "conversation" && botId !== null
      ? { botId, tick: stateHintCount() + botMemoryReloadSignal() }
      : false;
  },
  async (source) => ({ botId: source.botId, memory: await bridge.call("k8.memory", { botId: source.botId }) }),
);

/** Reads `k8.memory` again (the Retry of a failed read). */
export function reloadBotMemory(): void {
  botMemoryReloadSignal.update((n) => n + 1);
}

/** Whether the rows above the latest clear show for `botId`; kept per Bot across Bot and section switches. */
export const historyUnfolded = (botId: string) => unfoldedBotsSignal().has(botId);

/** Shows or hides the rows above the latest clear for `botId`. */
export function setHistoryUnfolded(botId: string, unfolded: boolean): void {
  unfoldedBotsSignal.update((current) => {
    const next = new Set(current);
    if (unfolded) {
      next.add(botId);
    } else {
      next.delete(botId);
    }
    return next;
  });
}

/**
 * The app's one `activity.cards` load: it runs only while the Host runs and the Activity section shows, and loads
 * again on each Host state hint and on `reloadActivityCards`. Leaving the section stops it, so no other section reads
 * the cards. The resource keeps its last value after a failure: the screen checks `activityCards.error()` first.
 */
export const activityCards = resource(
  () =>
    hostReady() && activeSectionSignal() === "activity"
      ? { tick: stateHintCount() + activityReloadSignal() }
      : false,
  async (): Promise<ActivityCard[]> => await bridge.call("activity.cards", undefined),
);

/** Reads `activity.cards` again (Retry, and after an approval decision). */
export function reloadActivityCards(): void {
  activityReloadSignal.update((n) => n + 1);
}

/** Whether the card of `taskId` shows its timeline; kept per task across reloads, recycled cells and sections. */
export const cardExpanded = (taskId: string) => expandedCardsSignal().has(taskId);

/** Shows or hides the timeline of the card of `taskId`. */
export function setCardExpanded(taskId: string, expanded: boolean): void {
  expandedCardsSignal.update((current) => {
    const next = new Set(current);
    if (expanded) {
      next.add(taskId);
    } else {
      next.delete(taskId);
    }
    return next;
  });
}

const decisionKey = (taskId: string, approvalId: string) => `${taskId}\n${approvalId}`;

/** The running or refused decision on one approval; kept in the store, so a recycled List cell neither drops nor repeats it. */
export const approvalDecision = (taskId: string, approvalId: string): ApprovalDecision | undefined =>
  approvalDecisionsSignal().get(decisionKey(taskId, approvalId));

function setApprovalDecision(key: string, decision: ApprovalDecision | null): void {
  approvalDecisionsSignal.update((current) => {
    const next = new Map(current);
    if (decision === null) {
      next.delete(key);
    } else {
      next.set(key, decision);
    }
    return next;
  });
}

/**
 * Approves or rejects exactly this pending approval (`activity.approve` / `activity.reject`). The Host answers a
 * decision the other entry made first with `StaleApprovalError`; either way the cards load again, so they show the
 * decided state, and a refusal stays on the approval until the next attempt.
 */
export async function decideApproval(taskId: string, approvalId: string, decision: "approve" | "reject"): Promise<void> {
  const key = decisionKey(taskId, approvalId);
  if (untracked(() => approvalDecisionsSignal().get(key)?.running)) {
    return;
  }
  setApprovalDecision(key, { running: decision, error: null });
  try {
    await bridge.call(decision === "approve" ? "activity.approve" : "activity.reject", { taskId, approvalId });
    setApprovalDecision(key, null);
  } catch (error) {
    setApprovalDecision(key, { running: null, error: toBridgeCallError(error).code });
  }
  reloadActivityCards();
}

/** Reads the daemon's status and the SDK doctor (`settings.device`). Pass `{ checkAuth: true }` to re-probe login state. */
export async function readDevice(params?: DeviceParams): Promise<DeviceView> {
  return await bridge.call("settings.device", params);
}

/** Reads the Host settings (`settings.get`). */
export async function readHostSettings(): Promise<HostSettings> {
  return await bridge.call("settings.get", undefined);
}

let dreamingSaveInFlight: Promise<HostSettings> | null = null;

/** True while a dreaming save runs; kept across section switches, so a remounted Settings sees it too. */
export const dreamingSaving = () => dreamingSavingSignal();

/** Saves the dreaming switch and model order; K8 reads them when the Host next starts (`settings.setDreaming`). */
export async function saveDreaming(setting: DreamingSetting): Promise<HostSettings> {
  const saving = bridge.call("settings.setDreaming", setting);
  dreamingSaveInFlight = saving;
  dreamingSavingSignal.set(true);
  try {
    return await saving;
  } finally {
    dreamingSaveInFlight = null;
    dreamingSavingSignal.set(false);
  }
}

/**
 * Resolves once no dreaming save runs. A `settings.get` waits for it: the Host serves both at once and renames the
 * file last, so a read during a save can return the value before it, and the save's reply belongs to a form that a
 * Refresh or a section switch already replaced. The save's own outcome reaches the form that started it.
 */
export async function dreamingSaveSettled(): Promise<void> {
  if (dreamingSaveInFlight !== null) {
    await Promise.allSettled([dreamingSaveInFlight]);
  }
}

/** Creates (under a UI-made id, reused on retry) or edits a Bot (`k8.saveBot`). */
export async function saveBot(profile: BotProfile): Promise<null> {
  return await bridge.call("k8.saveBot", profile);
}

/** Archives a Bot for good (`k8.archiveBot`). */
export async function archiveBot(id: string): Promise<null> {
  return await bridge.call("k8.archiveBot", { id });
}

/** One send keyed by the UI's action id, reused on retry (`k8.send`). */
export async function sendMessage(
  params: BridgeMethods["k8.send"]["params"],
): Promise<BridgeMethods["k8.send"]["result"]> {
  return await bridge.call("k8.send", params);
}

const pendingClears = new Map<string, string>();

/**
 * Clears the Bot's context: it no longer sees the messages above (`k8.clear`). The action id stays with the Bot until
 * the Host confirms the clear, so a retry after a lost reply, also after a Bot switch, adds no second clear.
 */
export async function clearContext(botId: string): Promise<null> {
  let actionId = pendingClears.get(botId);
  if (actionId === undefined) {
    actionId = crypto.randomUUID();
    pendingClears.set(botId, actionId);
  }
  await bridge.call("k8.clear", { actionId, botId });
  if (pendingClears.get(botId) === actionId) {
    pendingClears.delete(botId);
  }
  return null;
}

/** Cancels one open Turn (`k8.cancel`). */
export async function cancelTurn(turnId: string): Promise<BridgeMethods["k8.cancel"]["result"]> {
  return await bridge.call("k8.cancel", { turnId });
}

/** Answers a Bot's question (`k8.answer`). */
export async function answerQuestion(questionId: string, answer: string): Promise<null> {
  return await bridge.call("k8.answer", { questionId, answer });
}

/** Active appearance override selected in the UI shell. */
export const appearance = () => appearanceSignal();

/** Active main workspace section (no hidden mounted trees). */
export const activeSection = () => activeSectionSignal();

/** Dismisses the first-run agent picker for the rest of the current session. */
export function dismissOnboarding(): void {
  onboardingDismissedSignal.set(true);
}

/** True while the first `k8.view` is in flight so first launch does not flash Keys or read `keys.list` prematurely. */
export const onboardingPending = () =>
  hostReady() && !onboardingDismissedSignal() && k8View() === undefined && k8View.error() === undefined;

/** True on a first launch (no Bots ever created and no Pi key profile configured) until dismissed or settled. */
export const showOnboarding = () => {
  if (!hostReady() || onboardingDismissedSignal() || k8View.error() !== undefined) {
    return false;
  }
  const view = k8View();
  return view !== undefined && view.bots.length === 0 && !view.models.some((model) => model.keyProfile);
};

/** Allows Gallery / showcase previews to inspect every Host-state badge token without touching live `hostReady()`. */
export function setPreviewHostState(next: SupervisedHostState | null): void {
  previewHostStateSignal.set(next);
}

/** Switches the active workspace section cleanly through the single store authority. */
export function setActiveSection(section: WorkspaceSection): void {
  onboardingDismissedSignal.set(true);
  activeSectionSignal.set(section);
  armBusyReread(untracked(() => k8View()?.busy === true));
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

/** A start refusal has no supervisor state, so the sidebar and tray report its coded error. */
function hostlessStatus(start: ShellStart): string {
  return start.status === "failed"
    ? t("host.stoppedWithError", { error: errorText(start.error.code) })
    : t("host.startingDetail");
}

export function describeHostState(host: SupervisedHostState | null, start: ShellStart): string {
  if (host === null) return hostlessStatus(start);
  if (host.state === "restarting") return t("host.restartingDetail", { seconds: restartSeconds(host) });
  return t("host." + host.state + "Detail");
}

export function trayStatusLabel(state: SupervisedHostState | null, start: ShellStart): string {
  return state?.state === "running"
    ? t("host.activeTasks", { count: formatNumber(state.activeWork) })
    : describeHostState(state, start);
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
