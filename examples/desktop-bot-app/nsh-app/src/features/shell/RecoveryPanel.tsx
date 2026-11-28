import { t } from "../../i18n.ts";
import { errorText } from "../../statusCopy.ts";
import { resource, signal, Text, View } from "nsh";
import type { SupervisedHostState } from "../../../../src/bridge/protocol.ts";
import { toBridgeCallError } from "../../bridge.ts";
import {
  exportDiagnostics,
  hostState,
  isQuitting,
  isRecoveryBusy,
  readShellView,
  restartHost,
  runShellRestore,
  runShellStartFresh,
  stateHintCount,
} from "../../store.ts";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, Spinner } from "../../ui/index.ts";


/** Triggers `settings.exportDiagnostics` and announces the output path via a polite live region. */
export function DiagnosticsExportButton(props: { testID: string; disabled?: boolean }) {
  const busy = signal(false);
  const path = signal<string | null>(null);
  const errorMessage = signal<string | null>(null);

  const runExport = async () => {
    if (busy() || props.disabled) {
      return;
    }
    busy.set(true);
    path.set(null);
    errorMessage.set(null);
    try {
      const out = await exportDiagnostics();
      path.set(out.path);
    } catch (error) {
      errorMessage.set(toBridgeCallError(error).code);
    } finally {
      busy.set(false);
    }
  };

  return (
    <View class="gap-1.5">
      <View class="flex-row items-center gap-2">
        <Button
          testID={props.testID}
          variant="outline"
          size="sm"
          loading={busy()}
          disabled={busy() || Boolean(props.disabled)}
          onPress={() => void runExport()}
        >
          {t("recovery.export")}
        </Button>
      </View>
      <If when={path()}>
        {(savedPath) => (
          <View
            testID={`${props.testID}-status`}
            role="region"
            accessibilityLiveRegion="polite"
            accessible
            accessibilityLabel={t("recovery.exported", { path: savedPath() })}
          >
            <Text class="text-xs font-mono text-muted-foreground">{t("recovery.exported", { path: savedPath() })}</Text>
          </View>
        )}
      </If>
      <If when={errorMessage()}>
        {(msg) => (
          <View testID={`${props.testID}-error`} role="alert">
            <Text class="text-xs text-destructive">{t("recovery.exportError", { error: errorText(msg()) })}</Text>
          </View>
        )}
      </If>
    </View>
  );
}

type StoppedHost = Extract<SupervisedHostState, { readonly state: "stopped" }>;
type FailedHost = Extract<SupervisedHostState, { readonly state: "failed" }>;

/** Host recovery and diagnostics banner displayed strictly when live Host is `stopped` or `failed`. */
export function RecoveryPanel() {
  const stoppedHost = (): StoppedHost | null => {
    const current = hostState();
    return current?.state === "stopped" ? current : null;
  };
  const failedHost = (): FailedHost | null => {
    const current = hostState();
    return current?.state === "failed" ? current : null;
  };

  const shellView = resource(
    () => (stoppedHost() !== null ? stateHintCount() + 1 : false),
    async () => await readShellView(),
  );

  const shellViewError = (): string | null => {
    const err = shellView.error();
    return err === undefined ? null : toBridgeCallError(err).code;
  };
  const restoreInfo = () => shellView()?.restore ?? null;
  const restoreUnavailable = () => shellView()?.restoreError != null;

  const confirmAction = signal<"restore" | "startFresh" | null>(null);
  const recoveryError = signal<{ action: "restore" | "startFresh"; code: string } | null>(null);
  const restarting = signal(false);

  const runRecovery = async (action: "restore" | "startFresh") => {
    if (isRecoveryBusy() || isQuitting()) {
      return;
    }
    confirmAction.set(null);
    recoveryError.set(null);
    try {
      if (action === "restore") {
        await runShellRestore();
      } else {
        await runShellStartFresh();
      }
    } catch (error) {
      recoveryError.set({ action, code: toBridgeCallError(error).code });
    }
  };

  const handleRestart = () => {
    if (restarting() || isQuitting() || isRecoveryBusy()) {
      return;
    }
    restarting.set(true);
    void restartHost().finally(() => {
      restarting.set(false);
    });
  };

  return (
    <View class="gap-4">
      <If when={stoppedHost()}>
        {(host) => (
          <View testID="shell-recovery-panel" role="alert">
            <Card class="border-destructive">
              <CardHeader>
                <CardTitle>{t("recovery.stopTitle")}</CardTitle>
                <If when={host().storeRefused}>
                  <CardDescription>{t("recovery.storeRefused")}</CardDescription>
                </If>
              </CardHeader>
              <CardContent>
                <DiagnosticsExportButton
                  testID="recovery-export-diagnostics"
                  disabled={isRecoveryBusy() || isQuitting()}
                />

                <If when={shellView.loading() && shellView() === undefined}>
                  <Spinner label={t("recovery.snapshotLoading")} />
                </If>
                <If when={shellViewError()}>
                  {(err) => (
                    <Text class="text-xs text-destructive">
                      {t("recovery.shellError", { error: errorText(err()) })}
                    </Text>
                  )}
                </If>
                <If when={restoreUnavailable()}>
                  <Text class="text-xs text-destructive">{t("recovery.snapshotError")}</Text>
                </If>

                <View class="flex-row flex-wrap items-center gap-2">
                  <If when={restoreInfo()}>
                    {(restore) => (
                      <Button
                        testID="recovery-restore-btn"
                        variant="secondary"
                        disabled={isRecoveryBusy() || isQuitting()}
                        onPress={() => confirmAction.set("restore")}
                      >
                        {t("recovery.restoreVersion", { version: restore().version })}
                      </Button>
                    )}
                  </If>
                  <If when={host().storeRefused}>
                    <Button
                      testID="recovery-start-fresh-btn"
                      variant="danger"
                      disabled={isRecoveryBusy() || isQuitting()}
                      onPress={() => confirmAction.set("startFresh")}
                    >
                      {t("recovery.startFresh")}
                    </Button>
                  </If>
                </View>

                <If when={recoveryError()}>
                  {(msg) => (
                    <View testID="recovery-error" role="alert">
                      <Text class="text-xs text-destructive">{t(msg().action === "restore" ? "recovery.restoreError" : "recovery.freshError", { error: errorText(msg().code) })}</Text>
                    </View>
                  )}
                </If>
              </CardContent>
            </Card>
          </View>
        )}
      </If>

      <If when={failedHost()}>
          <View testID="shell-failed-panel" role="alert">
            <Card class="border-destructive">
              <CardHeader>
                <CardTitle>{t("recovery.failedTitle")}</CardTitle>
              </CardHeader>
              <CardContent>
                {/* The Host has exited, so a diagnostics export could only refuse with host_exited. */}
                <Text testID="shell-failed-hint" class="text-xs text-muted-foreground">
                  {t("recovery.failedHint")}
                </Text>
                <View class="flex-row flex-wrap items-center gap-2">
                  <Button
                    testID="recovery-restart-host"
                    variant="primary"
                    loading={restarting()}
                    disabled={restarting() || isQuitting() || isRecoveryBusy()}
                    onPress={handleRestart}
                  >
                    {t("host.restart")}
                  </Button>
                </View>
              </CardContent>
            </Card>
          </View>
      </If>

      <Dialog
        testID="recovery-restore-dialog"
        open={confirmAction() === "restore"}
        role="alertdialog"
        title={t("recovery.confirmRestore")}
        description={
          restoreInfo()
            ? t("recovery.confirmRestoreDetail", { version: restoreInfo()!.version })
            : undefined
        }
        onOpenChange={(open) => {
          if (!open && !isRecoveryBusy()) {
            confirmAction.set(null);
          }
        }}
        footer={
          <View class="flex-row items-center gap-2">
            <Button
              testID="recovery-restore-cancel"
              variant="outline"
              size="sm"
              disabled={isRecoveryBusy()}
              onPress={() => confirmAction.set(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              testID="recovery-restore-confirm"
              variant="primary"
              size="sm"
              loading={isRecoveryBusy()}
              disabled={isRecoveryBusy()}
              onPress={() => void runRecovery("restore")}
            >
              {t("recovery.restoreAndRestart")}
            </Button>
          </View>
        }
      >
        <Text class="text-xs text-muted-foreground">
          {t("recovery.keepsDirectories")}
        </Text>
      </Dialog>

      <Dialog
        testID="recovery-start-fresh-dialog"
        open={confirmAction() === "startFresh"}
        role="alertdialog"
        title={t("recovery.confirmFresh")}
        description={t("recovery.confirmFreshDetail")}
        onOpenChange={(open) => {
          if (!open && !isRecoveryBusy()) {
            confirmAction.set(null);
          }
        }}
        footer={
          <View class="flex-row items-center gap-2">
            <Button
              testID="recovery-start-fresh-cancel"
              variant="outline"
              size="sm"
              disabled={isRecoveryBusy()}
              onPress={() => confirmAction.set(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              testID="recovery-start-fresh-confirm"
              variant="danger"
              size="sm"
              loading={isRecoveryBusy()}
              disabled={isRecoveryBusy()}
              onPress={() => void runRecovery("startFresh")}
            >
              {t("recovery.moveAndRestart")}
            </Button>
          </View>
        }
      >
        <Text class="text-xs text-muted-foreground">
          {t("recovery.keepsKeys")}
        </Text>
      </Dialog>
    </View>
  );
}
