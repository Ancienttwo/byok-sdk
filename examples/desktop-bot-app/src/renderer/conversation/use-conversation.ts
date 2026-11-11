import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationSnapshot } from '../../host/conversation/service.ts';

export type Loaded = { readonly snapshot: ConversationSnapshot; readonly error?: undefined } | { readonly snapshot?: ConversationSnapshot; readonly error: string };

/**
 * Reads the conversation view and keeps it current: it waits on `k8.changes` and reads again when the version moved
 * or some Bot is busy. A failed call stops the loop and shows its error; a Host state change or `reload` restarts it.
 */
export function useConversation(botId: string | null): { loaded: Loaded | undefined; reload: () => void } {
  const [loaded, setLoaded] = useState<Loaded>();
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration(value => value + 1), []);
  const last = useRef<ConversationSnapshot | undefined>(undefined);

  useEffect(() => window.byok.onStateChanged(reload), [reload]);
  useEffect(() => {
    let stopped = false;
    void (async () => {
      try {
        let snapshot = await window.byok.call('k8.view', { botId });
        while (!stopped) {
          last.current = snapshot;
          setLoaded({ snapshot });
          const { version } = await window.byok.call('k8.changes', { after: snapshot.version });
          if (stopped) return;
          if (version !== snapshot.version || snapshot.busy) snapshot = await window.byok.call('k8.view', { botId });
        }
      } catch (error) {
        if (!stopped) setLoaded({ ...(last.current ? { snapshot: last.current } : {}), error: (error as Error).message });
      }
    })();
    return () => { stopped = true; };
  }, [botId, generation]);
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
