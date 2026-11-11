import { useState } from 'react';
import type { RolePreset } from '../../host/conversation/catalog.ts';
import type { BotProfile } from '../../host/store/types.ts';
import { Composer } from './composer.tsx';
import './conversation.css';
import { ProfileEditor } from './profile.tsx';
import { BotRail } from './rail.tsx';
import { Transcript } from './transcript.tsx';
import { useConversation } from './use-conversation.ts';

type Editing = { readonly profile: BotProfile; readonly creating: boolean };

/** The conversation section: the Bot rail, the selected Bot's conversation and composer, and the profile editor. */
export function ConversationSection() {
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>();
  const { loaded, reload } = useConversation(selected);
  if (!loaded) return <p className="conv-muted">Loading conversations…</p>;
  const { snapshot, error } = loaded;
  const failure = error !== undefined && (
    <div className="conv-error" role="alert">Conversations unavailable: {error} <button type="button" onClick={reload}>Retry</button></div>
  );
  if (!snapshot) return failure;
  const bot = snapshot.bots.find(row => row.id === selected);
  const startNew = (role: RolePreset) => setEditing({ creating: true, profile: {
    id: crypto.randomUUID(), name: role.label, role: role.role, persona: role.persona, model: snapshot.models[0]?.id ?? '',
  } });
  return (
    <div className="conv">
      <BotRail bots={snapshot.bots} roles={snapshot.roles} selected={selected} onSelect={setSelected} onNew={startNew} />
      <section className="conv-main">
        {failure}
        {editing
          ? <ProfileEditor key={editing.profile.id} initial={editing.profile} creating={editing.creating} models={snapshot.models}
              onDone={saved => { setEditing(undefined); if (saved !== undefined) setSelected(saved); }} />
          : bot && snapshot.conversation
            ? <>
                <header className="conv-header">
                  <h1>{bot.name}</h1>
                  <span className="conv-rail-role">{bot.role}</span>
                  {!bot.archived && <button type="button" onClick={() => setEditing({ creating: false, profile: {
                    id: bot.id, name: bot.name, role: bot.role, persona: bot.persona, model: bot.model } })}>Edit profile</button>}
                </header>
                {bot.archived && <p className="conv-muted">This Bot is archived. Archiving is permanent; its conversation stays readable.</p>}
                <Transcript key={bot.id} items={snapshot.conversation.items} />
                <Composer key={bot.id} botId={bot.id} cancellable={snapshot.conversation.cancellable} disabled={bot.archived} />
              </>
            : <p className="conv-muted">{snapshot.bots.length === 0 ? 'No Bots yet. Create one with "New by role".' : 'Select a Bot.'}</p>}
      </section>
    </div>
  );
}
