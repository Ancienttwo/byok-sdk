import { Text, type JSX } from "nsh";
import { Tab as BaseTab, Tabs as BaseTabs } from "nsh/base";
import { MOTION_CLASSES } from "./motion.ts";
import { cx, FOCUS_RING_CLASS } from "./tokens.ts";

export interface UiTabsProps {
  orientation?: "horizontal" | "vertical";
  accessibilityLabel?: string;
  testID?: string;
  class?: string;
  children?: JSX.Element;
}

/** iOS segmented control with `systemFill` track and native sliding `segmented-thumb` indicator. */
export function Tabs(props: UiTabsProps) {
  return (
    <BaseTabs
      testID={props.testID}
      orientation={props.orientation ?? "horizontal"}
      accessibilityLabel={props.accessibilityLabel}
      indicatorClass="inset-y-0.5 rounded-md bg-segmented-thumb"
      class={cx(
        props.orientation === "vertical" ? "flex-col" : "flex-row items-center",
        "gap-0.5 p-0.5 rounded-lg bg-muted",
        props.class,
      )}
    >
      {props.children}
    </BaseTabs>
  );
}

export interface UiTabProps {
  selected?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
  onPress?: () => void;
  children?: JSX.Element | string;
}

/** Individual tab option inside `<Tabs>`. */
export function Tab(props: UiTabProps) {
  return (
    <BaseTab
      testID={props.testID}
      selected={Boolean(props.selected)}
      disabled={Boolean(props.disabled)}
      accessibilityLabel={props.accessibilityLabel}
      onPress={props.onPress}
      class={cx(
        "h-7 px-2.5 rounded-md items-center justify-center disabled:opacity-40",
        MOTION_CLASSES.interactiveColor,
        FOCUS_RING_CLASS,
      )}
    >
      {typeof props.children === "string" ? (
        <Text
          class={cx(
            "text-xs",
            props.selected ? "font-semibold text-foreground" : "font-medium text-muted-foreground",
          )}
        >
          {props.children}
        </Text>
      ) : (
        props.children
      )}
    </BaseTab>
  );
}
