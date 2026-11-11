import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationSnapshot } from '../../host/conversation/service.ts';

export type Loaded = { readonly snapshot: ConversationSnapshot; readonly error?: undefined } | { readonly snapshot?: ConversationSnapshot; readonly error: string };

/** How soon the view is read again while some Bot is busy: a runtime or profile catching up reaches no Host hint. */
const BUSY_REREAD_MS = 1500;

/**
 * Reads the conversation view, and again on every Host state hint (the Host pushes one when the view changed) and,
 * while some Bot is busy, after {@link BUSY_REREAD_MS}. A failed read shows its error over the last view; the next
 * hint or `reload` reads again.
 */
export function useConversation(botId: string | null): { loaded: Loaded | undefined; reload: () => void } {
  const [loaded, setLoaded] = useState<Loaded>();
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration(value => value + 1), []);
  const last = useRef<ConversationSnapshot | undefined>(undefined);

  useEffect(() => window.byok.onStateChanged(reload), [reload]);
  useEffect(() => {
    let stopped = false;
    let again: ReturnType<typeof setTimeout> | undefined;
    window.byok.call('k8.view', { botId }).then(snapshot => {
      if (stopped) return;
      last.current = snapshot;
      setLoaded({ snapshot });
      if (snapshot.busy) again = setTimeout(reload, BUSY_REREAD_MS);
    }, (error: Error) => {
      if (!stopped) setLoaded({ ...(last.current ? { snapshot: last.current } : {}), error: error.message });
    });
    return () => {
      stopped = true;
      clearTimeout(again);
    };
  }, [botId, generation, reload]);
  return { loaded, reload };
}

/** Runs one bridge command; its failure is shown by the caller, never dropped. */
export function useCommand(): { busy: boolean; error: string | undefined; run: (command: () => Promise<unknown>) => Promise<boolean> } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = useCallback(async (command: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await command();
      return true;
    } catch (cause) {
      setError((cause as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}
