import { Text, View, type JSX } from "nsh";
import { cx } from "./tokens.ts";

export interface SurfaceProps {
  tone?: "default" | "muted";
  class?: string;
  children?: JSX.Element;
}

/** Flat contained surface using hairline borders rather than drop shadows. */
export function Surface(props: SurfaceProps) {
  return (
    <View
      class={cx(
        "rounded-(--radius) border border-border",
        props.tone === "muted" ? "bg-muted text-foreground" : "bg-card text-card-foreground",
        props.class,
      )}
    >
      {props.children}
    </View>
  );
}

export function Card(props: { class?: string; children?: JSX.Element }) {
  return <Surface class={cx("p-4 gap-3", props.class)}>{props.children}</Surface>;
}

export function CardHeader(props: { class?: string; children?: JSX.Element }) {
  return <View class={cx("gap-1", props.class)}>{props.children}</View>;
}

export function CardTitle(props: { children: string; level?: number }) {
  return (
    <Text role="header" accessibilityLevel={props.level ?? 2} class="text-sm font-semibold text-card-foreground">
      {props.children}
    </Text>
  );
}

export function CardDescription(props: { children: string }) {
  return <Text class="text-xs text-muted-foreground">{props.children}</Text>;
}

export function CardContent(props: { class?: string; children?: JSX.Element }) {
  return <View class={cx("gap-3", props.class)}>{props.children}</View>;
}

export function CardFooter(props: { class?: string; children?: JSX.Element }) {
  return <View class={cx("flex-row items-center justify-end gap-2 pt-1", props.class)}>{props.children}</View>;
}
