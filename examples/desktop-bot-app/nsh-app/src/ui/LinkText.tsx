import { Text, View } from "nsh";
import { Icon } from "./Icon.tsx";
import { cx, FOCUS_RING_CLASS } from "./tokens.ts";

export interface LinkTextProps {
  label: string;
  href: string;
  testID?: string;
  onOpen: (href: string) => void;
}

/** Explicit external URL link (the only control allowed `cursor-pointer`). */
export function LinkText(props: LinkTextProps) {
  return (
    <View
      testID={props.testID}
      accessible
      role="link"
      focusable
      accessibilityLabel={props.label}
      accessibilityHint={`Opens ${props.href}`}
      onPress={() => props.onOpen(props.href)}
      class={cx(
        "flex-row items-center gap-1 rounded-sm cursor-pointer hover:opacity-80",
        FOCUS_RING_CLASS,
      )}
    >
      <Text class="text-sm text-primary underline">{props.label}</Text>
      <Icon name="external" size="sm" class="text-primary" />
    </View>
  );
}
