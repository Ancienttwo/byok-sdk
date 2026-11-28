import { formatNumber, t } from "../i18n.ts";
import { restartSeconds } from "../statusCopy.ts";
import { Text, View } from "nsh";
import type { SupervisedHostState } from "../../../src/bridge/protocol.ts";
import { cx, HOST_STATE_META, type BadgeVariant } from "./tokens.ts";

const VARIANT_CLASSES: Readonly<Record<BadgeVariant, string>> = {
  neutral: "bg-secondary",
  primary: "bg-badge-primary",
  success: "bg-badge-success",
  warning: "bg-badge-warning",
  danger: "bg-badge-danger",
  hostStarting: "bg-host-starting",
  hostRunning: "bg-host-running",
  hostRestarting: "bg-host-restarting",
  hostStopped: "bg-host-stopped",
  hostFailed: "bg-host-failed",
};

const TEXT_CLASSES: Readonly<Record<BadgeVariant, string>> = {
  neutral: "text-secondary-foreground",
  primary: "text-foreground",
  success: "text-foreground",
  warning: "text-foreground",
  danger: "text-foreground",
  hostStarting: "text-host-starting-foreground",
  hostRunning: "text-host-running-foreground",
  hostRestarting: "text-host-restarting-foreground",
  hostStopped: "text-host-stopped-foreground",
  hostFailed: "text-host-failed-foreground",
};

export interface BadgeProps {
  variant?: BadgeVariant;
  size?: "sm" | "md";
  symbol?: string;
  label: string;
  testID?: string;
}

/** Semantic status pill pairing color with explicit text label and optional symbol. */
export function Badge(props: BadgeProps) {
  const variant = () => props.variant ?? "neutral";
  const size = () => props.size ?? "sm";
  return (
    <View
      testID={props.testID}
      accessible
      accessibilityLabel={props.label}
      class={cx(
        "flex-row items-center rounded-full",
        size() === "sm" ? "h-5 px-2 gap-1" : "h-6 px-2.5 gap-1.5",
        VARIANT_CLASSES[variant()],
      )}
    >
      <If when={Boolean(props.symbol)}>
        <Text class={cx("text-xs font-medium leading-none", TEXT_CLASSES[variant()])}>
          {props.symbol}
        </Text>
      </If>
      <Text class={cx("text-xs font-medium leading-none", TEXT_CLASSES[variant()])}>
        {props.label}
      </Text>
    </View>
  );
}

/** Host lifecycle indicator pairing Host-state color tokens with non-color symbol and label. */
export function HostStateBadge(props: { state: SupervisedHostState | null; testID?: string }) {
  const key = () => props.state?.state ?? "stopped";
  const meta = () => HOST_STATE_META[key()];
  const detailLabel = () => {
    const current = props.state;
    if (!current) return t("host.offline");
    const label = t("host." + current.state);
    if (current.state === "running") {
      return t("host.activeBadge", { label, count: formatNumber(current.activeWork) });
    }
    if (current.state === "restarting") {
      return t("host.restartBadge", { label, seconds: restartSeconds(current) });
    }
    return label;
  };
  return (
    <Badge
      testID={props.testID}
      variant={meta().badgeVariant}
      symbol={meta().symbol}
      label={detailLabel()}
    />
  );
}
