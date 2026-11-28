import { t } from "../i18n.ts";
import { Overlay, Text, View } from "nsh";
import { Toast as BaseToast, ToastStack as BaseToastStack } from "nsh/base";
import { IconButton } from "./Button.tsx";
import { Icon } from "./Icon.tsx";
import { MOTION_CLASSES } from "./motion.ts";
import { cx, POPOVER_SURFACE_CLASS } from "./tokens.ts";

export interface ToastNotice {
  id: string;
  tone: "info" | "success" | "warning" | "danger";
  title: string | (() => string);
  description?: string | (() => string);
}

export interface UiToastProps {
  notice: ToastNotice;
  onDismiss: (id: string) => void;
}

const TONE_ICON = {
  info: "info",
  success: "check",
  warning: "alert",
  danger: "alert",
} as const;

const TONE_COLOR = {
  info: "text-primary",
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
} as const;

const resolveText = (copy: ToastNotice["description"]) => typeof copy === "function" ? copy() : copy;

/** Individual status toast notification pairing color with status icon and text. */
export function Toast(props: UiToastProps) {
  const title = () => resolveText(props.notice.title)!;
  const description = () => resolveText(props.notice.description);
  return (
    <BaseToast
      accessibilityLabel={title()}
      class={cx(
        POPOVER_SURFACE_CLASS,
        "w-80 px-4 py-3 flex-row items-start justify-between gap-3",
        MOTION_CLASSES.popupTransition,
      )}
      startingClass={MOTION_CLASSES.popupStarting}
      endingClass={MOTION_CLASSES.popupEnding}
      onDismissRequest={() => props.onDismiss(props.notice.id)}
    >
      <View class="flex-row items-start gap-2.5 flex-1">
        <Icon
          name={TONE_ICON[props.notice.tone]}
          size="md"
          class={TONE_COLOR[props.notice.tone]}
        />
        <View class="gap-0.5 flex-1">
          <Text class="text-sm font-medium text-popover-foreground">{title()}</Text>
          <If when={Boolean(description())}>
            <Text class="text-xs text-muted-foreground">{description()}</Text>
          </If>
        </View>
      </View>
      <IconButton
        icon="close"
        size="sm"
        accessibilityLabel={t("toast.dismiss", { title: title() })}
        onPress={() => props.onDismiss(props.notice.id)}
      />
    </BaseToast>
  );
}

/** Corner-anchored toast region displaying active notices. */
export function ToastRegion(props: {
  notices: ToastNotice[];
  onDismiss: (id: string) => void;
  onClearAll: () => void;
}) {
  return (
    <If when={props.notices.length > 0}>
      <Overlay class="justify-end items-end p-4 pointer-events-none">
        <BaseToastStack
          placement="bottomRight"
          class="w-80 gap-2 pointer-events-auto"
          onCancel={props.onClearAll}
        >
          <Each of={props.notices} key={(item) => item.id}>
            {(item) => <Toast notice={item()} onDismiss={props.onDismiss} />}
          </Each>
        </BaseToastStack>
      </Overlay>
    </If>
  );
}
