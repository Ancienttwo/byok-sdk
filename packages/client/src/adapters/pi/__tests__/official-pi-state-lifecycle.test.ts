import { expect, it } from 'vitest';
import { createOfficialSession, installGlobalFetchSpy, textResponse } from './official-pi-fixture';

it('official 1.1 session reports normal, aborted, then normal settlements without stale abort state', async () => {
  const network = installGlobalFetchSpy();
  let entered!: () => void;
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  let block = false;
  const harness = await createOfficialSession({ transcript: () => [], gate: () => {
    if (!block) return textResponse('synthetic completion', true);
    entered();
    return new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const settlements: boolean[] = [];
  const unsubscribe = harness.session.subscribe(event => {
    if (event.type === 'agent_settled') settlements.push(event.aborted);
  });
  try {
    await harness.session.prompt('complete'); await harness.session.waitForIdle();
    expect(settlements).toEqual([false]);
    block = true;
    const run = harness.session.prompt('abort');
    await blocked;
    await harness.session.abort(); await run; await harness.session.waitForIdle();
    expect(settlements).toEqual([false, true]);
    block = false;
    await harness.session.prompt('complete after abort'); await harness.session.waitForIdle();
    expect(settlements).toEqual([false, true, false]);
    expect(network.calls).toEqual([]);
  } finally { unsubscribe(); harness.dispose(); network.restore(); }
}, 10_000);

it('settles once only after queued follow-up work drains', async () => {
  const network = installGlobalFetchSpy();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let entered!: () => void;
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  const harness = await createOfficialSession({ transcript: () => [], gate: sequence => {
    if (sequence !== 1) return textResponse('queued completion', true);
    return new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; entered(); } }), {
      headers: { 'content-type': 'text/event-stream' },
    });
  } });
  const boundaries: string[] = [];
  const unsubscribe = harness.session.subscribe(event => {
    if (event.type === 'agent_end' || event.type === 'agent_settled') boundaries.push(event.type);
    if (event.type === 'agent_settled') expect(event.aborted).toBe(false);
  });
  try {
    const run = harness.session.prompt('initial'); await blocked;
    await harness.session.followUp('queued');
    expect(boundaries).toEqual([]);
    controller.enqueue(new Uint8Array(await textResponse('initial completion', true).arrayBuffer())); controller.close();
    await run; await harness.session.waitForIdle();
    expect(harness.sends).toHaveLength(2);
    // Native Agent drains queued follow-ups within the same low-level run.
    expect(boundaries.filter(type => type === 'agent_end')).toHaveLength(1);
    expect(boundaries.filter(type => type === 'agent_settled')).toHaveLength(1);
    expect(boundaries.at(-1)).toBe('agent_settled');
    expect(network.calls).toEqual([]);
  } finally { unsubscribe(); harness.dispose(); network.restore(); }
}, 10_000);
