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
      return lifecycle.connection === "open" ? "Running, connected" : "Running, connecting";
    case "halted":
      return `Halted: ${lifecycle.reason} (${lifecycle.at})`;
    case "crashed":
      return `Crashed (${lifecycle.at})`;
    case "awaiting-enrollment":
      return "Awaiting enrollment";
    case "stopped":
      return "Stopped";
  }
}

function clockSkewText(skew: DeviceView["clockSkew"]): string {
  return skew.status === "measured"
    ? `Device clock ahead by ${skew.deviceAheadMs} ms (±${skew.uncertaintyMs} ms), observed ${skew.observedAt}`
    : `Not measured: ${skew.reason}`;
}

function Fact(props: { label: string; value: string }) {
  return (
    <View class="flex-row gap-3" accessible accessibilityLabel={`${props.label}: ${props.value}`}>
      <Text class="w-48 text-xs text-muted-foreground">{props.label}</Text>
      <Text class="flex-1 text-xs text-foreground">{props.value}</Text>
    </View>
  );
}

function VerdictBadge(props: { verdict: RuntimeView["verdict"]; testID: string }) {
  return (
    <If
      when={props.verdict}
      else={<Badge testID={props.testID} variant="neutral" symbol="?" label="none reported" />}
    >
      {(verdict) => (
        <Badge
          testID={props.testID}
          variant={VERDICT_TONE[verdict()].variant}
          symbol={VERDICT_TONE[verdict()].symbol}
          label={verdict()}
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
      label={props.status}
    />
  );
}

const CELL = "flex-1 text-xs text-foreground";
const HEADER_CELL = "flex-1 text-xs font-medium text-muted-foreground";

/** The daemon's status and the SDK doctor, shown as the Host projected them (`host/settings/device.ts`). */
export function DevicePanel(props: { device: DeviceView }) {
  return (
    <View testID="settings-device" class="gap-4">
      <View class="gap-1.5">
        <Fact label="Paired" value={props.device.paired ? `Yes, ${props.device.deviceId ?? "no device id"}` : "No"} />
        <Fact label="Daemon" value={lifecycleText(props.device.lifecycle)} />
        <Fact label="Active tasks" value={String(props.device.activeTaskCount)} />
        <Fact label="Pending terminal commits" value={String(props.device.pendingTerminalCommits)} />
        <Fact label="Clock skew" value={clockSkewText(props.device.clockSkew)} />
      </View>

      <View class="gap-1.5">
        <Text role="header" accessibilityLevel={3} class="text-sm font-semibold text-foreground">
          Runtimes
        </Text>
        <View role="table" accessibilityLabel="Runtimes" class="gap-1">
          <View role="row" class="flex-row items-center gap-2 border-b border-border pb-1">
            <Text role="columnheader" class={HEADER_CELL}>Runtime</Text>
            <Text role="columnheader" class={HEADER_CELL}>Found</Text>
            <Text role="columnheader" class={HEADER_CELL}>Outcome</Text>
            <Text role="columnheader" class={HEADER_CELL}>Version</Text>
            <Text role="columnheader" class={HEADER_CELL}>Version policy</Text>
          </View>
          <Each of={props.device.runtimes} key={(runtime) => runtime.id}>
            {(runtime) => (
              <View testID={`settings-runtime-${runtime().id}`} role="row" class="flex-row items-center gap-2">
                <Text role="cell" class={`${CELL} font-mono`}>{runtime().id}</Text>
                <Text role="cell" class={CELL}>{runtime().present ? "Yes" : "No"}</Text>
                <Text role="cell" class={CELL}>
                  {`${runtime().outcome}${runtime().reason === undefined ? "" : `: ${runtime().reason}`}`}
                </Text>
                <Text role="cell" class={CELL}>{runtime().version ?? "—"}</Text>
                <View role="cell" class="flex-1 flex-row">
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
            Doctor
          </Text>
          <StatusBadge testID="settings-doctor-worst" status={props.device.doctor.worst} />
        </View>
        <View role="list" accessibilityLabel="Doctor checks" class="gap-1">
          <Each of={props.device.doctor.checks} key={(check) => check.id}>
            {(check) => (
              <View testID={`settings-check-${check().id}`} class="flex-row items-center gap-2">
                <StatusBadge testID={`settings-check-${check().id}-status`} status={check().status} />
                <Text class="flex-1 text-xs text-foreground">{`${check().id}: ${check().summary}`}</Text>
              </View>
            )}
          </Each>
        </View>
        <Text class="text-xs text-muted-foreground">{`Checked ${props.device.doctor.generatedAt}`}</Text>
      </View>
    </View>
  );
}
