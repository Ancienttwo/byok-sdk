import { Text, View, type JSX } from "nsh";
import { MOTION_CLASSES } from "./motion.ts";
import { cx, FOCUS_RING_CLASS } from "./tokens.ts";

export interface ListItemProps {
  title: string;
  description?: string;
  leading?: JSX.Element;
  trailing?: JSX.Element;
  selected?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
  onPress?: () => void;
}

/** Inset grouped row (44 pt minimum height) supporting leading/trailing slots and interactive/static modes. */
export function ListItem(props: ListItemProps) {
  return (
    <View
      testID={props.testID}
      accessible
      role={props.onPress ? "button" : undefined}
      focusable={Boolean(props.onPress && !props.disabled)}
      disabled={Boolean(props.disabled)}
      accessibilityLabel={props.accessibilityLabel ?? props.title}
      accessibilityState={{
        selected: Boolean(props.selected),
        disabled: Boolean(props.disabled),
      }}
      onPress={props.disabled ? undefined : props.onPress}
      class={cx(
        "min-h-11 px-3 py-2 rounded-lg flex-row items-center justify-between gap-3",
        MOTION_CLASSES.interactiveColor,
        props.onPress ? cx("hover:bg-accent active:opacity-80", FOCUS_RING_CLASS) : "",
        props.selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "bg-transparent",
        props.disabled ? "opacity-50" : "",
      )}
    >
      <View class="flex-row items-center gap-2.5 flex-1">
        <If when={Boolean(props.leading)}>{props.leading}</If>
        <View class="gap-0.5 flex-1">
          <Text class="text-sm font-medium text-foreground">{props.title}</Text>
          <If when={Boolean(props.description)}>
            <Text class="text-xs text-muted-foreground">{props.description}</Text>
          </If>
        </View>
      </View>
      <If when={Boolean(props.trailing)}>{props.trailing}</If>
    </View>
  );
}
