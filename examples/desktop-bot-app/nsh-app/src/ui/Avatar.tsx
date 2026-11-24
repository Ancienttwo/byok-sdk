import { Avatar as BaseAvatar } from "nsh/base";
import { cx } from "./tokens.ts";

export interface UiAvatarProps {
  name: string;
  src?: string | null;
  size?: "sm" | "md" | "lg";
  accessibilityLabel?: string;
}

const SIZE_CLASSES = {
  sm: "w-6 h-6",
  md: "w-8 h-8",
  lg: "w-10 h-10",
} as const;

/** Compact user/bot avatar with semantic initials fallback. */
export function Avatar(props: UiAvatarProps) {
  const size = () => props.size ?? "md";
  return (
    <BaseAvatar
      name={props.name}
      src={props.src}
      accessibilityLabel={props.accessibilityLabel ?? props.name}
      class={cx("rounded-full overflow-hidden border border-border", SIZE_CLASSES[size()])}
      fallbackClass="bg-muted text-muted-foreground items-center justify-center text-xs font-medium"
      imageClass="w-full h-full object-cover"
    />
  );
}
