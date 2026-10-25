import type { ByokServer } from '@byok-sdk/server';
import { HostLedger, project } from '@byok-sdk/example-host-execution-core';
import { stateOf } from './model';
import { deviceRefusal } from './topology';
import { applyHomeTerminal, checkHomeReadback, failHomeFlush, homeEnqueued, homeHead, homeRequests, planHomeRetry, type HomeReadback } from './team';

export type HomeServer = Partial<Pick<ByokServer, 'enqueueAgentHomeProjection' | 'readAgentHomeProjection'>>;

/** Called only from the Host serial consumer. All delivery ids are durable. */
export async function flushHomes(server: HomeServer, ledger: HostLedger, now: () => number): Promise<void> {
  const busy = (botId: string) => Object.values(ledger.snapshot().intents).some(intent => !intent.conclusion
    && intent.execution.payload.agentRef.agentId === botId);
  const operation = (s: Parameters<Parameters<HostLedger['transaction']>[0]>[0], sequence: number) =>
    stateOf(s.application).team.homeOperations.find(o => o.sequence === sequence)!;
  // One snapshot of the team for the pass: each Bot flushes at most its oldest pending operation once.
  const team = stateOf(ledger.snapshot().application).team;
  for (const pending of team.homeOperations.filter(o => o.status === 'pending').sort((a, b) => a.sequence - b.sequence)) {
    const op = homeHead(team, pending.sequence, busy);
    if (!op) continue;
    try {
      if (!server.enqueueAgentHomeProjection || !server.readAgentHomeProjection) throw new Error('Home projection API required');
      // A device terminal can precede local writer cleanup. A control that
      // hits that lease stays pending until reconnect. Retry the same desired
      // revision with a new durable delivery id. Read every delivery first.
      let terminal: HomeReadback | undefined;
      for (const candidate of homeRequests(op)) {
        terminal = checkHomeReadback(candidate, await server.readAgentHomeProjection(candidate.deviceId, candidate.payload.agentRef, candidate.payload.requestId));
        if (terminal) break;
      }
      if (!terminal) {
        // #957: a device frozen for a switch, or owned by H, gets no new home write. A sent write is still read back.
        const request = ledger.transaction(s => {
          if (deviceRefusal(stateOf(s.application), op.request.deviceId)) return undefined;
          const row = operation(s, op.sequence);
          row.sent = true;
          return planHomeRetry(row, now());
        });
        if (!request) continue;
        await server.enqueueAgentHomeProjection(request);
        ledger.transaction(s => homeEnqueued(operation(s, op.sequence), now()));
        continue;
      }
      const settled = terminal;
      ledger.transaction(s => applyHomeTerminal(stateOf(s.application), operation(s, op.sequence), settled, (id, value) => project(s, id, value)));
    } catch (error) {
      ledger.transaction(s => failHomeFlush(operation(s, op.sequence), error));
    }
  }
}
