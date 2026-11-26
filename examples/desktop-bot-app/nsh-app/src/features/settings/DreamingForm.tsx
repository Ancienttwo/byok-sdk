import { cleanup, signal, Text, untracked, View } from "nsh";
import type { ModelChoice } from "../../../../src/host/conversation/catalog.ts";
import type { DreamingSetting } from "../../../../src/host/settings/types.ts";
import { toBridgeCallError } from "../../bridge.ts";
import { saveDreaming } from "../../store.ts";
import { Button, Checkbox, Switch } from "../../ui/index.ts";

/**
 * The global switch and the preferred models, in the order picked; K8 reads them when the Host next starts. The draft
 * starts from `saved` when the form mounts (each settings load mounts a new form); a save keeps it.
 */
export function DreamingForm(props: {
  saved: () => DreamingSetting;
  models: readonly ModelChoice[];
  onSaved: (setting: DreamingSetting) => void;
}) {
  const draft = signal<DreamingSetting>(untracked(props.saved));
  const busy = signal(false);
  const saved = signal(false);
  const saveError = signal<string | null>(null);
  // A save can land after a Refresh replaced this form or the section unmounted: it then changes nothing.
  let mounted = true;
  cleanup(() => {
    mounted = false;
  });

  const known = () => new Set(props.models.map((model) => model.id));
  const departed = () => draft().models.filter((id) => !known().has(id));
  const rank = (id: string) => draft().models.indexOf(id) + 1;
  const toggle = (id: string) =>
    draft.update((current) => ({
      ...current,
      models: current.models.includes(id) ? current.models.filter((model) => model !== id) : [...current.models, id],
    }));

  const save = async () => {
    if (busy()) {
      return;
    }
    busy.set(true);
    saved.set(false);
    saveError.set(null);
    try {
      const settings = await saveDreaming(draft());
      if (mounted) {
        props.onSaved(settings.dreaming);
        saved.set(true);
      }
    } catch (error) {
      if (mounted) {
        saveError.set(toBridgeCallError(error).message);
      }
    } finally {
      if (mounted) {
        busy.set(false);
      }
    }
  };

  return (
    <View testID="settings-dreaming-form" class="gap-3">
      <Switch
        testID="settings-dreaming-switch"
        label="Dreaming on"
        checked={draft().enabled}
        onChange={(enabled) => draft.update((current) => ({ ...current, enabled }))}
      />
      <View role="group" accessibilityLabel="Models, preferred first" class="gap-1.5">
        <Text class="text-xs font-medium text-muted-foreground">Models, preferred first</Text>
        <Each of={props.models} key={(model) => model.id}>
          {(model) => (
            <Checkbox
              testID={`settings-dreaming-model-${model().id}`}
              label={rank(model().id) > 0 ? `${model().label} (#${rank(model().id)})` : model().label}
              checked={rank(model().id) > 0}
              onChange={() => toggle(model().id)}
            />
          )}
        </Each>
        <Each of={departed()} key={(id) => id}>
          {(id) => (
            <Checkbox
              testID={`settings-dreaming-model-${id()}`}
              label={`${id()} (#${rank(id())}, no longer in the catalog)`}
              checked
              onChange={() => toggle(id())}
            />
          )}
        </Each>
      </View>
      <View class="flex-row items-center gap-2">
        <Button testID="settings-dreaming-save" size="sm" loading={busy()} onPress={() => void save()}>
          Save dreaming
        </Button>
      </View>
      <If when={saved()}>
        <View testID="settings-dreaming-result" role="region" accessibilityLiveRegion="polite">
          <Text class="text-xs text-muted-foreground">Saved. Applies when the Host next starts.</Text>
        </View>
      </If>
      <If when={saveError()}>
        {(message) => (
          <View testID="settings-dreaming-error" role="alert">
            <Text class="text-xs text-destructive">{`Save failed: ${message()}`}</Text>
          </View>
        )}
      </If>
    </View>
  );
}
