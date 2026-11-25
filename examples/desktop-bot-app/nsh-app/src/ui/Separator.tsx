import { View } from "nsh";
import { cx } from "./tokens.ts";

export function Separator(props: { orientation?: "horizontal" | "vertical"; class?: string }) {
  return (
    <View
      class={cx(
        "bg-border shrink-0",
        props.orientation === "vertical" ? "w-px h-full" : "h-px w-full",
        props.class,
      )}
    />
  );
}
