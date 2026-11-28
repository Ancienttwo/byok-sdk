import { rolePreset } from "../../../../brand.config.ts";
import { appLocale, t } from "../../i18n.ts";
import { batch, cleanup, computed, resource, signal, Text, View } from "nsh";
import type { ModelChoice } from "../../../../src/host/conversation/catalog.ts";
import type { RuntimeView } from "../../../../src/host/settings/types.ts";
import type { BotProfile } from "../../../../src/host/store/types.ts";
import { bridgeErrorText } from "../../statusCopy.ts";
import {
  dismissOnboarding,
  hostReady,
  k8View,
  readDevice,
  reloadK8View,
  saveBot,
  selectBot,
  setActiveSection,
} from "../../store.ts";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  ListItem,
  Separator,
  Spinner,
  Surface,
} from "../../ui/index.ts";
import { choiceAvailability } from "../conversation/availability.ts";
import { createCommand } from "../conversation/command.ts";
import { runtimeOutcomeText, runtimeSignInGuidance, runtimeStatus, type RuntimeStatusMeta } from "../settings/runtimeStatus.ts";

export interface OnboardingCliEntry {
  readonly choice: ModelChoice;
  readonly runtime: RuntimeView;
  readonly status: RuntimeStatusMeta;
  readonly selectable: boolean;
}

/**
 * Projects detected non-Pi CLI models in `#2546` catalog order for first-run onboarding:
 * - omits Pi (offered via the dedicated t("onboarding.piWithKey") action) and key-profile entries
 * - omits not-installed and unreported runtimes
 * - disables signed-out, version-blocked, check-timed-out, and can't-run entries
 */
export function buildOnboardingCliEntries(
  models: readonly ModelChoice[],
  runtimes: readonly RuntimeView[],
): readonly OnboardingCliEntry[] {
  const entries: OnboardingCliEntry[] = [];
  for (const choice of models) {
    if (choice.keyProfile || choice.runtime === "pi") {
      continue;
    }
    const runtime = runtimes.find((view) => view.id === choice.runtime);
    if (runtime === undefined || runtime.outcome === "not-found") {
      continue;
    }
    const status = runtimeStatus(runtime);
    // ProfileEditor (#2546) allows picking signed-out models with guidance; first-run onboarding disables them.
    const selectable = choiceAvailability(choice, runtimes).selectable && status.key !== "signed-out";
    entries.push({ choice, runtime, status, selectable });
  }
  return entries;
}

function signInCommandFor(runtimeId: string): string | undefined {
  const guidance = runtimeSignInGuidance(runtimeId);
  return guidance.kind === "command" ? guidance.command : undefined;
}

function statusDetailText(entry: OnboardingCliEntry): string | null {
  const { runtime, status } = entry;
  if (status.key === "version-blocked") {
    return t("runtime.blocked");
  }
  if (status.key === "check-timed-out") {
    return t("runtime.signInTimedOut");
  }
  if (status.key === "cant-run") {
    return runtimeOutcomeText(runtime);
  }
  if (status.key === "untested-version" && runtime.qualifiedVersion !== undefined) {
    return t("runtime.qualified", { version: runtime.qualifiedVersion });
  }
  return null;
}

/**
 * First-run agent picker: reads detected local CLIs from `settings.device`, lets the user continue
 * with a ready CLI (creating their first Bot via `k8.saveBot`) or choose t("onboarding.piWithKey")
 * to configure a BYOK provider profile in Keys.
 */
export function OnboardingScreen() {
  // Stable across retries so a retried Continue after a transient refusal never creates a duplicate Bot.
  const botId = crypto.randomUUID();
  const preferredModelId = signal<string | null>(null);
  const saveCommand = createCommand();
  let mounted = true;
  cleanup(() => {
    mounted = false;
  });

  const deviceReads = signal(0);
  // Consumed once by the read that t("common.checkAgain") triggers, so a Host restart while mounted gets the default read.
  let pendingCheckAuth = false;
  const activeCheckAuth = signal(false);
  const device = resource(
    () => (hostReady() ? deviceReads() : false),
    async () => {
      const checkAuth = pendingCheckAuth;
      pendingCheckAuth = false;
      activeCheckAuth.set(checkAuth);
      return await readDevice(checkAuth ? { checkAuth: true } : undefined);
    },
  );
  const checkingAuth = computed(() => device.loading() && activeCheckAuth());
  const deviceFailure = () => {
    const error = device.error();
    return error === undefined ? null : bridgeErrorText(error);
  };
  const checkAgain = () => {
    if (!hostReady() || device.loading()) {
      return;
    }
    pendingCheckAuth = true;
    deviceReads.update((n) => n + 1);
  };

  const cliEntries = computed<readonly OnboardingCliEntry[]>(() => {
    const currentDevice = device();
    const models = k8View()?.models;
    if (currentDevice === undefined || models === undefined) {
      return [];
    }
    return buildOnboardingCliEntries(models, currentDevice.runtimes);
  });

  // Auto-selects the first selectable CLI on load and re-aligns after t("common.checkAgain") if the chosen one became unavailable.
  const selectedEntry = computed<OnboardingCliEntry | undefined>(() => {
    const entries = cliEntries();
    const preferred = preferredModelId();
    if (preferred !== null) {
      const match = entries.find((entry) => entry.choice.id === preferred && entry.selectable);
      if (match !== undefined) {
        return match;
      }
    }
    return entries.find((entry) => entry.selectable);
  });

  const zeroSelectable = computed(() => device() !== undefined && selectedEntry() === undefined);

  const handleContinue = async () => {
    const selected = selectedEntry();
    if (selected === undefined || device.loading() || saveCommand.busy()) {
      return;
    }
    const roleId = k8View()?.roles[0]?.id;
    const preset = roleId === undefined ? undefined : rolePreset(roleId, appLocale());
    const profile: BotProfile = {
      id: botId,
      name: preset?.label ?? selected.choice.label,
      role: preset?.role ?? t("onboarding.fallbackRole"),
      persona: preset?.persona ?? t("onboarding.fallbackPersona"),
      model: selected.choice.id,
    };
    if (await saveCommand.run(() => saveBot(profile))) {
      if (!mounted) {
        reloadK8View();
        return;
      }
      batch(() => {
        selectBot(profile.id);
        reloadK8View();
        dismissOnboarding();
        setActiveSection("conversation");
      });
    }
  };

  const handlePiWithOwnKey = () => {
    batch(() => {
      dismissOnboarding();
      setActiveSection("keys");
    });
  };

  return (
    <View testID="onboarding-screen" class="gap-6">
      <Card testID="onboarding-cli-card">
        <CardHeader>
          <View class="flex-row items-center gap-3">
            <View class="flex-1 min-w-0 gap-1">
              <CardTitle>{t("onboarding.title")}</CardTitle>
              <CardDescription>
                {t("onboarding.description")}
              </CardDescription>
            </View>
            <Button
              testID="onboarding-check-again"
              variant="outline"
              size="sm"
              loading={checkingAuth()}
              disabled={!hostReady() || device.loading() || saveCommand.busy()}
              onPress={checkAgain}
            >
              {t("common.checkAgain")}
            </Button>
          </View>
        </CardHeader>

        <CardContent>
          <If when={device() === undefined && deviceFailure() === null}>
            <View testID="onboarding-loading" class="py-4">
              <Spinner label={t("onboarding.checking")} />
            </View>
          </If>

          <If when={deviceFailure()}>
            {(message) => (
              <View role="alert" testID="onboarding-device-error">
                <Text class="text-xs text-destructive">{t("onboarding.checkError", { error: message() })}</Text>
              </View>
            )}
          </If>

          <If when={device() !== undefined}>
            <View class="gap-3">
              <If when={cliEntries().length > 0}>
                <View role="list" accessibilityLabel={t("onboarding.detected")} testID="onboarding-cli-list" class="gap-1">
                  <Each of={cliEntries()} key={(entry) => entry.choice.id}>
                    {(entry, index) => (
                      <View testID={`onboarding-cli-row-${entry().choice.id}`} class="gap-2">
                        <If when={index() > 0}>
                          <Separator />
                        </If>
                        <ListItem
                          testID={`onboarding-cli-${entry().choice.id}`}
                          title={entry().choice.label}
                          description={entry().runtime.version ? `v${entry().runtime.version}` : undefined}
                          selected={selectedEntry()?.choice.id === entry().choice.id}
                          disabled={!entry().selectable}
                          accessibilityLabel={`${entry().choice.label}, ${entry().status.label}`}
                          trailing={
                            <Badge
                              testID={`onboarding-cli-${entry().choice.id}-status`}
                              variant={entry().status.variant}
                              symbol={entry().status.symbol}
                              label={entry().status.label}
                            />
                          }
                          onPress={() => {
                            if (entry().selectable && !saveCommand.busy()) {
                              preferredModelId.set(entry().choice.id);
                            }
                          }}
                        />

                        <If when={entry().status.key === "signed-out"}>
                          <View testID={`onboarding-cli-${entry().choice.id}-signin`} class="gap-1.5 pl-3 pb-1">
                            <If when={signInCommandFor(entry().choice.runtime)}>
                              {(cmd) => (
                                <Surface tone="muted" class="px-2.5 py-1.5 rounded-md self-start">
                                  <View selectable>
                                    <Text
                                      testID={`onboarding-cli-${entry().choice.id}-signin-cmd`}
                                      class="font-mono text-xs text-foreground"
                                    >
                                      {cmd()}
                                    </Text>
                                  </View>
                                </Surface>
                              )}
                            </If>
                            <Text
                              testID={`onboarding-cli-${entry().choice.id}-signin-note`}
                              class="text-xs text-muted-foreground"
                            >
                              {runtimeSignInGuidance(entry().choice.runtime).note}
                            </Text>
                          </View>
                        </If>

                        <If when={statusDetailText(entry())}>
                          {(detail) => (
                            <Text
                              testID={`onboarding-cli-${entry().choice.id}-detail`}
                              class={
                                entry().status.key === "version-blocked"
                                  ? "text-xs text-destructive pl-3 pb-1"
                                  : entry().status.key === "untested-version"
                                    ? "text-xs text-warning pl-3 pb-1"
                                    : "text-xs text-muted-foreground pl-3 pb-1"
                              }
                            >
                              {detail()}
                            </Text>
                          )}
                        </If>
                      </View>
                    )}
                  </Each>
                </View>
              </If>

              <If when={zeroSelectable()}>
                <Surface tone="muted" testID="onboarding-no-selectable" class="px-3 py-2.5">
                  <Text class="text-xs text-muted-foreground">
                    {cliEntries().length === 0
                      ? t("onboarding.noneInstalled")
                      : t("onboarding.noneReady")}
                  </Text>
                </Surface>
              </If>
            </View>
          </If>

          <If when={saveCommand.error()}>
            {(message) => (
              <View role="alert" testID="onboarding-save-error">
                <Text class="text-xs text-destructive">{message()}</Text>
              </View>
            )}
          </If>
        </CardContent>

        <CardFooter>
          <Button
            testID="onboarding-continue"
            loading={saveCommand.busy()}
            disabled={!hostReady() || device.loading() || saveCommand.busy() || selectedEntry() === undefined}
            onPress={() => void handleContinue()}
          >
            {t("onboarding.continue")}
          </Button>
        </CardFooter>
      </Card>

      <Card testID="onboarding-pi-card">
        <CardHeader>
          <CardTitle>{t("onboarding.piWithKey")}</CardTitle>
          <CardDescription>
            {t("onboarding.piDescription")}
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button
            testID="onboarding-pi-key"
            variant="outline"
            disabled={saveCommand.busy()}
            onPress={handlePiWithOwnKey}
          >
            {t("onboarding.piWithKey")}
          </Button>
        </CardFooter>
      </Card>
    </View>
  );
}
