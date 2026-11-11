import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivityCard } from '../../host/activity/cards.ts';
import { ActivityCardView } from './activity-card.tsx';

/**
 * The tasks the Host follows, newest first. The section pulls the cards once and again after every coalesced Host
 * hint; a refused pull shows its error instead of the last cards.
 */
export function CardsSection() {
  const [cards, setCards] = useState<ActivityCard[]>();
  const [error, setError] = useState<string>();
  // Only the latest pull may land: an earlier, slower reply would show older cards.
  const latest = useRef(0);
  const load = useCallback(() => {
    const pull = ++latest.current;
    window.byok.call('activity.cards', undefined).then(
      next => { if (pull === latest.current) { setCards(next); setError(undefined); } },
      (failure: Error) => { if (pull === latest.current) setError(failure.message); },
    );
  }, []);
  useEffect(() => {
    load();
    return window.byok.onStateChanged(load);
  }, [load]);
  return (
    <section>
      <h1>Activity</h1>
      {error !== undefined && <p className="activity-error">Activity unavailable: {error}</p>}
      {error === undefined && cards?.length === 0 && <p className="activity-muted">No tasks since the Host started.</p>}
      {error === undefined && cards?.map(card => (
        <div key={card.taskId} className="activity-task">
          <h2>{card.taskId}</h2>
          <ActivityCardView card={card} onDecided={load} />
        </div>
      ))}
    </section>
  );
}
