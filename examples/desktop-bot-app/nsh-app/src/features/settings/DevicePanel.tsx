import { formatDate, formatNumber, t } from "../../i18n.ts";
import { runtimeOutcomeText } from "./runtimeStatus.ts";
import { Text, View } from "nsh";
import type { DeviceView, RuntimeView } from "../../../../src/host/settings/types.ts";
import { Badge, type BadgeVariant } from "../../ui/index.ts";

type DoctorStatus = DeviceView["doctor"]["worst"];
type Verdict = NonNullable<RuntimeView["verdict"]>;
type Tone = { readonly variant: BadgeVariant; readonly symbol: string };

const STATUS_TONE: Readonly<Record<DoctorStatus, Tone>> = {
  pass: { variant: "success", symbol: "✓" },
  warn: { variant: "warning", symbol: "!" },
  fail: { variant: "danger", symbol: "✕" },
};

const VERDICT_TONE: Readonly<Record<Verdict, Tone>> = {
  allow: { variant: "success", symbol: "✓" },
  warn: { variant: "warning", symbol: "!" },
  block: { variant: "danger", symbol: "✕" },
};

function lifecycleText(lifecycle: DeviceView["lifecycle"]): string {
  switch (lifecycle.phase) {
    case "running":
      return lifecycle.connection === "open" ? t("device.connected") : t("device.connecting");
    case "halted":
      return t("device.halted", { reason: t("device.halt." + lifecycle.reason), at: formatDate(lifecycle.at) });
    case "crashed":
      return t("device.crashed", { at: formatDate(lifecycle.at) });
    case "awaiting-enrollment":
      return t("device.awaitingEnrollment");
    case "stopped":
      return t("host.stopped");
  }
}

function clockSkewText(skew: DeviceView["clockSkew"]): string {
  return skew.status === "measured"
    ? t("device.skew", { offset: formatNumber(skew.deviceAheadMs), uncertainty: formatNumber(skew.uncertaintyMs), at: formatDate(skew.observedAt) })
    : t("device.skew." + skew.reason);
}

function Fact(props: { label: string; value: string }) {
  return (
    <View class="flex-row gap-3" accessible accessibilityLabel={t("common.fact", { label: props.label, value: props.value })}>
      <Text class="basis-1/3 min-w-0 text-xs text-muted-foreground">{props.label}</Text>
      <Text class="flex-1 text-xs text-foreground">{props.value}</Text>
    </View>
  );
}

function VerdictBadge(props: { verdict: RuntimeView["verdict"]; testID: string }) {
  return (
    <If
      when={props.verdict}
      else={<Badge testID={props.testID} variant="neutral" symbol="?" label={t("device.verdict.none")} />}
    >
      {(verdict) => (
        <Badge
          testID={props.testID}
          variant={VERDICT_TONE[verdict()].variant}
          symbol={VERDICT_TONE[verdict()].symbol}
          label={t("device.verdict." + verdict())}
        />
      )}
    </If>
  );
}

function StatusBadge(props: { status: DoctorStatus; testID: string }) {
  return (
    <Badge
      testID={props.testID}
      variant={STATUS_TONE[props.status].variant}
      symbol={STATUS_TONE[props.status].symbol}
      label={t("device.doctor." + props.status)}
    />
  );
}

const CELL = "flex-1 text-xs text-foreground";
const HEADER_CELL = "flex-1 text-xs font-medium text-muted-foreground";
const BADGE_COLUMN = "basis-1/4 min-w-0";

/** The daemon's status and the SDK doctor, shown as the Host projected them (`host/settings/device.ts`). */
export function DevicePanel(props: { device: DeviceView }) {
  return (
    <View testID="settings-device" class="gap-4">
      <View class="gap-1.5">
        <Fact label={t("device.paired")} value={props.device.paired ? t("device.pairedWithId", { id: props.device.deviceId ?? t("device.noDeviceId") }) : t("common.no")} />
        <Fact label={t("device.daemon")} value={lifecycleText(props.device.lifecycle)} />
        <Fact label={t("device.active")} value={formatNumber(props.device.activeTaskCount)} />
        <Fact label={t("device.pending")} value={formatNumber(props.device.pendingTerminalCommits)} />
        <Fact label={t("device.clockSkew")} value={clockSkewText(props.device.clockSkew)} />
      </View>

      <View class="gap-1.5">
        <Text role="header" accessibilityLevel={3} class="text-sm font-semibold text-foreground">
          {t("device.runtimes")}
        </Text>
        <View role="table" accessibilityLabel={t("device.runtimes")} class="gap-1">
          <View role="row" class="flex-row items-center gap-2 border-b border-border pb-1">
            <Text role="columnheader" class={HEADER_CELL}>{t("device.runtime")}</Text>
            <Text role="columnheader" class={HEADER_CELL}>{t("device.found")}</Text>
            <Text role="columnheader" class={HEADER_CELL}>{t("device.outcome")}</Text>
            <Text role="columnheader" class={HEADER_CELL}>{t("runtime.version")}</Text>
            <Text role="columnheader" class={`${BADGE_COLUMN} text-xs font-medium text-muted-foreground`}>{t("device.versionPolicy")}</Text>
          </View>
          <Each of={props.device.runtimes} key={(runtime) => runtime.id}>
            {(runtime) => (
              <View testID={`settings-runtime-${runtime().id}`} role="row" class="flex-row items-center gap-2">
                <Text role="cell" class={`${CELL} font-mono`}>{runtime().id}</Text>
                <Text role="cell" class={CELL}>{runtime().present ? t("common.yes") : t("common.no")}</Text>
                <Text role="cell" class={CELL}>
                  {runtimeOutcomeText(runtime())}
                </Text>
                <Text role="cell" class={CELL}>{runtime().version ?? "—"}</Text>
                <View role="cell" class={`${BADGE_COLUMN} flex-row`}>
                  <VerdictBadge testID={`settings-runtime-${runtime().id}-verdict`} verdict={runtime().verdict} />
                </View>
              </View>
            )}
          </Each>
        </View>
      </View>

      <View class="gap-1.5">
        <View class="flex-row items-center gap-2">
          <Text role="header" accessibilityLevel={3} class="text-sm font-semibold text-foreground">
            {t("device.doctorTitle")}
          </Text>
          <StatusBadge testID="settings-doctor-worst" status={props.device.doctor.worst} />
        </View>
        <View role="list" accessibilityLabel={t("device.doctorChecks")} class="gap-1">
          <Each of={props.device.doctor.checks} key={(check) => check.id}>
            {(check) => (
              <View testID={`settings-check-${check().id}`} class="flex-row items-center gap-2">
                <StatusBadge testID={`settings-check-${check().id}-status`} status={check().status} />
                <Text class="flex-1 text-xs text-foreground">{t("device.doctorCheck." + check().id)}</Text>
              </View>
            )}
          </Each>
        </View>
        <Text class="text-xs text-muted-foreground">{t("device.checked", { at: formatDate(props.device.doctor.generatedAt) })}</Text>
      </View>
    </View>
  );
}
