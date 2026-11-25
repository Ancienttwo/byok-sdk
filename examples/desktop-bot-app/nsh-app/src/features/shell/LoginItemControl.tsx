import { resource, signal, Text, View } from "nsh";
import type { LoginItemView } from "../../../../src/bridge/domains/settings.ts";
import { refusalOf } from "../../../../src/renderer/keys/submit.ts";
import { readLoginItem, updateLoginItem } from "../../store.ts";
import { Spinner, Switch } from "../../ui/index.ts";

/**
 * OS-authoritative login item setting loaded lazily when the Settings section opens.
 * Displays an explicit non-toggle notice on unsupported platforms (Linux).
 */
export function LoginItemControl() {
  const loaded = resource(() => 1, async () => await readLoginItem());
  const updated = signal<LoginItemView | null>(null);
  const pending = signal(false);
  const updateError = signal<string | null>(null);

  const view = () => updated() ?? loaded() ?? null;
  const loadError = () => {
    const err = loaded.error();
    if (!err) {
      return null;
    }
    const refusal = refusalOf(err);
    return refusal.code ? `${refusal.code}: ${refusal.message}` : refusal.message;
  };
  const supportedView = (): LoginItemView | null => {
    const current = view();
    return current && current.supported ? current : null;
  };
  const unsupported = () => {
    const current = view();
    return current !== null && !current.supported;
  };

  const toggle = async (enabled: boolean) => {
    if (pending()) {
      return;
    }
    pending.set(true);
    updateError.set(null);
    try {
      updated.set(await updateLoginItem(enabled));
    } catch (error) {
      const refusal = refusalOf(error);
      updateError.set(refusal.code ? `${refusal.code}: ${refusal.message}` : refusal.message);
    } finally {
      pending.set(false);
    }
  };

  return (
    <View class="gap-2">
      <If when={loaded.loading() && view() === null}>
        <Spinner label="Checking login item setting…" />
      </If>
      <If when={loadError()}>
        {(msg) => (
          <View testID="login-item-error" role="alert">
            <Text class="text-xs text-destructive">{`Login item unavailable: ${msg()}`}</Text>
          </View>
        )}
      </If>
      <If when={unsupported()}>
        <Text testID="login-item-unsupported" class="text-xs text-muted-foreground">
          Not available on this platform.
        </Text>
      </If>
      <If when={supportedView()}>
        {(item) => (
          <Switch
            testID="login-item-switch"
            label="Open at login"
            checked={item().enabled}
            disabled={pending()}
            onChange={(checked) => void toggle(checked)}
          />
        )}
      </If>
      <If when={updateError()}>
        {(msg) => (
          <View testID="login-item-error" role="alert">
            <Text class="text-xs text-destructive">{`Login item unavailable: ${msg()}`}</Text>
          </View>
        )}
      </If>
    </View>
  );
}
