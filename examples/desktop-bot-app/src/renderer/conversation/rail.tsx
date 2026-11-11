import type { BotState, BotView } from '../../host/conversation/view.ts';
import type { RolePreset } from '../../host/conversation/catalog.ts';

const STATE_LABEL: Record<BotState, string> = {
  idle: 'Idle', working: 'Working', waiting: 'Waiting for you', profile_updating: 'Profile updating',
  runtime_unavailable: 'Runtime unavailable', archived: 'Archived',
};

export function BotRail(props: {
  bots: readonly BotView[]; roles: readonly RolePreset[]; selected: string | null;
  onSelect: (id: string) => void; onNew: (role: RolePreset) => void;
}) {
  return (
    <aside className="conv-rail">
      <ul>
        {props.bots.map(bot => (
          <li key={bot.id}>
            <button type="button" aria-current={bot.id === props.selected ? 'true' : undefined} onClick={() => props.onSelect(bot.id)}>
              <span className="conv-rail-name">{bot.name}</span>
              <span className="conv-rail-role">{bot.role}</span>
              <span className="conv-state" data-state={bot.state} title={bot.reason}>{STATE_LABEL[bot.state]}</span>
            </button>
          </li>
        ))}
      </ul>
      <details className="conv-new">
        <summary>New by role</summary>
        {props.roles.map(role => (
          <button key={role.id} type="button" onClick={() => props.onNew(role)}>{role.label}</button>
        ))}
      </details>
    </aside>
  );
}
