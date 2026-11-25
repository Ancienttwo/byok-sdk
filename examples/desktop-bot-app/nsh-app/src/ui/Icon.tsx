import { Text, View } from "nsh";
import { cx } from "./tokens.ts";

export type IconName =
  | "chevronRight"
  | "chevronDown"
  | "check"
  | "minus"
  | "close"
  | "alert"
  | "info"
  | "refresh"
  | "key"
  | "quit"
  | "external"
  | "sun"
  | "moon"
  | "monitor"
  | "menu"
  | "plus"
  | "spinner";

export type IconSize = "sm" | "md" | "lg";

const GLYPHS: Readonly<Record<IconName, string>> = {
  chevronRight: "▸",
  chevronDown: "▾",
  check: "✓",
  minus: "−",
  close: "×",
  alert: "▲",
  info: "ℹ",
  refresh: "↻",
  key: "◈",
  quit: "⏻",
  external: "↗",
  sun: "☀",
  moon: "☾",
  monitor: "▣",
  menu: "☰",
  plus: "+",
  spinner: "◌",
};

const BOX_CLASSES: Readonly<Record<IconSize, string>> = {
  sm: "w-3.5 h-3.5",
  md: "w-4 h-4",
  lg: "w-5 h-5",
};

const TEXT_CLASSES: Readonly<Record<IconSize, string>> = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-base",
};

export interface IconProps {
  name: IconName;
  size?: IconSize;
  accessibilityLabel?: string;
  class?: string;
}

/** Fixed-slot glyph container keeping button/row baselines aligned regardless of glyph width. */
export function Icon(props: IconProps) {
  const size = () => props.size ?? "md";
  return (
    <View
      accessible={Boolean(props.accessibilityLabel)}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityElementsHidden={!props.accessibilityLabel}
      class={cx("items-center justify-center shrink-0", BOX_CLASSES[size()])}
    >
      <Text class={cx("font-medium leading-none", TEXT_CLASSES[size()], props.class)}>
        {GLYPHS[props.name]}
      </Text>
    </View>
  );
}
