import { Text, View, type JSX } from "nsh";
import { Sheet as BaseSheet } from "nsh/base";
import { IconButton } from "./Button.tsx";
import { cx } from "./tokens.ts";

export interface UiSheetProps {
  open: boolean;
  title: string;
  side?: "right" | "bottom" | "left";
  testID?: string;
  onOpenChange: (open: boolean) => void;
  footer?: JSX.Element;
  children?: JSX.Element;
}

/** Edge-anchored auxiliary drawer / inspector panel. */
export function Sheet(props: UiSheetProps) {
  return (
    <BaseSheet
      testID={props.testID}
      open={props.open}
      side={props.side ?? "right"}
      closeOnEscape
      closeOnBackdropPress
      accessibilityLabel={props.title}
      backdropClass="bg-foreground/30"
      popupClass={cx(
        props.side === "bottom" ? "w-full p-5" : "w-80 h-full p-5",
        "border-l border-border bg-popover text-popover-foreground gap-4",
      )}
      onOpenChange={(e) => props.onOpenChange(e.open)}
      onCancel={() => props.onOpenChange(false)}
    >
      <View class="flex-row items-center justify-between gap-2 pb-2 border-b border-border">
        <Text role="header" accessibilityLevel={2} class="text-sm font-semibold text-popover-foreground">
          {props.title}
        </Text>
        <IconButton
          icon="close"
          size="sm"
          accessibilityLabel={`Close ${props.title}`}
          onPress={() => props.onOpenChange(false)}
        />
      </View>
      <View class="flex-1 gap-3">{props.children}</View>
      <If when={Boolean(props.footer)}>
        <View class="flex-row items-center justify-end gap-2 pt-3 border-t border-border">
          {props.footer}
        </View>
      </If>
    </BaseSheet>
  );
}
