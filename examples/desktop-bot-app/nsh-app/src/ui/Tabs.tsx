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

/** Segmented / tabbed strip with native sliding selection indicator. */
export function Tabs(props: UiTabsProps) {
  return (
    <BaseTabs
      testID={props.testID}
      orientation={props.orientation ?? "horizontal"}
      accessibilityLabel={props.accessibilityLabel}
      indicatorClass="inset-y-1 rounded-sm bg-background border border-border"
      class={cx(
        props.orientation === "vertical" ? "flex-col" : "flex-row items-center",
        "gap-1 p-1 rounded-(--radius) bg-muted border border-border",
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
        "h-7 px-2.5 rounded-sm items-center justify-center disabled:opacity-40",
        MOTION_CLASSES.interactiveColor,
        FOCUS_RING_CLASS,
      )}
    >
      {typeof props.children === "string" ? (
        <Text
          class={cx(
            "text-xs font-medium",
            props.selected ? "text-foreground" : "text-muted-foreground",
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
