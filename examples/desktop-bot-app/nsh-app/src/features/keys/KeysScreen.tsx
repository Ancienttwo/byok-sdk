import { t } from "../../i18n.ts";
import { errorText } from "../../statusCopy.ts";
import type { ProviderStatus } from "@byok-sdk/keys";
import {
  applyModelRouteChange,
  createModelRouteDraft,
  modelRouteContext,
  modelRouteView,
  type ModelRouteChange,
  type ModelRouteContext,
  type ModelRouteDraft,

  type ModelRouteFieldError,
  type ModelRouteFieldView,
  type ModelRouteModelChoice,
  type PiModelApi,
  type ProviderModelCapability,
} from "@byok-sdk/keys/model-route";
import { effect, signal, Text, untracked, View } from "nsh";
import {
  refusalOf,
  runLocked,
  storedProfile,
  submitModelRoute,
  submitReplaceSecret,
  type Refusal,
  type SubmitOutcome,
} from "../../../../src/keys/submit.ts";
import { bridge } from "../../bridge.ts";
import { k8View, shellStart, startShell } from "../../store.ts";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  Empty,
  Field,
  Input,
  ListItem,
  Select,
  Spinner,
  Textarea,
  type ToastNotice,
} from "../../ui/index.ts";

const CHOICE_KEYS: Readonly<Record<string, string>> = {
  "custom": "keys.choice.custom",
  "openai_compatible": "keys.choice.openai_compatible",
  "anthropic": "keys.choice.anthropic",
  "bearer": "keys.choice.bearer",
  "x_api_key": "keys.choice.x_api_key",
  "none": "keys.choice.none",
  "off": "keys.choice.off",
  "minimal": "keys.choice.minimal",
  "low": "keys.choice.low",
  "medium": "keys.choice.medium",
  "high": "keys.choice.high",
  "xhigh": "keys.choice.xhigh",
  "max": "keys.choice.max",
  "image-input": "keys.choice.image-input",
};

function choiceTitle(choice: { value: string; label?: string | null }): string {
  return Object.hasOwn(CHOICE_KEYS, choice.value) ? t(CHOICE_KEYS[choice.value]!) : choice.label ?? choice.value;
}

const CLEAR_CHOICE_VALUE = "__clear__";
const MANUAL_MODEL_OPTION = "__manual__";

type Listed =
  | { readonly statuses: readonly ProviderStatus[]; readonly refusal?: undefined }
  | { readonly statuses?: undefined; readonly refusal: Refusal };

function formatFieldError(error: ModelRouteFieldError | null): string | null {
  if (error === null) {
    return null;
  }
  const message = t(`keys.error.${error.code}`);
  return error.paths?.length ? t("keys.errorPaths", { error: message, paths: error.paths.join(", ") }) : message;
}

function formatPiModelInitial(draft: ModelRouteDraft): string {
  if (draft.pi_model === null || draft.pi_model === undefined) {
    return "";
  }
  return JSON.stringify(draft.pi_model, null, 2);
}

function modelChoiceKey(value: string, api: PiModelApi): string {
  return `${api} ${value}`;
}

function buildContext(stored: ProviderStatus | null): ModelRouteContext {
  return modelRouteContext({
    stored: stored === null ? null : storedProfile(stored),
  });
}

function RefusalBanner(props: { testID: string; refusal: Refusal }) {
  const text = () => errorText(props.refusal.code);
  return (
    <View
      testID={props.testID}
      role="alert"
      accessible
      accessibilityLabel={text()}
      class="p-3 rounded-(--radius) border border-destructive bg-card gap-1"
    >
      <View class="flex-row items-center gap-2">
        <Badge variant="danger" symbol="!" label={t("keys.refused")} />
        <Text class="text-xs text-destructive flex-1">{text()}</Text>
      </View>
    </View>
  );
}

function ReceiptCard(props: { status: ProviderStatus }) {
  return (
    <View
      testID="keys-receipt"
      role="region"
      accessibilityLiveRegion="polite"
      accessible
      accessibilityLabel={t("keys.saved", { name: props.status.display_name })}
      class="p-3 rounded-(--radius) border border-success bg-card gap-2"
    >
      <View class="flex-row items-center justify-between gap-2">
        <Text class="flex-1 text-sm font-semibold text-foreground">
          {t("keys.saved", { name: props.status.display_name })}
        </Text>
        <Badge
          variant={props.status.secret_configured ? "success" : "neutral"}
          symbol={props.status.secret_configured ? "✓" : "○"}
          label={props.status.secret_configured ? t("keys.keyStored") : t("keys.noKey")}
        />
      </View>
      <View class="flex-row flex-wrap gap-x-6 gap-y-1">
        <Text class="text-xs font-mono text-muted-foreground">
          {t("keys.storedProfile", { ref: props.status.profile_ref })}
        </Text>
        <Text class="text-xs text-muted-foreground">
          {t("keys.storedProvider", { provider: props.status.provider_kind })}
        </Text>
        <Text class="text-xs font-mono text-muted-foreground">
          {t("keys.storedModel", { model: props.status.model })}
        </Text>
        <Text class="text-xs font-mono text-muted-foreground">
          {t("keys.storedRevision", { revision: props.status.profile_revision })}
        </Text>
      </View>
    </View>
  );
}

export interface KeysScreenProps {
  onNotify?: (tone: "info" | "success" | "warning" | "danger", title: ToastNotice["title"], description?: ToastNotice["description"]) => void;
}

/**
 * Keys management screen: stored provider list (`keys.list`), dynamic `@byok-sdk/keys/model-route`
 * provider form, stored-profile key replacement (`keys.submit` with ADR-052 D2 Option A pre-bridge
 * secret signal clearing), and the Host catalog model list (the store's shared `k8View`).
 */
export function KeysScreen(props: KeysScreenProps) {
  const initialContext = buildContext(null);
  const initialDraft = createModelRouteDraft(initialContext);

  const listed = signal<Listed | undefined>(undefined);
  const editing = signal<ProviderStatus | null>(null);
  const context = signal<ModelRouteContext>(initialContext);
  const draft = signal<ModelRouteDraft>(initialDraft);
  const piModelText = signal(formatPiModelInitial(initialDraft));
  const replaceSecret = signal("");
  const outcome = signal<SubmitOutcome | undefined>(undefined);
  // Single section lock shared across initial load, Save, Replace key, Reload, and post-receipt reload.
  const busy = signal(true);

  // After a failed Host start every keys.submit would refuse with host_exited; only Reload retries the start.
  const startFailed = () => shellStart().status === "failed";
  const view = () => modelRouteView(draft(), context());
  const visibleFields = () => view().fields.filter((field) => field.visible);
  const formTitle = () => {
    const s = editing();
    return s === null ? t("keys.addProvider") : t("keys.editProvider", { name: s.display_name });
  };
  const replaceableStored = (): ProviderStatus | null => {
    const s = editing();
    return s !== null && s.auth_mode !== "none" ? s : null;
  };
  const receiptOutcome = (): ProviderStatus | null => {
    const o = outcome();
    return o && "receipt" in o ? o.receipt : null;
  };
  const refusalOutcome = (): Refusal | null => {
    const o = outcome();
    return o && "refusal" in o ? o.refusal : null;
  };

  const resetFormToStored = (nextStored: ProviderStatus | null, clearOutcome: boolean) => {
    const nextContext = buildContext(nextStored);
    const nextDraft = createModelRouteDraft(nextContext);
    editing.set(nextStored);
    context.set(nextContext);
    draft.set(nextDraft);
    piModelText.set(formatPiModelInitial(nextDraft));
    replaceSecret.set("");
    if (clearOutcome) {
      outcome.set(undefined);
    }
  };

  const applyFieldChange = (change: ModelRouteChange) => {
    const next = applyModelRouteChange(draft(), change, context());
    draft.set(next);
    if (change.field !== "pi_model" && next.pi_model === null && piModelText() !== "") {
      piModelText.set("");
    }
  };

  const loadList = async () => {
    try {
      const statuses = await bridge.call("keys.list", undefined);
      listed.set({ statuses });
    } catch (error) {
      listed.set({ refusal: refusalOf(error) });
    }
  };

  const reload = async () => {
    busy.set(true);
    try {
      await loadList();
    } finally {
      busy.set(false);
    }
  };

  const onOutcome = (next: SubmitOutcome) => {
    outcome.set(next);
    if ("receipt" in next) {
      resetFormToStored(null, false);
      props.onNotify?.("success", () => t("keys.saved", { name: next.receipt.display_name }), () => t("keys.providerSaved"));
    } else {
      props.onNotify?.("warning", () => t("keys.providerRefused"), () => errorText(next.refusal.code));
    }
  };

  const run = (work: () => Promise<SubmitOutcome>) =>
    runLocked((next) => busy.set(next), work, onOutcome, loadList);

  const submitRoute = () => {
    const currentView = view();
    if (!currentView.valid || busy() || startFailed()) {
      return;
    }
    const snapshotDraft = draft();
    const snapshotContext = context();
    const snapshotStored = editing();
    void run(() =>
      submitModelRoute(
        snapshotDraft,
        snapshotContext,
        snapshotStored,
        (change) => bridge.call("keys.submit", change),
        (clearedDraft) => draft.set(clearedDraft),
      ),
    );
  };

  const submitReplace = () => {
    const stored = editing();
    const typed = replaceSecret();
    if (!stored || typed === "" || busy() || startFailed()) {
      return;
    }
    // ADR-052 D2 Option A: clear reactive signal synchronously BEFORE handing secret across the bridge.
    replaceSecret.set("");
    void run(() =>
      submitReplaceSecret(stored.profile_ref, typed, (change) =>
        bridge.call("keys.submit", change),
      ),
    );
  };

  // The first keys.list waits for the app-startup ByokShell.start; a failed start shows its coded
  // refusal, and only the Reload button tries the start again.
  effect(() => {
    const start = shellStart();
    untracked(() => {
      if (start.status === "started") {
        void reload();
      } else if (start.status === "failed") {
        listed.set({ refusal: refusalOf(start.error) });
        busy.set(false);
      } else {
        busy.set(true);
      }
    });
  });

  const onReload = () => {
    if (shellStart().status === "failed") {
      void startShell();
    } else {
      void reload();
    }
  };

  const k8ViewRefusal = (): Refusal | null => {
    const err = k8View.error();
    return err ? refusalOf(err) : null;
  };

  const fieldViewFor = (fieldName: ModelRouteFieldView["field"]): ModelRouteFieldView | undefined =>
    view().fields.find((entry) => entry.field === fieldName);

  const renderFieldControl = (fieldName: ModelRouteFieldView["field"]) => {
    const getField = () => fieldViewFor(fieldName);

    switch (fieldName) {
      case "profile_ref":
      case "display_name":
      case "base_url":
        return (
          <Input
            testID={`keys-field-${fieldName}`}
            value={draft()[fieldName]}
            disabled={busy()}
            invalid={Boolean(getField()?.error)}
            accessibilityLabel={t(`keys.field.${fieldName}`)}
            onChange={(e) => applyFieldChange({ field: fieldName, value: e.value })}
          />
        );
      case "provider_kind":
      case "adapter":
      case "auth_mode":
      case "thinking_level": {
        const items = () => [
          { value: CLEAR_CHOICE_VALUE, title: "—" },
          ...(getField()?.choices ?? []).map((choice) => ({
            value: choice.value,
            title: choiceTitle(choice),
          })),
        ];
        const selectedValue = () => {
          const val = getField()?.value;
          return typeof val === "string" ? val : CLEAR_CHOICE_VALUE;
        };
        return (
          <Select
            testID={`keys-field-${fieldName}`}
            items={items()}
            value={selectedValue()}
            disabled={busy()}
            accessibilityLabel={t(`keys.field.${fieldName}`)}
            onChange={(value) => {
              const next = value === null || value === CLEAR_CHOICE_VALUE ? null : value;
              applyFieldChange({ field: fieldName, value: next } as ModelRouteChange);
            }}
          />
        );
      }
      case "model": {
        const choices = () => (getField()?.choices ?? []) as readonly ModelRouteModelChoice[];
        const selectItems = () => [
          { value: MANUAL_MODEL_OPTION, title: t("keys.otherModel") },
          ...choices().map((choice) => ({
            value: modelChoiceKey(choice.value, choice.api),
            title: `${choice.label ?? choice.value} (${choice.api})`,
            disabled: choice.status !== "representable",
          })),
        ];
        const selectedKey = () => {
          const currentDraft = draft();
          const picked = choices().find(
            (choice) => choice.value === currentDraft.model && choice.api === currentDraft.model_api,
          );
          return picked ? modelChoiceKey(picked.value, picked.api) : MANUAL_MODEL_OPTION;
        };
        return (
          <View class="gap-2">
            <If when={choices().length > 0}>
              <Select
                testID="keys-field-model-select"
                items={selectItems()}
                value={selectedKey()}
                disabled={busy()}
                accessibilityLabel={t("keys.catalogModel")}
                onChange={(value) => {
                  const chosen = choices().find(
                    (choice) => modelChoiceKey(choice.value, choice.api) === value,
                  );
                  applyFieldChange(
                    chosen
                      ? { field: "model", value: chosen.value, api: chosen.api }
                      : { field: "model", value: "" },
                  );
                }}
              />
            </If>
            <Input
              testID="keys-field-model"
              value={draft().model}
              disabled={busy()}
              invalid={Boolean(getField()?.error)}
              accessibilityLabel={t("keys.field.model")}
              onChange={(e) => applyFieldChange({ field: "model", value: e.value })}
            />
          </View>
        );
      }
      case "pi_model":
        return (
          <Textarea
            testID="keys-field-pi_model"
            value={piModelText()}
            disabled={busy()}
            invalid={Boolean(getField()?.error)}
            accessibilityLabel={t("keys.field.pi_model")}
            placeholder='{"contextWindow": 131072, ...}'
            onChange={(e) => {
              piModelText.set(e.value);
              let parsed: unknown = e.value;
              try {
                parsed = JSON.parse(e.value);
              } catch {
                /* model-route reports pi_model_invalid on invalid JSON strings */
              }
              applyFieldChange({ field: "pi_model", value: parsed });
            }}
          />
        );
      case "capabilities": {
        const capValues = () => (getField()?.choices ?? []).map((choice) => choice.value);
        return (
          <View class="flex-row flex-wrap items-center gap-4">
            <Each of={capValues()} key={(cap) => cap}>
              {(cap) => {
                const capName = untracked(() => cap());
                return (
                  <Checkbox
                    testID={`keys-cap-${capName}`}
                    label={choiceTitle({ value: capName })}
                    disabled={busy()}
                    checked={draft().capabilities.includes(capName as ProviderModelCapability)}
                    onChange={(checked) => {
                      const currentCaps = draft().capabilities;
                      const value = checked
                        ? ([...currentCaps, capName as ProviderModelCapability] as readonly ProviderModelCapability[])
                        : currentCaps.filter((item) => item !== capName);
                      applyFieldChange({ field: "capabilities", value });
                    }}
                  />
                );
              }}
            </Each>
          </View>
        );
      }
      case "secret": {
        const typedSecret = () => {
          const sec = draft().secret;
          return typeof sec === "object" ? sec.replace : "";
        };
        return (
          <Input
            testID="keys-field-secret"
            variant="masked"
            value={typedSecret()}
            disabled={busy()}
            invalid={Boolean(getField()?.error)}
            placeholder="sk-..."
            accessibilityLabel={t("keys.field.secret")}
            onChange={(e) =>
              applyFieldChange({
                field: "secret",
                value: e.value === "" ? "none" : { replace: e.value },
              })
            }
            onSubmit={submitRoute}
          />
        );
      }
    }
  };

  return (
    <View testID="keys-screen" class="gap-6">
      {/* Stored Provider Profiles */}
      <Card>
        <CardHeader>
          <View testID="keys-stored-header" class="flex-row items-center justify-between gap-3">
            <View class="flex-1 min-w-0 gap-1">
              <CardTitle>{t("keys.stored")}</CardTitle>
              <CardDescription>
                {t("keys.storedDescription")}
              </CardDescription>
            </View>
            <View class="flex-row items-center gap-2">
              <Button
                testID="keys-new-btn"
                variant="secondary"
                size="sm"
                disabled={busy()}
                onPress={() => resetFormToStored(null, true)}
              >
                {t("keys.newProvider")}
              </Button>
              <Button
                testID="keys-reload-btn"
                variant="outline"
                size="sm"
                loading={busy()}
                onPress={onReload}
              >
                {t("keys.reload")}
              </Button>
            </View>
          </View>
        </CardHeader>
        <CardContent>
          <If when={listed() === undefined}>
            <Spinner label={t("keys.loading")} />
          </If>
          <If when={listed()?.refusal}>
            {(refusal) => <RefusalBanner testID="keys-list-refusal" refusal={refusal()} />}
          </If>
          <If when={listed()?.statuses}>
            {(statuses) => (
              <If
                when={statuses().length > 0}
                else={
                  <Empty
                    title={t("keys.empty")}
                    description={t("keys.emptyDescription")}
                  />
                }
              >
                <View class="gap-1.5">
                  <Each of={statuses()} key={(status) => status.profile_ref}>
                    {(status) => {
                      const isSelected = () => editing()?.profile_ref === status().profile_ref;
                      const keyLabel = () =>
                        status().auth_mode === "none"
                          ? t("keys.noKeyNeeded")
                          : status().secret_configured
                            ? t("keys.keyStoredShort")
                            : t("keys.noKeyStored");
                      return (
                        <ListItem
                          testID={`keys-stored-${status().profile_ref}`}
                          selected={isSelected()}
                          disabled={busy()}
                          title={`${status().display_name} (${status().profile_ref})`}
                          description={`${status().provider_kind} • ${status().model}`}
                          accessibilityLabel={`${status().display_name} (${status().profile_ref})`}
                          onPress={() => resetFormToStored(status(), true)}
                          trailing={
                            <View class="flex-row items-center gap-1.5">
                              <If when={status().configuration_pending}>
                                <Badge
                                  variant="warning"
                                  symbol="!"
                                  label={t("keys.pendingKey")}
                                />
                              </If>
                              <Badge
                                variant={status().secret_configured ? "success" : "neutral"}
                                symbol={status().secret_configured ? "✓" : "○"}
                                label={keyLabel()}
                              />
                            </View>
                          }
                        />
                      );
                    }}
                  </Each>
                </View>
              </If>
            )}
          </If>
        </CardContent>
      </Card>

      {/* Model Route Configuration Form */}
      <Card>
        <CardHeader>
          <CardTitle>{formTitle()}</CardTitle>
          <CardDescription>
            {t("keys.formDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Each of={visibleFields()} key={(field) => field.field}>
            {(field) => {
              // Capture invariant row field name once so draft() keystrokes update props in place
              // instead of remounting the native control and dropping keyboard focus.
              const fieldName = untracked(() => field().field);
              return (
                <Field
                  label={t(`keys.field.${fieldName}`)}
                  required={field().required}
                  error={formatFieldError(field().error)}
                >
                  {renderFieldControl(fieldName)}
                </Field>
              );
            }}
          </Each>
        </CardContent>
        <CardFooter class="justify-between">
          <Text class="text-xs text-muted-foreground">
            {view().secret_configured ? t("keys.secretRetained") : t("keys.secretNew")}
          </Text>
          <Button
            testID="keys-save-btn"
            variant="primary"
            loading={busy()}
            disabled={busy() || startFailed() || !view().valid}
            onPress={submitRoute}
          >
            {t("common.save")}
          </Button>
        </CardFooter>
      </Card>

      {/* Replace Key Form (stored profile with credential auth) */}
      <If when={replaceableStored()}>
        {(stored) => (
          <Card>
            <CardHeader>
              <CardTitle>{t("keys.replaceTitle", { name: stored().display_name })}</CardTitle>
              <CardDescription>
                {t("keys.replaceDescription")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Field label={t("keys.newKey")} required>
                <View class="flex-row items-center gap-2">
                  <View class="flex-1">
                    <Input
                      testID="keys-replace-secret"
                      variant="masked"
                      value={replaceSecret()}
                      disabled={busy()}
                      placeholder="sk-..."
                      accessibilityLabel={t("keys.newKey")}
                      onChange={(e) => replaceSecret.set(e.value)}
                      onSubmit={submitReplace}
                    />
                  </View>
                  <Button
                    testID="keys-replace-submit"
                    variant="secondary"
                    loading={busy()}
                    disabled={busy() || startFailed() || replaceSecret() === ""}
                    onPress={submitReplace}
                  >
                    {t("keys.replace")}
                  </Button>
                </View>
              </Field>
            </CardContent>
          </Card>
        )}
      </If>

      {/* Custody Submission Receipt or Refusal */}
      <If when={receiptOutcome()}>
        {(receipt) => <ReceiptCard status={receipt()} />}
      </If>
      <If when={refusalOutcome()}>
        {(refusal) => <RefusalBanner testID="keys-refusal" refusal={refusal()} />}
      </If>

      {/* Host-Projected Bot Models */}
      <Card>
        <CardHeader>
          <View testID="keys-models-header" class="flex-row items-center justify-between gap-3">
            <View class="flex-1 min-w-0 gap-1">
              <CardTitle>{t("keys.models")}</CardTitle>
              <CardDescription>
                {t("keys.modelsDescription")}
              </CardDescription>
            </View>
            <Button
              testID="keys-models-refresh-btn"
              variant="outline"
              size="sm"
              loading={k8View.loading()}
              onPress={() => k8View.refetch()}
            >
              {t("keys.refreshModels")}
            </Button>
          </View>
        </CardHeader>
        <CardContent>
          <If when={k8View.loading() && k8View() === undefined}>
            <Spinner label={t("keys.modelsLoading")} />
          </If>
          <If when={k8ViewRefusal()}>
            {(refusal) => <RefusalBanner testID="keys-models-refusal" refusal={refusal()} />}
          </If>
          <If when={k8View()}>
            {(data) => (
              <If
                when={data().models.length > 0}
                else={
                  <Empty
                    title={t("keys.modelsEmpty")}
                    description={t("keys.modelsEmptyDescription")}
                  />
                }
              >
                <View class="gap-1.5">
                  <Each of={data().models} key={(model) => model.id}>
                    {(model) => (
                      <ListItem
                        testID={`keys-bot-model-${model().id}`}
                        title={model().label}
                        description={model().id}
                      />
                    )}
                  </Each>
                </View>
              </If>
            )}
          </If>
        </CardContent>
      </Card>
    </View>
  );
}
