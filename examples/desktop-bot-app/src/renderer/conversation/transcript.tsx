import { useState } from 'react';
import type { ConversationItem, TurnEnd } from '../../host/conversation/view.ts';
import { useCommand } from './use-conversation.ts';

const CONCLUSION_LABEL: Record<string, string> = { failed: 'Turn failed', cancelled: 'Turn cancelled', expired: 'Turn expired', no_reply: 'Turn ended without a reply' };

function Ended({ end }: { end: TurnEnd }) {
  return (
    <div className="conv-ended" data-conclusion={end.conclusion} role="status">
      <strong>{end.backgroundUnavailable ? 'Turn failed: background Pi work is not available in this app' : CONCLUSION_LABEL[end.conclusion] ?? `Turn ended: ${end.conclusion}`}</strong>
      {end.reason !== undefined && <p>{end.reason}</p>}
    </div>
  );
}

function QuestionCard({ item }: { item: Extract<ConversationItem, { kind: 'question' }> }) {
  const [answer, setAnswer] = useState('');
  const { busy, error, run } = useCommand();
  const submit = (value: string) => void run(() => window.byok.call('k8.answer', { questionId: item.id, answer: value }));
  const { question } = item;
  return (
    <div className="conv-question">
      <p>{question.question}</p>
      {item.answer !== undefined ? <p className="conv-answer">Answered: {item.answer}</p>
        : question.answerKind === 'single_choice'
          ? <div className="conv-actions">{question.options.map(option => (
              <button key={option.id} type="button" disabled={busy} onClick={() => submit(option.id)}>{option.label}</button>
            ))}</div>
          : <form onSubmit={event => { event.preventDefault(); submit(answer); }}>
              <input value={answer} required onChange={event => setAnswer(event.target.value)} />
              <button type="submit" disabled={busy}>Answer</button>
            </form>}
      {error && <p className="conv-error" role="alert">{error}</p>}
    </div>
  );
}

function Row({ item }: { item: ConversationItem }) {
  switch (item.kind) {
    case 'input': return <div className="conv-msg" data-from="user">{item.text}</div>;
    case 'reply': return <div className="conv-msg" data-from="bot">{item.text}</div>;
    case 'clear': return <div className="conv-divider" role="separator">Context cleared: the Bot no longer sees the messages above</div>;
    case 'working': return (
      <div className="conv-working" data-blocked={item.blocked !== undefined || undefined}>
        {item.blocked !== undefined ? <strong>Waiting: {item.blocked}</strong> : <span>Working…</span>}
        {item.draft && <div className="conv-msg conv-draft" data-from="bot" title="Draft: not yet accepted">{item.draft.text}</div>}
        {item.draft?.state === 'gap' && <p className="conv-muted">Part of the draft was lost; the accepted reply will be complete.</p>}
        {item.draft?.state === 'overflow' && <p className="conv-muted">The draft is too long to show; the accepted reply will follow.</p>}
        {item.draft?.state === 'failed' && <p className="conv-error">Draft unavailable: {item.draft.error}</p>}
      </div>
    );
    case 'ended': return <Ended end={item.end} />;
    case 'question': return <QuestionCard item={item} />;
  }
}

/** The conversation; rows above the latest clear fold behind one toggle and are never removed. */
export function Transcript({ items }: { items: readonly ConversationItem[] }) {
  const [unfold, setUnfold] = useState(false);
  const folded = items.filter(item => 'folded' in item && item.folded).length;
  return (
    <div className="conv-transcript">
      {folded > 0 && <button type="button" className="conv-fold" onClick={() => setUnfold(!unfold)}>{unfold ? 'Hide' : 'Show'} {folded} earlier messages</button>}
      {items.filter(item => unfold || !('folded' in item && item.folded)).map(item => <Row key={item.key} item={item} />)}
    </div>
  );
}
