import { useState } from 'react';
import type { BotProfile } from '../../host/store/types.ts';
import { useCommand } from './use-conversation.ts';

/**
 * Creates or edits a Bot. Archive is irreversible (K8 never takes an archived Bot back), so it asks once more and says so;
 * the Bot's home and transcript stay.
 */
export function ProfileEditor(props: {
  initial: BotProfile; creating: boolean; models: readonly { id: string; label: string }[]; onDone: (saved: string | undefined) => void;
}) {
  const [profile, setProfile] = useState(props.initial);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const { busy, error, run } = useCommand();
  const field = (name: 'name' | 'role' | 'persona') => ({
    value: profile[name], onChange: (event: { target: { value: string } }) => setProfile({ ...profile, [name]: event.target.value }),
  });
  const save = async () => {
    if (await run(() => window.byok.call('k8.saveBot', profile))) props.onDone(profile.id);
  };
  const archive = async () => {
    if (await run(() => window.byok.call('k8.archiveBot', { id: profile.id }))) props.onDone(profile.id);
  };
  return (
    <form className="conv-profile" onSubmit={event => { event.preventDefault(); void save(); }}>
      <h2>{props.creating ? 'New Bot' : 'Edit profile'}</h2>
      <label>Name <input required {...field('name')} /></label>
      <label>Role <input required {...field('role')} /></label>
      <label>Persona <textarea required rows={4} {...field('persona')} /></label>
      <label>Model
        <select value={profile.model} onChange={event => setProfile({ ...profile, model: event.target.value })}>
          {props.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select>
      </label>
      {error && <p className="conv-error" role="alert">{error}</p>}
      <div className="conv-actions">
        <button type="submit" disabled={busy}>Save</button>
        <button type="button" disabled={busy} onClick={() => props.onDone(undefined)}>Close</button>
        {!props.creating && !confirmArchive && <button type="button" disabled={busy} onClick={() => setConfirmArchive(true)}>Archive…</button>}
      </div>
      {confirmArchive && (
        <div className="conv-archive" role="alertdialog" aria-label="Archive Bot">
          <p>Archiving is permanent: this Bot takes no new work and cannot be restored. Its conversation and home stay readable.</p>
          <button type="button" className="conv-danger" disabled={busy} onClick={() => void archive()}>Archive permanently</button>
          <button type="button" disabled={busy} onClick={() => setConfirmArchive(false)}>Keep Bot</button>
        </div>
      )}
    </form>
  );
}
