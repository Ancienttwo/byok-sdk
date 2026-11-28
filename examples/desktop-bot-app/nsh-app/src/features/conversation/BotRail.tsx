import { rolePreset } from "../../../../brand.config.ts";
import { appLocale, t } from "../../i18n.ts";
import { failureText } from "../../statusCopy.ts";
import { signal, View } from "nsh";
import type { RolePreset } from "../../../../src/host/conversation/catalog.ts";
import type { BotState, BotView } from "../../../../src/host/conversation/view.ts";
import { Badge, Button, Disclosure, ListItem, type BadgeVariant } from "../../ui/index.ts";

/** Each rail state as label, symbol and tone: the state never relies on color alone. */
const STATE_META: Readonly<Record<BotState, { symbol: string; variant: BadgeVariant }>> = {
  idle: { symbol: "○", variant: "neutral" },
  working: { symbol: "◐", variant: "primary" },
  waiting: { symbol: "?", variant: "warning" },
  profile_updating: { symbol: "↻", variant: "neutral" },
  runtime_unavailable: { symbol: "▲", variant: "danger" },
  archived: { symbol: "■", variant: "neutral" },
};

export interface BotRailProps {
  bots: readonly BotView[];
  roles: readonly RolePreset[];
  selected: string | null;
  onSelect: (id: string) => void;
  onNew: (role: RolePreset) => void;
}

/** The Bots with their state, and t("conversation.newByRole"). */
export function BotRail(props: BotRailProps) {
  const newOpen = signal(false);
  return (
    <View role="navigation" accessibilityLabel={t("conversation.bots")} class="basis-1/3 min-w-0 max-w-xs gap-3">
      <View role="list" class="gap-0.5">
        <Each of={props.bots} key={(bot) => bot.id}>
          {(bot) => (
            <ListItem
              testID={`conv-bot-${bot().id}`}
              title={bot().name}
              description={[bot().role, failureText(bot().reason)].filter(Boolean).join(" · ")}
              selected={bot().id === props.selected}
              accessibilityLabel={t("conversation.botLabel", { name: bot().name, role: bot().role, status: t(`conversation.state.${bot().state}`) })}
              trailing={
                <Badge
                  testID={`conv-bot-${bot().id}-state`}
                  variant={STATE_META[bot().state].variant}
                  symbol={STATE_META[bot().state].symbol}
                  label={t(`conversation.state.${bot().state}`)}
                />
              }
              onPress={() => props.onSelect(bot().id)}
            />
          )}
        </Each>
      </View>
      <Disclosure testID="conv-new-by-role" open={newOpen()} title={t("conversation.newByRole")} onToggle={(next) => newOpen.set(next)}>
        <Each of={props.roles} key={(role) => role.id}>
          {(role) => (
            <Button
              testID={`conv-new-${role().id}`}
              variant="ghost"
              size="sm"
              onPress={() => props.onNew(role())}
            >
              {rolePreset(role().id, appLocale()).label}
            </Button>
          )}
        </Each>
      </Disclosure>
    </View>
  );
}
