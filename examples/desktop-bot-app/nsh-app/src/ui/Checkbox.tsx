import { Text, View } from "nsh";
import { Checkbox as BaseCheckbox } from "nsh/base";
import { Icon } from "./Icon.tsx";
import { MOTION_CLASSES } from "./motion.ts";
import { cx, FOCUS_RING_CLASS } from "./tokens.ts";

export interface UiCheckboxProps {
  checked?: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  label?: string;
  accessibilityLabel?: string;
  testID?: string;
  onChange?: (checked: boolean) => void;
}

/** Controlled desktop checkbox supporting checked, unchecked, and indeterminate states. */
export function Checkbox(props: UiCheckboxProps) {
  return (
    <BaseCheckbox
      testID={props.testID}
      checked={Boolean(props.checked)}
      indeterminate={Boolean(props.indeterminate)}
      disabled={Boolean(props.disabled)}
      invalid={Boolean(props.invalid)}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      onChange={(e) => props.onChange?.(e.checked)}
      class={cx(
        "flex-row items-center gap-2 disabled:opacity-50",
        FOCUS_RING_CLASS,
      )}
      indicatorClass={cx(
        "w-4 h-4 rounded-sm border items-center justify-center bg-card",
        MOTION_CLASSES.interactiveColor,
        props.invalid ? "border-destructive" : "border-input",
        "checked:bg-primary checked:border-primary indeterminate:bg-primary indeterminate:border-primary",
      )}
      indicator={
        <View class="items-center justify-center">
          <If when={props.indeterminate}>
            <Icon name="minus" size="sm" class="text-primary-foreground" />
          </If>
          <If when={!props.indeterminate && props.checked}>
            <Icon name="check" size="sm" class="text-primary-foreground" />
          </If>
        </View>
      }
    >
      <If when={Boolean(props.label)}>
        <Text class="text-sm text-foreground">{props.label}</Text>
      </If>
    </BaseCheckbox>
  );
}
