import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiRpcClient } from '../adapters/pi/rpc-client';

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));

async function tmpWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'byok-rpc-client-test-'));
}

function makeClient(env: NodeJS.ProcessEnv, cwd: string): PiRpcClient {
  return new PiRpcClient({ command: FIXTURE_PATH, args: ['--mode', 'rpc'], cwd, env });
}

/** Drain events from a client until `predicate` matches one, or the iterable ends. Returns every event seen (including the matching one), for shape assertions. */
async function collectUntil(
  client: PiRpcClient,
  predicate: (msg: { type: string; [key: string]: unknown }) => boolean,
  maxEvents = 50,
): Promise<Array<{ type: string; [key: string]: unknown }>> {
  const seen: Array<{ type: string; [key: string]: unknown }> = [];
  for await (const event of client.events) {
    seen.push(event);
    if (predicate(event) || seen.length >= maxEvents) break;
  }
  return seen;
}

describe('PiRpcClient observability (stderr ring buffer, extension_ui_request, unmapped-frame accounting)', () => {
  const openClients: PiRpcClient[] = [];

  afterEach(() => {
    for (const client of openClients.splice(0)) client.kill();
    vi.restoreAllMocks();
  });

  it('surfaces the stderr tail in the rejection when pi exits before responding (finding #1-class failure)', async () => {
    const cwd = await tmpWorkspace();
    const client = makeClient({ ...process.env, FAKE_PI_CRASH_WITH_STDERR: 'Error: simulated crash for stderr-capture test' }, cwd);
    openClients.push(client);

    await expect(client.send({ type: 'prompt', message: 'hi' })).rejects.toThrow(
      /simulated crash for stderr-capture test/,
    );
  });

  it('includes code/signal alongside the stderr tail in the exit error', async () => {
    const cwd = await tmpWorkspace();
    const client = makeClient({ ...process.env, FAKE_PI_CRASH_WITH_STDERR: 'Error: Unknown option: --bogus' }, cwd);
    openClients.push(client);

    await expect(client.send({ type: 'prompt', message: 'hi' })).rejects.toThrow(/code=1/);
  });

  it('answers a dialog extension_ui_request with a fail-closed {cancelled:true} instead of hanging, and never enqueues it as an event', async () => {
    const cwd = await tmpWorkspace();
    const client = makeClient({ ...process.env, FAKE_PI_EXTENSION_UI_REQUEST: 'confirm' }, cwd);
    openClients.push(client);

    const response = await client.send({ type: 'prompt', message: 'hi' });
    expect(response.success).toBe(true);

    const events = await collectUntil(client, (e) => e.type === 'agent_end');

    // Never forwarded as an event — PiRpcClient answers it itself.
    expect(events.some((e) => e.type === 'extension_ui_request')).toBe(false);

    // The fixture only reaches its final text (embedding the response it
    // received) if PiRpcClient actually answered — proving the run didn't
    // hang waiting on stdin. Confirms the exact fail-closed shape too.
    const finalText = events
      .filter((e) => e.type === 'message_update')
      .map((e) => (e.assistantMessageEvent as { delta?: string } | undefined)?.delta)
      .filter((delta): delta is string => typeof delta === 'string')
      .join('');
    expect(finalText).toContain('"cancelled":true');
    expect(finalText).not.toContain('"confirmed"');
    expect(events.some((e) => e.type === 'agent_end')).toBe(true);
  });

  it('answers a select-style dialog request the same fail-closed way', async () => {
    const cwd = await tmpWorkspace();
    const client = makeClient({ ...process.env, FAKE_PI_EXTENSION_UI_REQUEST: 'select' }, cwd);
    openClients.push(client);

    await client.send({ type: 'prompt', message: 'hi' });
    const events = await collectUntil(client, (e) => e.type === 'agent_end');
    expect(events.some((e) => e.type === 'extension_ui_request')).toBe(false);
    expect(events.some((e) => e.type === 'agent_end')).toBe(true);
  });

  it('logs an unmapped frame type once per type, not once per occurrence', async () => {
    const cwd = await tmpWorkspace();
    const client = makeClient(process.env, cwd);
    openClients.push(client);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    client.recordUnmappedFrame('totally_novel_event_type');
    client.recordUnmappedFrame('totally_novel_event_type');
    client.recordUnmappedFrame('totally_novel_event_type');
    client.recordUnmappedFrame('another_novel_type');

    const novelWarnings = warnSpy.mock.calls.filter((call) => String(call[0]).includes('totally_novel_event_type'));
    expect(novelWarnings).toHaveLength(1);
    const otherWarnings = warnSpy.mock.calls.filter((call) => String(call[0]).includes('another_novel_type'));
    expect(otherWarnings).toHaveLength(1);
  });

  it('folds accumulated unmapped-frame counts into a later exit error', async () => {
    const cwd = await tmpWorkspace();
    const client = makeClient({ ...process.env, FAKE_PI_CRASH_WITH_STDERR: 'boom' }, cwd);
    openClients.push(client);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    client.recordUnmappedFrame('mystery_type');
    await expect(client.send({ type: 'prompt', message: 'hi' })).rejects.toThrow(/mystery_type×1/);
  });
});
