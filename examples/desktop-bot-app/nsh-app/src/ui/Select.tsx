import { t } from "../i18n.ts";
import { Text, View } from "nsh";
import { Select as BaseSelect, type SelectItem } from "nsh/base";
import { Icon } from "./Icon.tsx";
import { MOTION_CLASSES } from "./motion.ts";
import { cx, FOCUS_RING_CLASS, POPOVER_SURFACE_CLASS } from "./tokens.ts";

export type SelectOption = SelectItem;

export interface UiSelectProps {
  items: SelectItem[];
  value?: string | null;
  defaultValue?: string | null;
  placeholder?: string;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
  onChange?: (value: string | null) => void;
}

/** Styled desktop dropdown select sharing unified popover chrome and keyboard navigation. */
export function Select(props: UiSelectProps) {
  const selectedTitle = () => {
    const current = props.value ?? props.defaultValue;
    return props.items.find((item) => item.value === current)?.title;
  };

  return (
    <BaseSelect
      testID={props.testID}
      items={props.items}
      value={props.value}
      defaultValue={props.defaultValue}
      placeholder={props.placeholder ?? t("common.select")}
      disabled={Boolean(props.disabled)}
      accessibilityLabel={props.accessibilityLabel}
      onChange={(e) => props.onChange?.(e.value)}
      trigger={
        <View
          class={cx(
            "h-8 px-3 flex-row items-center justify-between gap-2 rounded-(--radius) border border-input bg-card hover:bg-accent",
            MOTION_CLASSES.interactiveColor,
            FOCUS_RING_CLASS,
            props.disabled ? "opacity-50 bg-muted" : "",
          )}
        >
          <Text class={cx("text-sm", selectedTitle() ? "text-foreground" : "text-tertiary-foreground")}>
            {selectedTitle() ?? props.placeholder ?? t("common.select")}
          </Text>
          <Icon name="chevronDown" size="sm" class="text-muted-foreground" />
        </View>
      }
      popupClass={cx(
        POPOVER_SURFACE_CLASS,
        "p-1",
        MOTION_CLASSES.popupTransition,
      )}
      popupStartingClass={MOTION_CLASSES.popupStarting}
      popupEndingClass={MOTION_CLASSES.popupEnding}
      listClass="gap-0.5"
      itemClass={cx(
        "h-7 px-2.5 rounded-md flex-row items-center text-sm text-popover-foreground focus:bg-accent focus:text-accent-foreground selected:font-semibold disabled:opacity-40",
        MOTION_CLASSES.interactiveColor,
      )}
    />
  );
}
