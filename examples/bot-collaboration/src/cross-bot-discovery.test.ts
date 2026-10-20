import { afterEach, expect, it } from 'vitest';
import { openTeam, type TestTeam } from './team.test-support';
import { crossBot } from './cross-bot.test-support';

let fixture: TestTeam;
afterEach(async () => { await fixture?.close(); });
const t = crossBot(() => fixture);

it.each(['missing', 'error', 'stalled'] as const)('completes a real delegation when device discovery is %s', async mode => {
  // Fault injection is confined to discovery. Pairing, execution, reply and terminal paths stay real.
  fixture = await openTeam({ routeMessages: true, wrapServer: server => ({ ...server,
    machines: mode === 'missing' ? undefined : { list: async () => {
      if (mode === 'error') throw new Error('Discovery unavailable');
      return new Promise<never>(() => {});
    } },
  }) });
  const [b] = await t.createBots(1);
  const root = await t.host().input(`discovery-${mode}`, 'Ask another Bot');
  await t.finish(root, { delegate: [{ to: b!, request: 'Answer without discovery' }] });
  const d = t.delegationOf(t.taskOf(root));
  await t.finish(d.id);
  expect(t.delegation(d.id).verdict).toBe('answered');
  await t.finish(t.delegation(d.id).replyTurnId!);
  expect(t.events(d.id).map(event => event.status)).toEqual(['queued', 'running', 'resolved']);
  expect(Object.values(t.host().snapshot().turns).filter(turn => turn.source === 'bot_reply')).toHaveLength(1);
});
