import { reduceMotion, Text, View, type JSX } from "nsh";
import { Icon } from "./Icon.tsx";
import { cx } from "./tokens.ts";

export interface EmptyProps {
  title: string;
  description?: string;
  action?: JSX.Element;
}

/** Empty state region with clear next-action slot. */
export function Empty(props: EmptyProps) {
  return (
    <View class="p-6 rounded-(--radius) bg-muted items-center justify-center gap-2">
      <Icon name="info" size="lg" class="text-muted-foreground" />
      <Text class="text-sm font-medium text-foreground">{props.title}</Text>
      <If when={Boolean(props.description)}>
        <Text class="text-xs text-muted-foreground text-center">{props.description}</Text>
      </If>
      <If when={Boolean(props.action)}>
        <View class="pt-1">{props.action}</View>
      </If>
    </View>
  );
}

/** Quiet placeholder block matching the design system radius scale. */
export function Skeleton(props: { class?: string }) {
  return (
    <View
      accessibilityElementsHidden
      class={cx("h-4 rounded-sm bg-muted", props.class)}
    />
  );
}

/** Accessible loading indicator that pauses rotation under reduced motion. */
export function Spinner(props: { label?: string; size?: "sm" | "md" }) {
  return (
    <View
      accessible
      accessibilityLabel={props.label ?? "Loading"}
      accessibilityState={{ busy: true }}
      class="flex-row items-center gap-1.5"
    >
      <View class={reduceMotion() ? "" : "opacity-80"}>
        <Icon name="spinner" size={props.size ?? "sm"} class="text-primary" />
      </View>
      <If when={Boolean(props.label)}>
        <Text class="text-xs text-muted-foreground">{props.label}</Text>
      </If>
    </View>
  );
}
