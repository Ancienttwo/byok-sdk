import { t } from "../../i18n.ts";
import { Text, View } from "nsh";
import type { RuntimeView } from "../../../../src/host/settings/types.ts";
import { Badge, Empty, Separator, Surface } from "../../ui/index.ts";
import { runtimeDisplayName, runtimeOutcomeText, runtimeSignInGuidance, runtimeStatus } from "./runtimeStatus.ts";

function authStateText(authPresent: boolean | undefined): string {
  if (authPresent === true) return t("runtime.signed-in");
  if (authPresent === false) return t("runtime.signed-out");
  return t("runtime.not-checked");
}

function AgentFact(props: { label: string; value: string; testID?: string; mono?: boolean; selectable?: boolean }) {
  return (
    <View testID={props.testID} class="flex-row gap-3" accessible accessibilityLabel={t("common.fact", { label: props.label, value: props.value })}>
      <Text class="basis-1/3 min-w-0 text-xs text-muted-foreground">{props.label}</Text>
      <If
        when={props.selectable}
        else={
          <Text
            class={props.mono ? "flex-1 min-w-0 font-mono text-xs text-foreground" : "flex-1 min-w-0 text-xs text-foreground"}
          >
            {props.value}
          </Text>
        }
      >
        <View selectable class="flex-1 min-w-0">
          <Text
            class={props.mono ? "font-mono text-xs text-foreground" : "text-xs text-foreground"}
          >
            {props.value}
          </Text>
        </View>
      </If>
    </View>
  );
}

function AgentRow(props: { runtime: () => RuntimeView }) {
  const status = () => runtimeStatus(props.runtime());
  const guidance = () => runtimeSignInGuidance(props.runtime().id);
  const signInCommand = () => {
    const g = guidance();
    return g.kind === "command" ? g.command : undefined;
  };
  const showSignInGuidance = () => {
    const rt = props.runtime();
    return rt.present && rt.verdict !== "block" && rt.authPresent !== true;
  };
  const outcomeDetail = () => {
    const rt = props.runtime();
    if (rt.outcome === "timeout") {
      return t("runtime.signInTimedOut");
    }
    if (rt.outcome !== "available") {
      return runtimeOutcomeText(rt);
    }
    return null;
  };
  const executableLabel = () => {
    const source = props.runtime().executableSource;
    return source === undefined ? t("runtime.executable") : t("runtime.executableSource", { source: t("runtime.source." + source) });
  };

  const upgradeText = (upgrade: NonNullable<RuntimeView["upgrade"]>) => {
    const key = upgrade.state === "required" ? "runtime.upgradeRequired" : "runtime.upgradeAvailable";
    return upgrade.minimumVersion === undefined
      ? t(key, { qualified: upgrade.qualifiedVersion })
      : t(key + "Minimum", { qualified: upgrade.qualifiedVersion, minimum: upgrade.minimumVersion });
  };

  return (
    <View testID={`settings-agent-${props.runtime().id}`} class="gap-2 py-2">
      <View class="flex-row items-center gap-3">
        <View class="flex-1 min-w-0 flex-row items-center gap-2">
          <Text class="text-sm font-semibold text-foreground">{runtimeDisplayName(props.runtime().id)}</Text>
          <Text class="font-mono text-xs text-muted-foreground">{props.runtime().id}</Text>
        </View>
        <View class="shrink-0">
          <Badge
            testID={`settings-agent-${props.runtime().id}-status`}
            variant={status().variant}
            symbol={status().symbol}
            label={status().label}
          />
        </View>
      </View>

      <View class="gap-1">
        <If when={props.runtime().outcome === "available"}>
          <AgentFact
            label={t("runtime.signIn")}
            value={authStateText(props.runtime().authPresent)}
            testID={`settings-agent-${props.runtime().id}-auth`}
          />
        </If>

        <If when={outcomeDetail()}>
          {(detail) => (
            <Text testID={`settings-agent-${props.runtime().id}-detail`} class="text-xs text-muted-foreground">
              {detail()}
            </Text>
          )}
        </If>

        <If when={props.runtime().present || props.runtime().version !== undefined}>
          <AgentFact
            label={t("runtime.version")}
            value={props.runtime().version ?? t("runtime.not-checked")}
            testID={`settings-agent-${props.runtime().id}-version`}
          />
        </If>

        <If when={props.runtime().verdict === "warn" ? props.runtime().qualifiedVersion : undefined}>
          {(qualified) => (
            <Text testID={`settings-agent-${props.runtime().id}-qualified`} class="text-xs text-warning">
              {t("runtime.qualified", { version: qualified() })}
            </Text>
          )}
        </If>

        <If when={props.runtime().verdict === "block"}>
          <Text testID={`settings-agent-${props.runtime().id}-blocked`} class="text-xs text-destructive">
            {t("runtime.blocked")}
          </Text>
        </If>

        <If when={props.runtime().upgrade}>
          {(upgrade) => (
            <View testID={`settings-agent-${props.runtime().id}-upgrade`} class="gap-1 pt-0.5">
              <Text class="text-xs text-muted-foreground">
                {upgradeText(upgrade())}
              </Text>
              <Surface tone="muted" class="px-2.5 py-1.5 rounded-md">
                <View selectable>
                  <Text class="font-mono text-xs text-foreground">{upgrade().command}</Text>
                </View>
              </Surface>
            </View>
          )}
        </If>

        <If when={props.runtime().executablePath}>
          {(execPath) => (
            <AgentFact
              label={executableLabel()}
              value={execPath()}
              testID={`settings-agent-${props.runtime().id}-executable`}
              mono
              selectable
            />
          )}
        </If>

        <If when={showSignInGuidance()}>
          <View testID={`settings-agent-${props.runtime().id}-signin`} class="gap-1 pt-1">
            <If when={signInCommand()}>
              {(cmd) => (
                <Surface tone="muted" class="px-2.5 py-1.5 rounded-md">
                  <View selectable>
                    <Text
                      testID={`settings-agent-${props.runtime().id}-signin-cmd`}
                      class="font-mono text-xs text-foreground"
                    >
                      {cmd()}
                    </Text>
                  </View>
                </Surface>
              )}
            </If>
            <Text
              testID={`settings-agent-${props.runtime().id}-signin-note`}
              class="text-xs text-muted-foreground"
            >
              {guidance().note}
            </Text>
          </View>
        </If>
      </View>
    </View>
  );
}

/**
 * Settings > Agents list: projects each detected runtime from `DeviceView.runtimes` using the shared
 * `runtimeStatus` vocabulary without guessing unmeasured fields.
 */
export function AgentsPanel(props: { runtimes: readonly RuntimeView[] }) {
  return (
    <View testID="settings-agents" class="gap-1">
      <If
        when={props.runtimes.length > 0}
        else={
          <Empty
            title={t("runtime.empty")}
            description={t("runtime.emptyDetail")}
          />
        }
      >
        <View role="list" accessibilityLabel={t("settings.agents")} class="gap-1">
          <Each of={props.runtimes} key={(runtime) => runtime.id}>
            {(runtime, index) => (
              <View class="gap-1">
                <If when={index() > 0}>
                  <Separator />
                </If>
                <AgentRow runtime={runtime} />
              </View>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}
