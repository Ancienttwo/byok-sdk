import { t } from "../../i18n.ts";
import { computed, resource, signal, Text, View } from "nsh";
import type { ModelChoice } from "../../../../src/host/conversation/catalog.ts";
import type { BotProfile } from "../../../../src/host/store/types.ts";
import { bridgeErrorText } from "../../statusCopy.ts";
import { archiveBot, hostReady, readDevice, saveBot, setActiveSection } from "../../store.ts";
import { Badge, Button, Card, Dialog, Field, Input, Select, Spinner, Tab, Tabs, Textarea } from "../../ui/index.ts";
import { runtimeSignInGuidance } from "../settings/runtimeStatus.ts";
import { choiceAvailability } from "./availability.ts";
import { BotMemoryPanel } from "./BotMemoryPanel.tsx";
import { createCommand } from "./command.ts";

export interface ProfileEditorProps {
  initial: BotProfile;
  creating: boolean;
  /** Every model the Host offers; the picker marks each with its runtime's availability. */
  models: readonly ModelChoice[];
  /** The saved or archived Bot's id; undefined when closed without a change. */
  onDone: (saved: string | undefined) => void;
}

/**
 * Creates or edits a Bot. The id comes with `initial` and stays, so a retried Save is the same command to the Host.
 * Archive is irreversible (K8 never takes an archived Bot back), so it asks once more and says so; the Bot's home and
 * transcript stay. An existing Bot also shows its memory in a Memory tab; a new Bot has no home yet.
 *
 * The picker reads `settings.device` when the editor opens and on Check again (`checkAuth`). A new Bot or a re-pointed
 * one takes only a selectable model, and a new Bot starts on the first one; an existing Bot keeps its model while its
 * runtime is unavailable and shows why.
 */
export function ProfileEditor(props: ProfileEditorProps) {
  const profile = signal<BotProfile>(props.initial);
  const tab = signal<"profile" | "memory">("profile");
  const confirmArchive = signal(false);
  const command = createCommand();
  const edit = (patch: Partial<BotProfile>) => profile.update((current) => ({ ...current, ...patch }));
  const deviceReads = signal(0);
  // Consumed once by the read that Check again triggers.
  let pendingCheckAuth = false;
  const device = resource(
    () => (hostReady() ? deviceReads() : false),
    async () => {
      const checkAuth = pendingCheckAuth;
      pendingCheckAuth = false;
      const view = await readDevice(checkAuth ? { checkAuth: true } : undefined);
      const first = props.models.find((model) => choiceAvailability(model, view.runtimes).selectable);
      if (props.creating && profile().model === "" && first !== undefined) {
        edit({ model: first.id });
      }
      return view;
    },
  );
  const checkAgain = () => {
    pendingCheckAuth = true;
    deviceReads.update((n) => n + 1);
  };
  const deviceFailure = () => {
    const error = device.error();
    return error === undefined ? null : bridgeErrorText(error);
  };
  const availability = (model: ModelChoice) => choiceAvailability(model, device()?.runtimes);
  const selected = () => props.models.find((model) => model.id === profile().model);
  const noneSelectable = computed(
    () => device() !== undefined && !props.models.some((model) => availability(model).selectable),
  );
  // The selected model's status when it is not plainly ready: why it cannot run, or that it needs a sign-in.
  const selectedNotice = () => {
    const model = selected();
    if (model === undefined || device() === undefined) {
      return undefined;
    }
    const { status, selectable } = availability(model);
    return status === null || (selectable && status.key !== "signed-out") ? undefined : { model, status };
  };
  const signInNote = (runtime: string) => {
    const guidance = runtimeSignInGuidance(runtime);
    return guidance.kind === "command" ? t("common.fact", { label: guidance.command, value: guidance.note }) : guidance.note;
  };
  const complete = () => {
    const current = profile();
    if (current.name === "" || current.role === "" || current.persona === "" || current.model === "") {
      return false;
    }
    // An existing Bot keeps its model whatever its runtime's state; a new or changed one needs a selectable model.
    const model = selected();
    return (!props.creating && current.model === props.initial.model) || (model !== undefined && availability(model).selectable);
  };
  const save = async () => {
    const current = profile();
    if (await command.run(() => saveBot(current))) {
      props.onDone(current.id);
    }
  };
  const archive = async () => {
    const id = profile().id;
    if (await command.run(() => archiveBot(id))) {
      confirmArchive.set(false);
      props.onDone(id);
    }
  };
  return (
    <Card>
      <View testID="conv-profile" class="gap-4">
        <Text role="header" accessibilityLevel={2} class="text-base font-semibold text-foreground">
          {props.creating ? t("profile.new") : t("conversation.edit")}
        </Text>
        <If when={!props.creating}>
          <Tabs testID="conv-profile-tabs" accessibilityLabel={t("profile.sheet")} class="self-start">
            <Tab testID="conv-profile-tab-profile" selected={tab() === "profile"} onPress={() => tab.set("profile")}>
              {t("profile.profile")}
            </Tab>
            <Tab testID="conv-profile-tab-memory" selected={tab() === "memory"} onPress={() => tab.set("memory")}>
              {t("profile.memory")}
            </Tab>
          </Tabs>
        </If>
        <If
          when={tab() === "profile"}
          else={
            <View class="gap-4">
              <BotMemoryPanel botId={props.initial.id} />
              <View class="flex-row flex-wrap items-center gap-2">
                <Button testID="conv-profile-close" variant="outline" onPress={() => props.onDone(undefined)}>
                  {t("common.close")}
                </Button>
              </View>
            </View>
          }
        >
          <View class="gap-4">
            <Field label={t("profile.name")} required>
              <Input
                testID="conv-profile-name"
                accessibilityLabel={t("profile.name")}
                value={profile().name}
                onChange={(e) => edit({ name: e.value })}
              />
            </Field>
            <Field label={t("profile.role")} required>
              <Input
                testID="conv-profile-role"
                accessibilityLabel={t("profile.role")}
                value={profile().role}
                onChange={(e) => edit({ role: e.value })}
              />
            </Field>
            <Field label={t("profile.persona")} required>
              <Textarea
                testID="conv-profile-persona"
                accessibilityLabel={t("profile.persona")}
                value={profile().persona}
                onChange={(e) => edit({ persona: e.value })}
              />
            </Field>
            <Field label={t("profile.model")} required>
              <View class="gap-2">
                <View class="flex-row flex-wrap items-center gap-2">
                  <View class="flex-1">
                    <Select
                      testID="conv-profile-model"
                      accessibilityLabel={t("profile.model")}
                      items={props.models.map((model) => {
                        const state = availability(model);
                        return {
                          value: model.id,
                          title: state.status === null ? model.label : `${model.label} · ${state.status.symbol} ${state.status.label}`,
                          disabled: !state.selectable,
                        };
                      })}
                      value={profile().model}
                      onChange={(value) => {
                        if (value !== null) {
                          edit({ model: value });
                        }
                      }}
                    />
                  </View>
                  <Button
                    testID="conv-profile-check-again"
                    variant="outline"
                    size="sm"
                    loading={device.loading()}
                    disabled={!hostReady() || device.loading()}
                    onPress={checkAgain}
                  >
                    {t("common.checkAgain")}
                  </Button>
                </View>
                <If when={device() === undefined && deviceFailure() === null}>
                  <View class="flex-row flex-wrap items-center gap-2" accessibilityState={{ busy: true }}>
                    <Spinner />
                    <Text class="text-xs text-muted-foreground">{t("settings.agentsLoading")}</Text>
                  </View>
                </If>
                <If when={deviceFailure()}>
                  {(message) => (
                    <View role="alert" testID="conv-profile-agents-error">
                      <Text class="text-xs text-destructive">{t("settings.agentsError", { error: message() })}</Text>
                    </View>
                  )}
                </If>
                <If when={selectedNotice()}>
                  {(notice) => (
                    <View testID="conv-profile-model-status" class="gap-1">
                      <View class="flex-row flex-wrap items-center gap-2">
                        <Text class="text-xs text-foreground">{notice().model.label}</Text>
                        <Badge
                          testID="conv-profile-model-status-badge"
                          variant={notice().status.variant}
                          symbol={notice().status.symbol}
                          label={notice().status.label}
                        />
                      </View>
                      <If when={notice().status.key === "signed-out"}>
                        <Text testID="conv-profile-model-signin" class="text-xs text-muted-foreground">
                          {signInNote(notice().model.runtime)}
                        </Text>
                      </If>
                    </View>
                  )}
                </If>
                <If when={noneSelectable()}>
                  <View testID="conv-profile-no-agent" class="flex-row flex-wrap items-center gap-2">
                    <Text class="flex-1 text-xs text-muted-foreground">{t("profile.noAgent")}</Text>
                    <Button testID="conv-profile-setup-pi" variant="outline" size="sm" onPress={() => setActiveSection("keys")}>
                      {t("profile.setupPi")}
                    </Button>
                  </View>
                </If>
              </View>
            </Field>
            <If when={command.error() !== null && !confirmArchive()}>
              <View role="alert" testID="conv-profile-error">
                <Text class="text-xs text-destructive">{command.error()}</Text>
              </View>
            </If>
            <View class="flex-row flex-wrap items-center gap-2">
              <Button
                testID="conv-profile-save"
                loading={command.busy() && !confirmArchive()}
                disabled={command.busy() || !complete()}
                onPress={() => void save()}
              >
                {t("common.save")}
              </Button>
              <Button
                testID="conv-profile-close"
                variant="outline"
                disabled={command.busy()}
                onPress={() => props.onDone(undefined)}
              >
                {t("common.close")}
              </Button>
              <If when={!props.creating}>
                <Button
                  testID="conv-profile-archive"
                  variant="danger"
                  disabled={command.busy()}
                  onPress={() => confirmArchive.set(true)}
                >
                  {t("profile.archiveAction")}
                </Button>
              </If>
            </View>
          </View>
        </If>
      </View>
      <Dialog
        testID="conv-archive-dialog"
        role="alertdialog"
        open={confirmArchive()}
        title={t("profile.archive")}
        description={t("profile.archiveDescription")}
        onOpenChange={(open) => {
          if (!command.busy()) {
            confirmArchive.set(open);
          }
        }}
        footer={
          <View class="flex-row flex-wrap items-center gap-2">
            <Button
              testID="conv-archive-keep"
              variant="outline"
              disabled={command.busy()}
              onPress={() => confirmArchive.set(false)}
            >
              {t("profile.keep")}
            </Button>
            <Button
              testID="conv-archive-confirm"
              variant="danger"
              loading={command.busy()}
              disabled={command.busy()}
              onPress={() => void archive()}
            >
              {t("profile.archivePermanently")}
            </Button>
          </View>
        }
      >
        <If when={command.error()}>
          <View role="alert" testID="conv-archive-error">
            <Text class="text-xs text-destructive">{command.error()}</Text>
          </View>
        </If>
      </Dialog>
    </Card>
  );
}
