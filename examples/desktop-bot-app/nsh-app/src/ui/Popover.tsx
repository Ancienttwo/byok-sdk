import { Text, View, type JSX } from "nsh";
import { Popover as BasePopover, Tooltip as BaseTooltip } from "nsh/base";
import { MOTION_CLASSES } from "./motion.ts";
import { cx, POPOVER_SURFACE_CLASS } from "./tokens.ts";

export interface UiPopoverProps {
  open?: boolean | null;
  defaultOpen?: boolean;
  placement?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  trigger: JSX.Element;
  children?: JSX.Element;
  testID?: string;
  onOpenChange?: (open: boolean) => void;
}

/** Trigger-anchored popover sharing unified elevated surface chrome. */
export function Popover(props: UiPopoverProps) {
  return (
    <BasePopover
      testID={props.testID}
      open={props.open}
      defaultOpen={props.defaultOpen}
      placement={props.placement ?? "bottom"}
      align={props.align ?? "start"}
      offset={6}
      trigger={props.trigger}
      popupClass={cx(POPOVER_SURFACE_CLASS, "p-3 gap-2", MOTION_CLASSES.popupTransition)}
      popupStartingClass={MOTION_CLASSES.popupStarting}
      popupEndingClass={MOTION_CLASSES.popupEnding}
      onOpenChange={(e) => props.onOpenChange?.(e.open)}
    >
      {props.children}
    </BasePopover>
  );
}

export interface UiTooltipProps {
  text: string;
  placement?: "top" | "bottom" | "left" | "right";
  children: JSX.Element;
}

/** Hover/focus tooltip reusing the unified popover surface tokens. */
export function Tooltip(props: UiTooltipProps) {
  return (
    <View
      tooltip={
        <BaseTooltip
          placement={props.placement ?? "top"}
          offset={6}
          class={cx(POPOVER_SURFACE_CLASS, "px-2.5 py-1.5", MOTION_CLASSES.popupTransition)}
          startingClass={MOTION_CLASSES.popupStarting}
          endingClass={MOTION_CLASSES.popupEnding}
        >
          <Text class="text-xs text-popover-foreground">{props.text}</Text>
        </BaseTooltip>
      }
    >
      {props.children}
    </View>
  );
}
