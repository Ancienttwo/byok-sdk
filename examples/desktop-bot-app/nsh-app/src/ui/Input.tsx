import { platform, type InputRef, type SubmitBehavior, type ViewRef } from "nsh";
import { Input as BaseInput } from "nsh/base";
import { MOTION_CLASSES } from "./motion.ts";
import { cx, FOCUS_RING_CLASS } from "./tokens.ts";

export type InputVariant = "default" | "masked";
export type InputSize = "sm" | "md" | "lg";

const SIZE_CLASSES: Readonly<Record<InputSize, string>> = {
  sm: "h-7 px-2.5 text-xs",
  md: "h-8 px-3 text-sm",
  lg: "h-10 px-3 text-base",
};

/** ADR-052 D4: central platform CJK font token on Windows so CJK input never renders tofu. */
export const platformInputFont = () => (platform.os === "windows" ? "font-cjk" : "");

export interface UiInputProps {
  ref?: InputRef | ((ref: InputRef) => void);
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  variant?: InputVariant;
  size?: InputSize;
  invalid?: boolean;
  disabled?: boolean;
  readonly?: boolean;
  autoFocus?: boolean;
  maxLength?: number;
  accessibilityLabel?: string;
  accessibilityDescribedBy?: ViewRef | null;
  testID?: string;
  onChange?: (e: { value: string }) => void;
  onSubmit?: (e: { text: string }) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

/** Single-line native input with centralized Windows `font-cjk` token enforcement. */
export function Input(props: UiInputProps) {
  const size = () => props.size ?? "md";
  return (
    <BaseInput
      ref={props.ref}
      value={props.value}
      defaultValue={props.defaultValue}
      placeholder={props.placeholder}
      masked={props.variant === "masked"}
      readonly={Boolean(props.readonly || props.disabled)}
      disabled={Boolean(props.disabled)}
      autoFocus={props.autoFocus}
      maxLength={props.maxLength}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityDescribedBy={props.accessibilityDescribedBy}
      accessibilityState={{
        disabled: Boolean(props.disabled),
        invalid: Boolean(props.invalid),
      }}
      testID={props.testID}
      onChange={props.onChange}
      onSubmit={props.onSubmit}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      class={cx(
        "rounded-(--radius) border bg-background text-foreground placeholder:text-muted-foreground",
        MOTION_CLASSES.interactiveColor,
        FOCUS_RING_CLASS,
        SIZE_CLASSES[size()],
        props.invalid ? "border-destructive" : "border-input",
        props.disabled ? "opacity-50 bg-muted" : "",
        platformInputFont(),
      )}
    />
  );
}

export interface UiTextareaProps {
  ref?: InputRef | ((ref: InputRef) => void);
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
  readonly?: boolean;
  autoFocus?: boolean;
  maxLength?: number;
  accessibilityLabel?: string;
  accessibilityDescribedBy?: ViewRef | null;
  testID?: string;
  /** What return does: `"newline"` (default), `"submit"` (Shift / Option+Return still inserts a line break), `"blurAndSubmit"`. */
  submitBehavior?: SubmitBehavior;
  onChange?: (e: { value: string }) => void;
  onSubmit?: (e: { text: string }) => void;
  /** Before the text changes: `key` is the typed text, `Backspace` or `Enter`. */
  onKeyPress?: (e: { key: string }) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

/** Multi-line native input with centralized Windows `font-cjk` token enforcement. */
export function Textarea(props: UiTextareaProps) {
  return (
    <BaseInput
      ref={props.ref}
      multiline
      value={props.value}
      defaultValue={props.defaultValue}
      placeholder={props.placeholder}
      readonly={Boolean(props.readonly || props.disabled)}
      disabled={Boolean(props.disabled)}
      autoFocus={props.autoFocus}
      maxLength={props.maxLength}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityDescribedBy={props.accessibilityDescribedBy}
      accessibilityState={{
        disabled: Boolean(props.disabled),
        invalid: Boolean(props.invalid),
      }}
      testID={props.testID}
      submitBehavior={props.submitBehavior}
      onChange={props.onChange}
      onSubmit={props.onSubmit}
      onKeyPress={props.onKeyPress}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      class={cx(
        "min-h-20 p-2.5 text-sm rounded-(--radius) border bg-background text-foreground placeholder:text-muted-foreground",
        MOTION_CLASSES.interactiveColor,
        FOCUS_RING_CLASS,
        props.invalid ? "border-destructive" : "border-input",
        props.disabled ? "opacity-50 bg-muted" : "",
        platformInputFont(),
      )}
    />
  );
}
