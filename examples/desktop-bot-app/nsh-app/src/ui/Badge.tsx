import { Text, View } from "nsh";
import type { SupervisedHostState } from "../../../src/bridge/protocol.ts";
import { cx, HOST_STATE_META, type BadgeVariant } from "./tokens.ts";

const VARIANT_CLASSES: Readonly<Record<BadgeVariant, string>> = {
  neutral: "bg-secondary border-border",
  primary: "bg-primary border-primary",
  success: "bg-success border-success",
  warning: "bg-warning border-warning",
  danger: "bg-destructive border-destructive",
  hostStarting: "bg-host-starting border-border",
  hostRunning: "bg-host-running border-border",
  hostRestarting: "bg-host-restarting border-border",
  hostStopped: "bg-host-stopped border-border",
  hostFailed: "bg-host-failed border-border",
};

const TEXT_CLASSES: Readonly<Record<BadgeVariant, string>> = {
  neutral: "text-secondary-foreground",
  primary: "text-primary-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  danger: "text-destructive-foreground",
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
        "flex-row items-center rounded-full border",
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
    if (!current) {
      return "Offline";
    }
    if (current.state === "running") {
      return `${meta().label} (${current.activeWork} active)`;
    }
    if (current.state === "restarting") {
      return `${meta().label} (${Math.ceil(current.inMs / 1000)}s)`;
    }
    return meta().label;
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
