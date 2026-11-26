import { computed, resource, signal, Text, View } from "nsh";
import { toBridgeCallError } from "../../bridge.ts";
import type { DreamingSetting } from "../../../../src/host/settings/types.ts";
import { hostReady, isQuitting, k8View, readDevice, readHostSettings, saveDreaming } from "../../store.ts";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Spinner } from "../../ui/index.ts";
import { LoginItemControl } from "../shell/LoginItemControl.tsx";
import { DiagnosticsExportButton } from "../shell/RecoveryPanel.tsx";
import { DevicePanel } from "./DevicePanel.tsx";
import { DreamingForm } from "./DreamingForm.tsx";

const failureText = (error: unknown) => (error === undefined ? null : toBridgeCallError(error).message);

/**
 * Device, runtimes, clock skew and doctor, then dreaming, login item and diagnostics export. The section reads
 * `settings.device` and `settings.get` when it shows and on Refresh, never on a Host hint; the resources keep only the
 * latest read and drop it when the section unmounts. The dreaming models come from the store's shared `k8View`.
 */
export function SettingsScreen() {
  const refreshes = signal(0);
  const ready = computed(() => hostReady());
  const device = resource(
    () => (ready() ? refreshes() : false),
    async () => await readDevice(),
  );
  // `load` names the read: a new one mounts a new dreaming form from it, a save keeps the form (`mutate`, same load).
  const settings = resource(
    () => (ready() ? refreshes() : false),
    async (load) => ({ load, dreaming: (await readHostSettings()).dreaming }),
  );
  // Refresh waits for a running save: a read during it could mount the form on the value before the save and drop the
  // save's reply with the form it belonged to.
  const saving = signal(false);
  const save = async (setting: DreamingSetting) => {
    saving.set(true);
    try {
      return await saveDreaming(setting);
    } finally {
      saving.set(false);
    }
  };
  const deviceFailure = () => failureText(device.error());
  const settingsFailure = () => failureText(settings.error());
  const modelsFailure = () => failureText(k8View.error());
  const loadedSettings = () => (settingsFailure() === null ? settings() : undefined);
  const models = () => k8View()?.models;

  return (
    <View testID="settings-section" class="gap-6">
      <View class="flex-row items-center gap-3">
        <Text class="flex-1 text-xs text-muted-foreground">
          {ready() ? "Device status and settings as the Host reports them." : "Settings load once the Host runs."}
        </Text>
        <Button
          testID="settings-refresh"
          variant="outline"
          size="sm"
          loading={device.loading() || settings.loading() || saving()}
          disabled={!ready()}
          onPress={() => refreshes.update((n) => n + 1)}
        >
          Refresh
        </Button>
      </View>

      <Card>
        <CardHeader>
          <CardTitle>Device</CardTitle>
          <CardDescription>The daemon's status, its runtimes and the SDK doctor.</CardDescription>
        </CardHeader>
        <CardContent>
          <If when={deviceFailure()}>
            {(message) => (
              <View testID="settings-device-error" role="alert">
                <Text class="text-xs text-destructive">{`Device unavailable: ${message()}`}</Text>
              </View>
            )}
          </If>
          <If when={deviceFailure() === null ? device() : undefined}>
            {(view) => <DevicePanel device={view()} />}
          </If>
          <If when={ready() && device() === undefined && deviceFailure() === null}>
            <Spinner label="Checking device status…" />
          </If>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Dreaming</CardTitle>
          <CardDescription>Applies when the Host next starts.</CardDescription>
        </CardHeader>
        <CardContent>
          <If when={settingsFailure()}>
            {(message) => (
              <View testID="settings-dreaming-load-error" role="alert">
                <Text class="text-xs text-destructive">{`Settings unavailable: ${message()}`}</Text>
              </View>
            )}
          </If>
          <If when={modelsFailure()}>
            {(message) => (
              <View testID="settings-models-error" role="alert">
                <Text class="text-xs text-destructive">{`Models unavailable: ${message()}`}</Text>
              </View>
            )}
          </If>
          <If when={models()}>
            {(choices) => (
              <If when={loadedSettings()}>
                {(loaded) => (
                  <Each of={[loaded()]} key={(entry) => entry.load}>
                    {(entry) => (
                      <DreamingForm
                        saved={() => entry().dreaming}
                        models={choices()}
                        save={save}
                        onSaved={(dreaming) => settings.mutate({ load: entry().load, dreaming })}
                      />
                    )}
                  </Each>
                )}
              </If>
            )}
          </If>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Startup &amp; System</CardTitle>
          <CardDescription>
            OS-authoritative login-item preference synced directly with desktop services.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LoginItemControl />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Diagnostics</CardTitle>
          <CardDescription>Export a redacted snapshot of supervised Host logs and S1 store state.</CardDescription>
        </CardHeader>
        <CardContent>
          <DiagnosticsExportButton testID="settings-diagnostics-btn" disabled={isQuitting() || !ready()} />
          <If when={!ready()}>
            <Text testID="settings-diagnostics-note" class="text-xs text-muted-foreground">
              Start or restart the Host to export diagnostics.
            </Text>
          </If>
        </CardContent>
      </Card>
    </View>
  );
}
