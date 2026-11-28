import { t } from "../../i18n.ts";
import { computed, resource, signal, Text, View } from "nsh";
import { bridgeErrorText } from "../../statusCopy.ts";
import {
  dreamingSaveSettled,
  dreamingSaving,
  hostReady,
  isQuitting,
  k8View,
  readDevice,
  readHostSettings,
  saveDreaming,
} from "../../store.ts";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Spinner } from "../../ui/index.ts";
import { LoginItemControl } from "../shell/LoginItemControl.tsx";
import { DiagnosticsExportButton } from "../shell/RecoveryPanel.tsx";
import { AgentsPanel } from "./AgentsPanel.tsx";
import { DevicePanel } from "./DevicePanel.tsx";
import { DreamingForm } from "./DreamingForm.tsx";
import { LanguageSetting } from "./LanguageSetting.tsx";

const failureText = (error: unknown) => (error === undefined ? null : bridgeErrorText(error));

/**
 * Device, runtimes, clock skew and doctor, then dreaming, login item and diagnostics export. The section reads
 * `settings.device` and `settings.get` when it shows and on Refresh, never on a Host hint; the resources keep only the
 * latest read and drop it when the section unmounts. The dreaming models come from the store's shared `k8View`.
 */
export function SettingsScreen(props: { languageLoadFailed?: boolean }) {
  const refreshes = signal(0);
  const deviceReads = signal(0);
  // Consumed once by the read triggered by t("common.checkAgain"), so a Host restart while mounted gets the default read.
  let pendingCheckAuth = false;
  const activeCheckAuth = signal(false);
  const ready = computed(() => hostReady());
  const device = resource(
    () => (ready() ? deviceReads() : false),
    async () => {
      const checkAuth = pendingCheckAuth;
      pendingCheckAuth = false;
      activeCheckAuth.set(checkAuth);
      return await readDevice(checkAuth ? { checkAuth: true } : undefined);
    },
  );
  const checkingAuth = computed(() => device.loading() && activeCheckAuth());
  // `load` names the read: a new one mounts a new dreaming form from it, a save keeps the form (`mutate`, same load).
  // A read waits for a running save (also one started before a section switch remounted this screen), so it never
  // mounts the form on the value before the save; Refresh stays disabled meanwhile. A read whose screen went away or
  // was superseded while it waited sends nothing.
  const settings = resource(
    () => (ready() ? refreshes() : false),
    async (load, info) => {
      await dreamingSaveSettled();
      info.signal.throwIfAborted();
      return { load, dreaming: (await readHostSettings()).dreaming };
    },
  );
  const deviceFailure = () => failureText(device.error());
  const settingsFailure = () => failureText(settings.error());
  const modelsFailure = () => failureText(k8View.error());
  const loadedSettings = () => (settingsFailure() === null ? settings() : undefined);
  const models = () => k8View()?.models;

  return (
    <View testID="settings-section" class="gap-6">
      <LanguageSetting loadFailed={props.languageLoadFailed ?? false} />
      <View class="flex-row items-center gap-3">
        <Text class="flex-1 text-xs text-muted-foreground">
          {ready() ? t("settings.ready") : t("settings.wait")}
        </Text>
        <Button
          testID="settings-refresh"
          variant="outline"
          size="sm"
          loading={device.loading() || settings.loading() || dreamingSaving()}
          disabled={!ready()}
          onPress={() => {
            pendingCheckAuth = false;
            refreshes.update((n) => n + 1);
            deviceReads.update((n) => n + 1);
          }}
        >
          {t("common.refresh")}
        </Button>
      </View>

      <Card testID="settings-agents-card">
        <CardHeader>
          <View class="flex-row items-center gap-3">
            <View class="flex-1 min-w-0 gap-1">
              <CardTitle>{t("settings.agents")}</CardTitle>
              <CardDescription>{t("settings.agentsDescription")}</CardDescription>
            </View>
            <Button
              testID="settings-agents-check-again"
              variant="outline"
              size="sm"
              loading={checkingAuth()}
              disabled={!ready() || device.loading()}
              onPress={() => {
                if (!ready()) return;
                pendingCheckAuth = true;
                deviceReads.update((n) => n + 1);
              }}
            >
              {t("common.checkAgain")}
            </Button>
          </View>
        </CardHeader>
        <CardContent>
          <If when={deviceFailure()}>
            {(message) => (
              <View testID="settings-agents-error" role="alert">
                <Text class="text-xs text-destructive">{t("settings.agentsError", { error: message() })}</Text>
              </View>
            )}
          </If>
          <If when={deviceFailure() === null ? device() : undefined}>
            {(view) => <AgentsPanel runtimes={view().runtimes} />}
          </If>
          <If when={ready() && device() === undefined && deviceFailure() === null}>
            <Spinner label={t("settings.agentsLoading")} />
          </If>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("settings.device")}</CardTitle>
          <CardDescription>{t("settings.deviceDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <If when={deviceFailure()}>
            {(message) => (
              <View testID="settings-device-error" role="alert">
                <Text class="text-xs text-destructive">{t("settings.deviceError", { error: message() })}</Text>
              </View>
            )}
          </If>
          <If when={deviceFailure() === null ? device() : undefined}>
            {(view) => <DevicePanel device={view()} />}
          </If>
          <If when={ready() && device() === undefined && deviceFailure() === null}>
            <Spinner label={t("settings.deviceLoading")} />
          </If>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("settings.dreaming")}</CardTitle>
          <CardDescription>{t("settings.dreamingDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <If when={settingsFailure()}>
            {(message) => (
              <View testID="settings-dreaming-load-error" role="alert">
                <Text class="text-xs text-destructive">{t("settings.settingsError", { error: message() })}</Text>
              </View>
            )}
          </If>
          <If when={modelsFailure()}>
            {(message) => (
              <View testID="settings-models-error" role="alert">
                <Text class="text-xs text-destructive">{t("settings.modelsError", { error: message() })}</Text>
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
                        reading={settings.loading()}
                        save={saveDreaming}
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
          <CardTitle>{t("settings.startup")}</CardTitle>
          <CardDescription>
            {t("settings.startupDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LoginItemControl />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("settings.diagnostics")}</CardTitle>
          <CardDescription>{t("settings.diagnosticsDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <DiagnosticsExportButton testID="settings-diagnostics-btn" disabled={isQuitting() || !ready()} />
          <If when={!ready()}>
            <Text testID="settings-diagnostics-note" class="text-xs text-muted-foreground">
              {t("settings.diagnosticsOffline")}
            </Text>
          </If>
        </CardContent>
      </Card>
    </View>
  );
}
