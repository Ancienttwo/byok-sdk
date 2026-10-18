import type { ByokServer } from '@byok-sdk/server';
import { HostLedger } from '../../host-execution-core/src/ledger';
import { stateOf } from './model';
import { projectionRequestId, same } from './team';

export type HomeServer = Partial<Pick<ByokServer, 'enqueueAgentHomeProjection' | 'readAgentHomeProjection'>>;

/** Called only from the Host serial consumer. All delivery ids are durable. */
export async function flushHomes(server: HomeServer, ledger: HostLedger, now: () => number): Promise<void> {
  const blocked = new Set<string>();
  for (const op of stateOf(ledger.snapshot().application).team.homeOperations.filter(o => o.status === 'pending').sort((a, b) => a.sequence - b.sequence)) {
    if (blocked.has(op.botId)) continue;
    blocked.add(op.botId);
    if (Object.values(ledger.snapshot().intents).some(intent => !intent.conclusion
      && intent.execution.payload.agentRef.agentId === op.botId)) continue;
    try {
      if (!server.enqueueAgentHomeProjection || !server.readAgentHomeProjection) throw new Error('Home projection API required');
      let request = op.retries.at(-1) ?? op.request;
      // A device terminal can precede local writer cleanup. A control that
      // hits that lease stays pending until reconnect. Retry the same desired
      // revision with a new durable delivery id. Read every delivery first.
      const requests = [op.request, ...op.retries];
      let terminal: Awaited<ReturnType<ByokServer['readAgentHomeProjection']>>;
      for (const candidate of requests) {
        const payload = candidate.payload;
        const read = await server.readAgentHomeProjection(candidate.deviceId, payload.agentRef, payload.requestId);
        if (!read) continue;
        if (read.deviceId !== candidate.deviceId || !same(read.agentRef, payload.agentRef)
          || read.requestId !== payload.requestId || read.projectionHash !== payload.projectionHash) throw new Error('Home readback identity conflict');
        if (read.status !== 'pending') { terminal = read; break; }
      }
      if (!terminal) {
        if (op.retryAt !== undefined && now() >= op.retryAt) {
          request = ledger.transaction(s => {
            const row = stateOf(s.application).team.homeOperations.find(o => o.sequence === op.sequence)!;
            const retry = structuredClone(row.request);
            retry.payload.requestId = projectionRequestId([row.request.payload.requestId, row.retries.length + 1]);
            row.retries.push(retry);
            row.retryAt = now() + Math.min(60_000, 1000 * 2 ** Math.min(row.retries.length, 6));
            return retry;
          });
        }
        await server.enqueueAgentHomeProjection(request);
        ledger.transaction(s => {
          const row = stateOf(s.application).team.homeOperations.find(o => o.sequence === op.sequence)!;
          row.retryAt ??= now() + 1000;
        });
        continue;
      }
      ledger.transaction(s => {
        const state = stateOf(s.application), row = state.team.homeOperations.find(o => o.sequence === op.sequence)!;
        if (terminal.status === 'applied' || terminal.status === 'idempotent') {
          row.status = 'applied';
          const bot = state.team.bots[op.botId]!;
          if (bot.revision === op.request.payload.agentRef.profileRevision) bot.readyRevision = bot.revision;
        } else { row.status = 'failed'; row.error = terminal.status; }
      });
    } catch (error) {
      ledger.transaction(s => { stateOf(s.application).team.homeOperations.find(o => o.sequence === op.sequence)!.error = String(error instanceof Error ? error.message : error); });
    }
  }
}
