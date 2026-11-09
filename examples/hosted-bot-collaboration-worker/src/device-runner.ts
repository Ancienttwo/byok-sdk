/** Example-private JSON-lines CLI: node --import tsx src/device-runner.ts. */
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Readable, Writable } from 'node:stream';
import { createDeviceSession, deviceConfig, type DeviceCommand, type DeviceEvent, type RuntimeMode } from './device-session.js';

export function runnerOptions(args: string[]) {
  const { values } = parseArgs({ args, options: {
    'server-url': { type: 'string' }, 'pairing-code': { type: 'string' }, root: { type: 'string' }, runtime: { type: 'string' },
  }, strict: true, allowPositionals: false });
  if (!values['server-url'] || !values['pairing-code'] || !values.root || !['stub', 'real'].includes(values.runtime ?? '')) {
    throw new Error('required: --server-url --pairing-code --root --runtime stub|real');
  }
  let url: URL;
  try { url = new URL(values['server-url']); }
  catch { throw new Error('invalid server URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('server URL must be HTTP(S) without credentials, query or fragment');
  }
  return { config: deviceConfig(url.href, path.resolve(values.root)), code: values['pairing-code'], runtime: values.runtime as RuntimeMode };
}

export function runnerCommand(line: string): DeviceCommand {
  let command: unknown;
  try { command = JSON.parse(line); }
  catch { throw new Error('invalid command JSON'); }
  if (command !== null && typeof command === 'object') {
    const value = command as Record<string, unknown>;
    if (value.type === 'stop' && Object.keys(value).length === 1) return { type: 'stop' };
    if (value.type === 'finish' && typeof value.taskId === 'string' && value.taskId.length > 0 && Object.hasOwn(value, 'document')
      && Object.keys(value).length === 3) return { type: 'finish', taskId: value.taskId, document: value.document };
  }
  throw new Error('expected a finish or stop command');
}

/** The optional composition seam lets local tests use disposable custody without adding a CLI custody override. */
export async function runDeviceRunner(args: string[], input: Readable, output: Writable, signal: AbortSignal,
  createSession = createDeviceSession): Promise<void> {
  const { config, code, runtime } = runnerOptions(args);
  const send = (event: DeviceEvent) => { output.write(JSON.stringify({ ...event, runtime }) + '\n'); };
  const device = createSession(config, runtime, send);
  const lines = createInterface({ input, crlfDelay: Infinity });
  // Start consuming before pairing so piped commands cannot be lost during the handshake.
  const iterator = lines[Symbol.asyncIterator]();
  const abort = () => { lines.close(); };
  let runFailed = false;
  const unsubscribe = device.daemon.subscribe(event => {
    if (event.kind === 'lifecycle' && (event.lifecycle.phase === 'halted' || event.lifecycle.phase === 'crashed')) {
      runFailed = true;
      lines.close();
    }
  });
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) return;
    await device.pair(code);
    while (!signal.aborted) {
      const next = await iterator.next();
      if (next.done) break;
      const command = runnerCommand(next.value);
      if (command.type === 'stop') break;
      await device.finish(command.taskId, command.document);
    }
    if (runFailed) throw new Error('daemon run ended unexpectedly');
  } finally {
    unsubscribe();
    signal.removeEventListener('abort', abort);
    lines.close();
    await device.stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runDeviceRunner(process.argv.slice(2), process.stdin, process.stdout, controller.signal);
  } catch {
    // Neither SDK errors nor malformed input are echoed: they may contain server-provided secrets or task content.
    process.stderr.write('device-runner failed; check arguments, local custody, runtime and Host state.\n');
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
