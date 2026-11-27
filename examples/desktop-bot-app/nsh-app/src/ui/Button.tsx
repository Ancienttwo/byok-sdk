import { Text, View, type JSX } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { Icon, type IconName } from "./Icon.tsx";
import { MOTION_CLASSES } from "./motion.ts";
import { cx, FOCUS_RING_CLASS } from "./tokens.ts";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT_CLASSES: Readonly<Record<ButtonVariant, string>> = {
  primary:
    "bg-primary hover:bg-primary/90 active:bg-primary/85",
  secondary:
    "bg-secondary hover:opacity-85 active:opacity-75",
  outline:
    "bg-card hover:bg-accent active:opacity-80 border border-border",
  ghost:
    "bg-transparent hover:bg-accent active:opacity-80",
  danger:
    "bg-destructive hover:bg-destructive/90 active:bg-destructive/85",
};

const TEXT_CLASSES: Readonly<Record<ButtonVariant, string>> = {
  primary: "text-primary-foreground",
  secondary: "text-secondary-foreground",
  outline: "text-foreground",
  ghost: "text-foreground",
  danger: "text-destructive-foreground",
};

const TEXT_WEIGHT_CLASSES: Readonly<Record<ButtonVariant, string>> = {
  primary: "font-semibold",
  secondary: "font-medium",
  outline: "font-medium",
  ghost: "font-medium",
  danger: "font-semibold",
};

const SIZE_CLASSES: Readonly<Record<ButtonSize, string>> = {
  sm: "h-6 px-2.5 gap-1 rounded-md",
  md: "h-8 px-3 gap-2 rounded-(--radius)",
  lg: "h-9 px-4 gap-2 rounded-(--radius)",
};

const ICON_BTN_SIZES: Readonly<Record<ButtonSize, string>> = {
  sm: "w-6 h-6 rounded-md",
  md: "w-8 h-8 rounded-(--radius)",
  lg: "w-9 h-9 rounded-(--radius)",
};

export interface UiButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  selected?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  onPress?: () => void;
  children?: JSX.Element | string;
}

/**
 * Styled desktop button built on `nsh/base` `Button`.
 * Preserves default OS cursor (never `cursor-pointer` per NSH Design Guides).
 */
export function Button(props: UiButtonProps) {
  const variant = () => props.variant ?? "primary";
  const size = () => props.size ?? "md";
  const isDisabled = () => Boolean(props.disabled || props.loading);

  return (
    <BaseButton
      testID={props.testID}
      disabled={isDisabled()}
      busy={Boolean(props.loading)}
      selected={Boolean(props.selected)}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityHint={props.accessibilityHint}
      onPress={props.onPress}
      class={cx(
        "flex-row items-center justify-center",
        MOTION_CLASSES.buttonPress,
        FOCUS_RING_CLASS,
        SIZE_CLASSES[size()],
        VARIANT_CLASSES[variant()],
        "selected:ring-2 selected:ring-ring disabled:opacity-50",
      )}
    >
      <If when={props.loading}>
        <Icon name="spinner" size={size() === "sm" ? "sm" : "md"} class={TEXT_CLASSES[variant()]} />
      </If>
      {typeof props.children === "string" ? (
        <Text
          class={cx(
            size() === "sm" ? "text-xs" : "text-sm",
            TEXT_WEIGHT_CLASSES[variant()],
            TEXT_CLASSES[variant()],
          )}
        >
          {props.children}
        </Text>
      ) : (
        <View class="flex-row items-center gap-1.5">{props.children}</View>
      )}
    </BaseButton>
  );
}

export interface IconButtonProps {
  icon: IconName;
  accessibilityLabel: string;
  accessibilityHint?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  selected?: boolean;
  testID?: string;
  onPress?: () => void;
}

/** Square icon button requiring an explicit screen-reader `accessibilityLabel`. */
export function IconButton(props: IconButtonProps) {
  const variant = () => props.variant ?? "ghost";
  const size = () => props.size ?? "md";
  const isDisabled = () => Boolean(props.disabled || props.loading);

  return (
    <BaseButton
      testID={props.testID}
      disabled={isDisabled()}
      busy={Boolean(props.loading)}
      selected={Boolean(props.selected)}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityHint={props.accessibilityHint}
      onPress={props.onPress}
      class={cx(
        "flex-row items-center justify-center",
        MOTION_CLASSES.iconButtonPress,
        FOCUS_RING_CLASS,
        ICON_BTN_SIZES[size()],
        VARIANT_CLASSES[variant()],
        "selected:ring-2 selected:ring-ring disabled:opacity-50",
      )}
    >
      <Icon
        name={props.loading ? "spinner" : props.icon}
        size={size() === "lg" ? "md" : "sm"}
        class={TEXT_CLASSES[variant()]}
      />
    </BaseButton>
  );
}
