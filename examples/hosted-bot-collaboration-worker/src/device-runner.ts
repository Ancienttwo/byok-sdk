/** Example-private JSON-lines CLI: node --import tsx src/device-runner.ts. */
import path from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { ReadStream } from 'node:tty';
import type { Readable, Writable } from 'node:stream';
import { createDeviceSession, deviceConfig, MemberComparisonError, type DeviceCommand, type DeviceEvent, type RuntimeMode } from './device-session.js';

export function runnerOptions(args: string[]) {
  const { values } = parseArgs({ args, options: {
    'server-url': { type: 'string' }, 'pairing-code': { type: 'string' }, 'verification-secret': { type: 'string' },
    root: { type: 'string' }, runtime: { type: 'string' }, 'stub-canary': { type: 'boolean', default: false },
    'canary-controls': { type: 'boolean', default: false }, 'macos-keychain-path': { type: 'string' },
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
  if ((values['stub-canary'] || values['canary-controls']) && values.runtime !== 'stub') throw new Error('canary modes require --runtime stub');
  if (values['stub-canary'] && values['canary-controls']) throw new Error('select one canary mode');
  if (values['verification-secret'] === '') throw new Error('verification secret must not be empty');
  return { config: deviceConfig(url.href, path.resolve(values.root), values['macos-keychain-path']), code: values['pairing-code'],
    verificationSecret: values['verification-secret'], runtime: values.runtime as RuntimeMode,
    stubCanary: values['stub-canary'], canaryControls: values['canary-controls'] };
}

export function runnerCommand(line: string): DeviceCommand {
  let command: unknown;
  try { command = JSON.parse(line); }
  catch { throw new Error('invalid command JSON'); }
  if (command !== null && typeof command === 'object') {
    const value = command as Record<string, unknown>;
    if ((value.type === 'stop' || value.type === 'approve' || value.type === 'reject') && Object.keys(value).length === 1) {
      return { type: value.type };
    }
    if (value.type === 'member-bundle' && Object.hasOwn(value, 'bundle') && Object.keys(value).length === 2) {
      return { type: 'member-bundle', bundle: value.bundle };
    }
    if (value.type === 'finish' && typeof value.taskId === 'string' && value.taskId.length > 0 && Object.hasOwn(value, 'document')
      && Object.keys(value).length === 3) return { type: 'finish', taskId: value.taskId, document: value.document };
    if (value.type === 'canary' && typeof value.taskId === 'string' && value.taskId.length > 0
      && typeof value.text === 'string' && value.text.length > 0 && typeof value.sealed === 'boolean'
      && Object.keys(value).length === 4) return { type: 'canary', taskId: value.taskId, text: value.text, sealed: value.sealed };
  }
  throw new Error('expected a device control command');
}

/** Raw TTY input disables terminal echo, including secret fields rejected before parsing. */
export function protectTerminalInput(input: Readable, stop: () => void): () => void {
  if (!(input instanceof ReadStream) || !input.isTTY) return () => {};
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  const controls = (data: Buffer) => { if (data.includes(3) || data.includes(4)) stop(); };
  input.on('data', controls);
  return () => { input.off('data', controls); input.setRawMode(wasRaw); };
}

/** The optional composition seam lets local tests use disposable custody without adding a CLI custody override. */
export async function runDeviceRunner(args: string[], input: Readable, output: Writable, signal: AbortSignal,
  createSession = createDeviceSession): Promise<void> {
  const { config, code, verificationSecret, runtime, stubCanary, canaryControls } = runnerOptions(args);
  const send = (event: DeviceEvent) => { output.write(JSON.stringify(event.type === 'approval-code' ? event : { ...event, runtime }) + '\n'); };
  const device = createSession(config, runtime, send, {}, stubCanary, canaryControls);
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
    let awaitingApproval = verificationSecret !== undefined, compared = false;
    await device.pair(code, verificationSecret);
    while (!signal.aborted) {
      const next = await iterator.next();
      if (next.done) break;
      const command = runnerCommand(next.value);
      if (command.type === 'stop' || command.type === 'reject') break;
      if (command.type === 'member-bundle') {
        if (!awaitingApproval || compared) throw new Error('member comparison is not pending');
        await device.compareMember(command.bundle); compared = true; continue;
      }
      if (command.type === 'approve') {
        if (!awaitingApproval || !compared) throw new Error('member comparison is required before approval');
        await device.start(signal); awaitingApproval = false; continue;
      }
      if (awaitingApproval) throw new Error('member comparison and approval are required before task controls');
      if (command.type === 'canary') await device.canary(command.taskId, command.text, command.sealed,
        AbortSignal.any([signal, AbortSignal.timeout(60_000)]));
      else await device.finish(command.taskId, command.document);
    }
    if (runFailed) throw new Error('daemon run ended unexpectedly');
  } finally {
    unsubscribe();
    signal.removeEventListener('abort', abort);
    lines.close();
    await device.stop();
  }
}

if (import.meta.main) {
  // SDK diagnostics (including E2EE member verification) must not share the JSON event stream.
  for (const method of ['log', 'info', 'debug'] as const) console[method] = console.error.bind(console);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let restoreInput = () => {};
  try {
    restoreInput = protectTerminalInput(process.stdin, stop);
    await runDeviceRunner(process.argv.slice(2), process.stdin, process.stdout, controller.signal);
  } catch (error) {
    // Neither SDK errors nor malformed input are echoed: they may contain server-provided secrets or task content.
    if (error instanceof MemberComparisonError) process.stderr.write(error.message + '\n');
    else process.stderr.write('device-runner failed; check arguments, local custody, runtime and Host state.\n');
    process.exitCode = 1;
  } finally {
    restoreInput();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
