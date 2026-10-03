import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import type { AgentEvent, Envelope } from '@byok-sdk/protocol';
import type { Session } from '../../types';

interface TimingEvent {
  seq: number;
  ns: string;
  wallMs: number;
  event: string;
  detail?: unknown;
}

/** Read-only observations at the actual transport, timer and Session boundaries. */
export function cancellationTiming(runtime: string, scenario: string) {
  const events: TimingEvent[] = [];
  const listeners = new Set<(event: TimingEvent) => void>();
  const record = (event: string, detail?: unknown) => {
    const entry = { seq: events.length, ns: process.hrtime.bigint().toString(), wallMs: Date.now(), event, detail };
    events.push(entry);
    for (const listener of listeners) listener(entry);
  };
  const waitFor = (predicate: (event: TimingEvent) => boolean): Promise<TimingEvent> => {
    const found = events.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise(resolve => {
      const listener = (event: TimingEvent) => {
        if (predicate(event)) { listeners.delete(listener); resolve(event); }
      };
      listeners.add(listener);
    });
  };
  const spawnFn = new Proxy(spawn, {
    apply(target, receiver, args) {
      const child = Reflect.apply(target, receiver, args) as ChildProcessWithoutNullStreams;
      record('process.spawn', { pid: child.pid });
      const interrupts = new Set<unknown>();
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = new Proxy(write, {
        apply(sender, receiver, args) {
          try {
            const frame = JSON.parse(String(args[0])) as { id?: unknown; method?: string; type?: string; request?: { subtype?: string } };
            if (frame.method === 'turn/interrupt' || frame.type === 'abort' || frame.request?.subtype === 'interrupt') {
              interrupts.add(frame.id);
              record('interrupt.write', { id: frame.id, method: frame.method ?? frame.type });
            }
          } catch { /* No alteration of framing or transport behavior. */ }
          return Reflect.apply(sender, receiver, args);
        },
      });
      let buffered = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf8');
        let newline: number;
        while ((newline = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
          try {
            const frame = JSON.parse(line) as { id?: unknown; method?: string; params?: unknown; type?: string; command?: string; response?: unknown; usage?: unknown };
            if (frame.method === 'thread/tokenUsage/updated' || frame.method === 'turn/completed') {
              record('native.receive', { method: frame.method, params: frame.params });
            } else if ((frame.id !== undefined && interrupts.has(frame.id)) ||
                frame.type === 'control_response' || (frame.type === 'response' && frame.command === 'abort')) {
              record('ack.receive', frame);
            } else if (frame.type === 'result' || frame.type === 'agent_settled' || frame.type === 'message_end') {
              record('native.receive', { type: frame.type, usage: frame.usage });
            }
          } catch { /* Observe complete native lines only. */ }
        }
      });
      child.once('close', (code, signal) => record('process.close', { pid: child.pid, code, signal }));
      return child;
    },
  });

  let stopTimers = () => {};
  const observeTimers = () => {
    stopTimers();
    const timers = new Map<unknown, { id: number; ms: number; source: string | undefined }>();
    let nextId = 0;
    const originalSet = globalThis.setTimeout;
    const originalClear = globalThis.clearTimeout;
    globalThis.setTimeout = new Proxy(originalSet, {
      apply(target, receiver, args) {
        const [callback, ms, ...rest] = args;
        if (ms !== 60 && ms !== 100) return Reflect.apply(target, receiver, args);
        const source = new Error().stack?.split('\n').find(line => line.includes('task-runner.ts') || line.includes('codex-adapter.ts') || line.includes('control-channel.ts'))?.trim();
        const timer = { id: nextId++, ms, source };
        record('deadline.arm', timer);
        const handle = Reflect.apply(target, receiver, [function (this: unknown) {
          record('deadline.fire', timer);
          Reflect.apply(callback, this, rest);
        }, ms]);
        timers.set(handle, timer);
        return handle;
      },
    });
    globalThis.clearTimeout = new Proxy(originalClear, {
      apply(target, receiver, args) {
        const timer = timers.get(args[0]);
        if (timer) { record('deadline.clear', timer); timers.delete(args[0]); }
        return Reflect.apply(target, receiver, args);
      },
    });
    stopTimers = () => {
      globalThis.setTimeout = originalSet;
      globalThis.clearTimeout = originalClear;
      stopTimers = () => {};
    };
  };

  const observeSession = (session: Session, beforeDisposal: () => void) => {
    const interrupt = session.interrupt.bind(session);
    const close = session.close.bind(session);
    vi.spyOn(session, 'interrupt').mockImplementation(async () => {
      record('interrupt.enter');
      try { await interrupt(); record('interrupt.settled'); }
      catch (error) { record('interrupt.rejected', String(error)); throw error; }
    });
    vi.spyOn(session, 'close').mockImplementation(async () => {
      record('disposal.enter');
      beforeDisposal();
      try { await close(); record('disposal.settled'); }
      catch (error) { record('disposal.rejected', String(error)); throw error; }
    });
    const getter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(session), 'events')!.get!;
    vi.spyOn(session, 'events', 'get').mockImplementation(() => {
      const iterable = Reflect.apply(getter, session, []) as AsyncIterable<AgentEvent>;
      return {
        [Symbol.asyncIterator]() {
          const inner = iterable[Symbol.asyncIterator]();
          return {
            async next() {
              const result = await inner.next();
              if (!result.done && ['usage', 'turn_end', 'tool_use', 'tool_result', 'progress'].includes(result.value.type)) record('agent.yield', result.value);
              return result;
            },
            return: inner.return?.bind(inner),
          };
        },
      };
    });
  };
  const observeTerminal = (envelope: Envelope) => {
    if (['task.cancelled', 'task.fail', 'task.complete'].includes(envelope.type)) record('terminal.publish', { type: envelope.type, payload: envelope.payload });
  };
  const save = async (dir: string, childTrace: string | undefined, test: string | undefined) => {
    const output = process.env.T1_TIMING_EVIDENCE_DIR;
    if (!output) return;
    await fs.mkdir(output, { recursive: true });
    const native = childTrace === undefined ? '' : await fs.readFile(childTrace, 'utf8').catch(() => '');
    await fs.writeFile(path.join(output, `${path.basename(dir)}.json`), JSON.stringify({ runtime, scenario, test, events,
      native: native.trim() ? native.trim().split('\n').map(line => JSON.parse(line)) : [] }, null, 2));
  };
  return { record, events, waitFor, spawnFn, observeTimers, stopTimers: () => stopTimers(), observeSession, observeTerminal, save };
}
