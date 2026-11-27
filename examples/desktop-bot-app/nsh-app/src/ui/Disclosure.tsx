import { reduceMotion, Text, View, type JSX } from "nsh";
import { Collapsible } from "nsh/base";
import { Icon } from "./Icon.tsx";
import { MOTION_CLASSES } from "./motion.ts";
import { cx, FOCUS_RING_CLASS } from "./tokens.ts";

export interface DisclosureProps {
  open: boolean;
  title: string;
  summary?: string;
  testID?: string;
  onToggle: (nextOpen: boolean) => void;
  children?: JSX.Element;
}

/**
 * Expandable section built on `nsh/base` `Collapsible`.
 * Respects `reduceMotion()` and exposes `accessibilityState.expanded` directly on the trigger.
 */
export function Disclosure(props: DisclosureProps) {
  return (
    <Collapsible
      open={props.open}
      reveal={!reduceMotion()}
      class="rounded-(--radius) bg-card p-3 gap-2"
      content={<View class="pt-2 border-t border-border gap-2">{props.children}</View>}
    >
      <View class="flex-row items-center justify-between gap-2">
        <View class="flex-row items-center gap-2 flex-1">
          <View
            testID={props.testID}
            role="button"
            focusable
            accessible
            accessibilityLabel={props.title}
            accessibilityHint={props.open ? "Collapse details" : "Expand details"}
            accessibilityState={{ expanded: props.open }}
            onPress={() => props.onToggle(!props.open)}
            class={cx(
              "flex-row items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-accent active:opacity-80",
              MOTION_CLASSES.interactiveColor,
              FOCUS_RING_CLASS,
            )}
          >
            <Icon name={props.open ? "chevronDown" : "chevronRight"} size="sm" class="text-muted-foreground" />
            <Text class="text-sm font-medium text-foreground">{props.title}</Text>
          </View>
        </View>
        <If when={Boolean(props.summary)}>
          <Text class="text-xs text-muted-foreground">{props.summary}</Text>
        </If>
      </View>
    </Collapsible>
  );
}
