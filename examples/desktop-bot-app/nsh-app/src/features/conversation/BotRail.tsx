import { signal, View } from "nsh";
import type { RolePreset } from "../../../../src/host/conversation/catalog.ts";
import type { BotState, BotView } from "../../../../src/host/conversation/view.ts";
import { Badge, Button, Disclosure, ListItem, type BadgeVariant } from "../../ui/index.ts";

/** Each rail state as label, symbol and tone: the state never relies on color alone. */
const STATE_META: Readonly<Record<BotState, { label: string; symbol: string; variant: BadgeVariant }>> = {
  idle: { label: "Idle", symbol: "○", variant: "neutral" },
  working: { label: "Working", symbol: "◐", variant: "primary" },
  waiting: { label: "Waiting for you", symbol: "?", variant: "warning" },
  profile_updating: { label: "Profile updating", symbol: "↻", variant: "neutral" },
  runtime_unavailable: { label: "Runtime unavailable", symbol: "▲", variant: "danger" },
  archived: { label: "Archived", symbol: "■", variant: "neutral" },
};

export interface BotRailProps {
  bots: readonly BotView[];
  roles: readonly RolePreset[];
  selected: string | null;
  onSelect: (id: string) => void;
  onNew: (role: RolePreset) => void;
}

/** The Bots with their state, and "New by role". */
export function BotRail(props: BotRailProps) {
  const newOpen = signal(false);
  return (
    <View role="navigation" accessibilityLabel="Bots" class="w-56 gap-3">
      <View role="list" class="gap-0.5">
        <Each of={props.bots} key={(bot) => bot.id}>
          {(bot) => (
            <ListItem
              testID={`conv-bot-${bot().id}`}
              title={bot().name}
              description={bot().reason === undefined ? bot().role : `${bot().role} · ${bot().reason}`}
              selected={bot().id === props.selected}
              accessibilityLabel={`${bot().name}, ${bot().role}, ${STATE_META[bot().state].label}${
                bot().reason === undefined ? "" : `: ${bot().reason}`
              }`}
              trailing={
                <Badge
                  testID={`conv-bot-${bot().id}-state`}
                  variant={STATE_META[bot().state].variant}
                  symbol={STATE_META[bot().state].symbol}
                  label={STATE_META[bot().state].label}
                />
              }
              onPress={() => props.onSelect(bot().id)}
            />
          )}
        </Each>
      </View>
      <Disclosure testID="conv-new-by-role" open={newOpen()} title="New by role" onToggle={(next) => newOpen.set(next)}>
        <Each of={props.roles} key={(role) => role.id}>
          {(role) => (
            <Button
              testID={`conv-new-${role().id}`}
              variant="ghost"
              size="sm"
              onPress={() => props.onNew(role())}
            >
              {role().label}
            </Button>
          )}
        </Each>
      </Disclosure>
    </View>
  );
}
