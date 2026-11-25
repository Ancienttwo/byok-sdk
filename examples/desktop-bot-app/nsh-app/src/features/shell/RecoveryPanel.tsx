import { resource, signal, Text, View } from "nsh";
import type { SupervisedHostState } from "../../../../src/bridge/protocol.ts";
import { refusalOf, type Refusal } from "../../../../src/keys/submit.ts";
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

function formatRefusalText(refusal: Refusal): string {
  return refusal.code ? `${refusal.code}: ${refusal.message}` : refusal.message;
}

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
      errorMessage.set(formatRefusalText(refusalOf(error)));
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
          Export diagnostics
        </Button>
      </View>
      <If when={path()}>
        {(savedPath) => (
          <View
            testID={`${props.testID}-status`}
            role="region"
            accessibilityLiveRegion="polite"
            accessible
            accessibilityLabel={`Written to ${savedPath()}`}
          >
            <Text class="text-xs font-mono text-muted-foreground">{`Written to ${savedPath()}`}</Text>
          </View>
        )}
      </If>
      <If when={errorMessage()}>
        {(msg) => (
          <View testID={`${props.testID}-error`} role="alert">
            <Text class="text-xs text-destructive">{`Export failed: ${msg()}`}</Text>
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

  const shellViewError = (): Refusal | null => {
    const err = shellView.error();
    return err ? refusalOf(err) : null;
  };
  const restoreInfo = () => shellView()?.restore ?? null;
  const restoreErrorText = () => shellView()?.restoreError ?? null;

  const confirmAction = signal<"restore" | "startFresh" | null>(null);
  const recoveryError = signal<string | null>(null);
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
      const refusal = refusalOf(error);
      const prefix = action === "restore" ? "Restore failed" : "Start fresh failed";
      recoveryError.set(`${prefix}: ${formatRefusalText(refusal)}`);
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
                <CardTitle>The Host stopped</CardTitle>
                <CardDescription>{host().reason}</CardDescription>
              </CardHeader>
              <CardContent>
                <DiagnosticsExportButton testID="recovery-export-diagnostics" disabled={isRecoveryBusy()} />

                <If when={shellView.loading() && shellView() === undefined}>
                  <Spinner label="Checking S1 recovery snapshot…" />
                </If>
                <If when={shellViewError()}>
                  {(err) => (
                    <Text class="text-xs text-destructive">
                      {`Shell status unavailable: ${formatRefusalText(err())}`}
                    </Text>
                  )}
                </If>
                <If when={restoreErrorText()}>
                  {(msg) => (
                    <Text class="text-xs text-destructive">{`Restore unavailable: ${msg()}`}</Text>
                  )}
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
                        {`Restore data of version ${restore().version}`}
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
                      Start fresh
                    </Button>
                  </If>
                </View>

                <If when={recoveryError()}>
                  {(msg) => (
                    <View testID="recovery-error" role="alert">
                      <Text class="text-xs text-destructive">{msg()}</Text>
                    </View>
                  )}
                </If>
              </CardContent>
            </Card>
          </View>
        )}
      </If>

      <If when={failedHost()}>
        {(host) => (
          <View testID="shell-failed-panel" role="alert">
            <Card class="border-destructive">
              <CardHeader>
                <CardTitle>The Host failed</CardTitle>
                <CardDescription>{host().reason}</CardDescription>
              </CardHeader>
              <CardContent>
                {/* The Host has exited, so a diagnostics export could only refuse with host_exited. */}
                <Text testID="shell-failed-hint" class="text-xs text-muted-foreground">
                  Restart the Host; once it runs, Settings can export diagnostics.
                </Text>
                <View class="flex-row flex-wrap items-center gap-2">
                  <Button
                    testID="recovery-restart-host"
                    variant="primary"
                    loading={restarting()}
                    disabled={restarting() || isQuitting() || isRecoveryBusy()}
                    onPress={handleRestart}
                  >
                    Restart Host
                  </Button>
                </View>
              </CardContent>
            </Card>
          </View>
        )}
      </If>

      <Dialog
        testID="recovery-restore-dialog"
        open={confirmAction() === "restore"}
        role="alertdialog"
        title="Restore pre-update snapshot?"
        description={
          restoreInfo()
            ? `The app stops, renames the current data to *.aside-<time> next to where it was (nothing is deleted), puts back the copy version ${restoreInfo()!.version} kept before its update, and restarts.`
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
              Cancel
            </Button>
            <Button
              testID="recovery-restore-confirm"
              variant="primary"
              size="sm"
              loading={isRecoveryBusy()}
              disabled={isRecoveryBusy()}
              onPress={() => void runRecovery("restore")}
            >
              Restore and restart
            </Button>
          </View>
        }
      >
        <Text class="text-xs text-muted-foreground">
          Existing directories are moved aside rather than deleted.
        </Text>
      </Dialog>

      <Dialog
        testID="recovery-start-fresh-dialog"
        open={confirmAction() === "startFresh"}
        role="alertdialog"
        title="Move data aside and start fresh?"
        description="The app stops and renames its data folders to *.aside-<time> next to where they were; nothing is deleted. It removes this device's enrollment and restarts as a new device with no Bots and no provider profiles."
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
              Cancel
            </Button>
            <Button
              testID="recovery-start-fresh-confirm"
              variant="danger"
              size="sm"
              loading={isRecoveryBusy()}
              disabled={isRecoveryBusy()}
              onPress={() => void runRecovery("startFresh")}
            >
              Move the data aside and start fresh
            </Button>
          </View>
        }
      >
        <Text class="text-xs text-muted-foreground">
          Provider keys stay in the OS credential store; a new profile still needs its key entered.
        </Text>
      </Dialog>
    </View>
  );
}
