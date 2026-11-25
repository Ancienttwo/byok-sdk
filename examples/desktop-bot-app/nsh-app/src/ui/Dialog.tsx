import { Text, View, type JSX } from "nsh";
import { AlertDialog, Dialog as BaseDialog, type AlertDialogOptions } from "nsh/base";
import { IconButton } from "./Button.tsx";
import { dialogAnimation } from "./motion.ts";
import { cx } from "./tokens.ts";

export interface UiDialogProps {
  open: boolean;
  title: string;
  description?: string;
  role?: "dialog" | "alertdialog";
  testID?: string;
  onOpenChange: (open: boolean) => void;
  footer?: JSX.Element;
  children?: JSX.Element;
}

/** Modal dialog / alert dialog supporting Escape dismissal and screen-reader focus management. */
export function Dialog(props: UiDialogProps) {
  return (
    <BaseDialog
      testID={props.testID}
      open={props.open}
      role={props.role ?? "dialog"}
      animation={dialogAnimation()}
      closeOnEscape
      closeOnBackdropPress
      accessibilityLabel={props.title}
      accessibilityDescription={props.description}
      backdropClass="bg-foreground/30 items-center justify-center p-6"
      class="w-full max-w-md rounded-(--radius) border border-border bg-popover p-5 gap-4"
      onOpenChange={(e) => props.onOpenChange(e.open)}
      onCancel={() => props.onOpenChange(false)}
    >
      <View class="gap-1">
        <View class="flex-row items-center justify-between gap-2">
          <Text role="header" accessibilityLevel={2} class="text-base font-semibold text-popover-foreground">
            {props.title}
          </Text>
          <IconButton
            icon="close"
            size="sm"
            accessibilityLabel={`Close ${props.title}`}
            onPress={() => props.onOpenChange(false)}
          />
        </View>
        <If when={Boolean(props.description)}>
          <Text class="text-xs text-muted-foreground">{props.description}</Text>
        </If>
      </View>
      <View class="gap-3">{props.children}</View>
      <If when={Boolean(props.footer)}>
        <View class="flex-row items-center justify-end gap-2 pt-2 border-t border-border">
          {props.footer}
        </View>
      </If>
    </BaseDialog>
  );
}

/** Displays a native OS alert confirmation dialog (`AlertDialog.show`). */
export function confirmAlert(options: AlertDialogOptions) {
  return AlertDialog.show(options);
}
