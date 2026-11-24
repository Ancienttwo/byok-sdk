import { Text, View, type JSX } from "nsh";
import { cx } from "./tokens.ts";

export interface FieldProps {
  label: string;
  required?: boolean;
  description?: string;
  error?: string | null;
  class?: string;
  children?: JSX.Element;
}

/** Form field wrapper keeping label, control, description, and validation aligned on one spine. */
export function Field(props: FieldProps) {
  return (
    <View class={cx("gap-1.5", props.class)}>
      <View class="flex-row items-center gap-1">
        <Text class="text-xs font-medium text-foreground">{props.label}</Text>
        <If when={props.required}>
          <Text class="text-xs font-medium text-destructive">*</Text>
        </If>
      </View>
      {props.children}
      <If when={Boolean(props.error)}>
        <View role="alert">
          <Text class="text-xs text-destructive">{props.error}</Text>
        </View>
      </If>
      <If when={Boolean(props.description) && !props.error}>
        <Text class="text-xs text-muted-foreground">{props.description}</Text>
      </If>
    </View>
  );
}
