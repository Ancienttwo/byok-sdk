import { useState } from 'react';
import type { ApprovalProjectionItem, TimelineItem } from '@byok-sdk/ui-runtime';
import type { ActivityCard } from '../../host/activity/cards.ts';
import './cards.css';

function summaryLine({ summary }: ActivityCard): string {
  const parts = [`${summary.tools} tool${summary.tools === 1 ? '' : 's'}`];
  if (summary.activeTool !== undefined) parts.push(`running ${summary.activeTool}`);
  if (summary.failures > 0) parts.push(`${summary.failures} failed`);
  if (summary.pendingApprovals > 0) parts.push(`${summary.pendingApprovals} waiting for you`);
  return parts.join(' · ');
}

function itemText(item: TimelineItem): string {
  switch (item.kind) {
    case 'text-activity': return item.fragments.map(fragment => fragment.text).join('');
    case 'tool': return `${item.tool}: ${item.state}`;
    case 'artifact': return `Artifact ${item.name} (${item.contentType})`;
    case 'usage': return `Usage: ${item.totalTokens ?? '?'} tokens`;
    case 'error': return `Error: ${item.message}`;
    case 'boundary': return '—';
    case 'unknown': return `Unrecognized event ${item.eventType}`;
  }
}

/** One approval. Only a pending request that names its approval id can be answered: the decision targets exactly it. */
function Approval({ taskId, item, onDecided }: { taskId: string; item: ApprovalProjectionItem; onDecided: () => void }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const decide = (method: 'activity.approve' | 'activity.reject') => {
    if (item.approvalId === undefined) return;
    setBusy(true);
    setError(undefined);
    window.byok.call(method, { taskId, approvalId: item.approvalId }).then(onDecided, (failure: Error) => setError(failure.message))
      .finally(() => setBusy(false));
  };
  return (
    <li className="activity-approval" data-status={item.status}>
      <span>{item.summary ?? 'Approval request'}: {item.status}{item.resolvedBy ? ` (by ${item.resolvedBy})` : ''}</span>
      {item.status === 'pending' && (item.approvalId === undefined
        ? <span className="activity-error">This request has no approval id and cannot be answered here.</span>
        : (
          <span className="activity-actions">
            <button type="button" disabled={busy} onClick={() => decide('activity.approve')}>Approve</button>
            <button type="button" disabled={busy} onClick={() => decide('activity.reject')}>Reject</button>
          </span>
        ))}
      {error !== undefined && <span className="activity-error">{error}</span>}
    </li>
  );
}

/**
 * One task's collapsed activity card; it expands to the ui-runtime timeline. Approval requests stay outside the
 * collapsed part so a pending one is always in view. `onDecided` runs after an approve or reject was accepted.
 */
export function ActivityCardView({ card, onDecided }: { card: ActivityCard; onDecided: () => void }) {
  const lost = (card.timeline?.dropped ?? 0) + (card.timeline?.gaps.reduce((sum, gap) => sum + gap.missing, 0) ?? 0);
  return (
    <article className="activity-card">
      <details>
        <summary>{summaryLine(card)}</summary>
        {card.timeline === null
          ? <p className="activity-muted">No activity retained for this task.</p>
          : (
            <ol className="activity-timeline">
              {card.timeline.items.map(item => <li key={`${item.orderKey.revision}:${item.orderKey.offset}`} data-kind={item.kind}>{itemText(item)}</li>)}
            </ol>
          )}
        {lost > 0 && <p className="activity-muted">{lost} earlier events are no longer retained.</p>}
      </details>
      {card.approvals !== null && card.approvals.items.length > 0 && (
        <ul className="activity-approvals">
          {card.approvals.items.map(item => <Approval key={item.firstRevision} taskId={card.taskId} item={item} onDecided={onDecided} />)}
        </ul>
      )}
    </article>
  );
}
