import { useState } from 'react';
import { useCommand } from './use-conversation.ts';

/**
 * Send, cancel and clear for one Bot. A send keeps its action id until it succeeds, so a retry of the same text is the
 * same command to the Host; editing the text starts a new one.
 */
export function Composer(props: { botId: string; cancellable: readonly string[]; disabled: boolean }) {
  const [text, setText] = useState('');
  const [pending, setPending] = useState<{ actionId: string; text: string }>();
  const { busy, error, run } = useCommand();
  const send = async () => {
    const action = pending?.text === text ? pending : { actionId: crypto.randomUUID(), text };
    setPending(action);
    if (await run(() => window.byok.call('k8.send', { actionId: action.actionId, botId: props.botId, text: action.text }))) {
      setPending(undefined);
      setText('');
    }
  };
  // The oldest open Turn is the one running; later ones wait behind it.
  const current = props.cancellable[0];
  return (
    <form className="conv-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      <textarea value={text} rows={3} disabled={props.disabled} placeholder={props.disabled ? 'This Bot is archived' : 'Message'}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (text !== '' && !busy) void send(); } }} />
      {error && <p className="conv-error" role="alert">{error}</p>}
      <div className="conv-actions">
        <button type="submit" disabled={busy || props.disabled || text === ''}>Send</button>
        <button type="button" disabled={busy || current === undefined} onClick={() => void run(() => window.byok.call('k8.cancel', { turnId: current! }))}>Cancel Turn</button>
        <button type="button" disabled={busy || props.disabled}
          onClick={() => void run(() => window.byok.call('k8.clear', { actionId: crypto.randomUUID(), botId: props.botId }))}>Clear context</button>
      </div>
    </form>
  );
}
