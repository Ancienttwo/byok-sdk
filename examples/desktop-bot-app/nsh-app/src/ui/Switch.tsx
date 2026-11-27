import { Text, View } from "nsh";
import { Switch as BaseSwitch } from "nsh/base";
import { MOTION_CLASSES } from "./motion.ts";
import { cx, FOCUS_RING_CLASS } from "./tokens.ts";

export interface UiSwitchProps {
  checked?: boolean;
  disabled?: boolean;
  label?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  onChange?: (checked: boolean) => void;
}

/** Controlled toggle switch using iOS `systemGreen` checked track, `systemFill` off track, and white thumb. */
export function Switch(props: UiSwitchProps) {
  return (
    <BaseSwitch
      testID={props.testID}
      checked={Boolean(props.checked)}
      disabled={Boolean(props.disabled)}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityHint={props.accessibilityHint}
      onChange={(e) => props.onChange?.(e.checked)}
      class={cx(
        "flex-row items-center gap-2 disabled:opacity-50",
        FOCUS_RING_CLASS,
      )}
      trackClass={cx(
        "w-11 h-6 p-0.5 rounded-full bg-muted checked:bg-success flex-row items-center",
        MOTION_CLASSES.interactiveColor,
      )}
      thumbClass={cx(
        "w-5 h-5 rounded-full bg-success-foreground checked:translate-x-5",
        MOTION_CLASSES.switchThumb,
      )}
    >
      <If when={Boolean(props.label)}>
        <Text class="text-sm text-foreground">{props.label}</Text>
      </If>
    </BaseSwitch>
  );
}
