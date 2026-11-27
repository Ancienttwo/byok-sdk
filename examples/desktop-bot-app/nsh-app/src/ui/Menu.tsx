import { Text, View, type JSX } from "nsh";
import {
  Menu as BaseMenu,
  MenuItem as BaseMenuItem,
  MenuSeparator as BaseMenuSeparator,
} from "nsh/base";
import { Icon, type IconName } from "./Icon.tsx";
import { MOTION_CLASSES } from "./motion.ts";
import { cx, FOCUS_RING_CLASS, POPOVER_SURFACE_CLASS } from "./tokens.ts";

export interface UiMenuProps {
  open?: boolean | null;
  trigger: JSX.Element;
  testID?: string;
  onOpenChange?: (open: boolean) => void;
  children?: JSX.Element;
}

/** Context / dropdown command menu anchored to its trigger using unified popover styling. */
export function Menu(props: UiMenuProps) {
  return (
    <BaseMenu
      testID={props.testID}
      open={props.open}
      offset={6}
      trigger={props.trigger}
      popupClass={cx(POPOVER_SURFACE_CLASS, "min-w-44 p-1 gap-0.5", MOTION_CLASSES.popupTransition)}
      popupStartingClass={MOTION_CLASSES.popupStarting}
      popupEndingClass={MOTION_CLASSES.popupEnding}
      onOpenChange={(e) => props.onOpenChange?.(e.open)}
    >
      {props.children}
    </BaseMenu>
  );
}

export interface UiMenuItemProps {
  label: string;
  icon?: IconName;
  checked?: boolean | null;
  disabled?: boolean;
  destructive?: boolean;
  shortcut?: string;
  testID?: string;
  onSelect?: () => void;
}

/** Command menu row with optional check mark, leading icon, and shortcut hint. */
export function MenuItem(props: UiMenuItemProps) {
  return (
    <BaseMenuItem
      testID={props.testID}
      checked={props.checked}
      disabled={Boolean(props.disabled)}
      accessibilityLabel={props.label}
      onSelect={props.onSelect}
      class={cx(
        "h-7 px-2 rounded-md flex-row items-center justify-between gap-3 hover:bg-accent focus:bg-accent disabled:opacity-40",
        MOTION_CLASSES.interactiveColor,
        FOCUS_RING_CLASS,
      )}
      indicatorClass="w-4 items-center justify-center"
      indicator={
        <If when={Boolean(props.checked)}>
          <Icon name="check" size="sm" class="text-primary" />
        </If>
      }
    >
      <View class="flex-row items-center gap-2 flex-1">
        <If when={Boolean(props.icon)}>
          <Icon
            name={props.icon!}
            size="sm"
            class={props.destructive ? "text-destructive" : "text-muted-foreground"}
          />
        </If>
        <Text class={cx("text-sm", props.destructive ? "text-destructive" : "text-popover-foreground")}>
          {props.label}
        </Text>
      </View>
      <If when={Boolean(props.shortcut)}>
        <Text class="text-xs font-mono text-muted-foreground">{props.shortcut}</Text>
      </If>
    </BaseMenuItem>
  );
}

export function MenuSeparator() {
  return <BaseMenuSeparator class="my-1 h-px bg-border" />;
}
