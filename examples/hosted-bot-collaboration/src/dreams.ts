import type { PoolClient } from 'pg';
import { type DreamSync, syncDreams } from '@byok-sdk/bot-collaboration/host-kit';
import { cancelIntent, freezeIntent } from './intents';
import type { RoutineSlice } from './routines';

/** Persist K8's dream decisions in the scope transaction; every dreaming rule remains in K8. */
export async function syncDreamSlice(client: PoolClient, scope: string, slice: RoutineSlice, options: DreamSync): Promise<boolean> {
  const before = new Map(Object.entries(slice.state.intents).map(([id, intent]) => [id, intent.cancelReason]));
  let changed = syncDreams(slice.state, options);
  for (const [id, intent] of Object.entries(slice.state.intents)) {
    if (!before.has(id)) {
      await freezeIntent(client, scope, { key: intent.key, source: 'routine', execution: intent.execution, waitUntil: intent.waitUntil },
        { ...(intent.retryUntil === undefined ? {} : { retryUntil: intent.retryUntil }), ...(intent.conclusion ? { conclusion: intent.conclusion } : {}) });
    } else if (intent.cancelReason && !before.get(id) && !intent.conclusion) {
      if (await cancelIntent(client, scope, intent.key, options.now)) {
        intent.conclusion = 'cancelled';
        intent.phase = 'settled';
        changed = true;
      }
    }
  }
  return changed;
}
