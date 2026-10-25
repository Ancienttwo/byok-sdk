import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { PowercutLink } from './protocol';

export type FaultKind = 'process-crash' | 'os-crash' | 'power-loss';

/**
 * What the storage below the faulted system keeps. The fault says how the
 * system stops; the profile says which writes survive it. A power-loss claim
 * needs a profile that drops writes the guest did not flush. Without one, a
 * hypervisor power-off only shows what an OS crash shows.
 */
export interface StorageProfile {
  readonly id: string;
  readonly dropsUnflushedWrites: boolean;
  readonly description: string;
}

export const OS_CACHE_KEEPS_WRITES: StorageProfile = Object.freeze({
  id: 'os-cache-keeps-writes',
  dropsUnflushedWrites: false,
  description: 'The OS keeps every write the killed processes issued. Only process memory is lost.',
});

export const HOST_KEEPS_ISSUED_WRITES: StorageProfile = Object.freeze({
  id: 'host-keeps-issued-writes',
  dropsUnflushedWrites: false,
  description: 'Every write the guest issued reaches the image or the host page cache, flushed or not.',
});

export interface DeviceRun {
  readonly link: PowercutLink;
  /** Resolves when the device side of the link is gone. */
  readonly ended: Promise<void>;
}

/**
 * A pluggable fault. `start` runs or boots the device program and resolves
 * once it is connected. `cut` injects the fault and resolves only when no
 * device process can write any more. `stop` ends a run that finished cleanly.
 */
export interface PowerCutDriver {
  readonly fault: FaultKind;
  readonly storageProfile: StorageProfile;
  start(): Promise<DeviceRun>;
  cut(): Promise<void>;
  stop(): Promise<void>;
}

const execFileAsync = promisify(execFile);

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return once(child, 'close').then(() => undefined);
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // macOS answers EPERM while a killed member is not yet reaped.
    if (code === 'EPERM') return true;
    throw error;
  }
}

export interface ProcessKillDriverOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Process crash: kill the device program and every process it started, the
 * helper included, with no chance to run any more code. Killing only the
 * device program would let the helper see end of input and finish its
 * current write, which is a clean stop and not a crash. POSIX kills the
 * process group with SIGKILL and waits until the group is empty. Windows
 * uses `taskkill /T /F`, which is TerminateProcess over the process tree.
 */
export class ProcessKillDriver implements PowerCutDriver {
  readonly fault = 'process-crash' as const;
  readonly storageProfile = OS_CACHE_KEEPS_WRITES;
  readonly stderr: string[] = [];
  readonly #options: ProcessKillDriverOptions;
  #child: ChildProcess | undefined;

  constructor(options: ProcessKillDriverOptions) {
    this.#options = options;
  }

  async start(): Promise<DeviceRun> {
    if (this.#child !== undefined) throw new Error('the device program is already running');
    const child = spawn(this.#options.command, [...this.#options.args], {
      detached: process.platform !== 'win32',
      env: this.#options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;
    createInterface({ input: child.stderr! }).on('line', (line) => {
      this.stderr.push(line);
      if (this.stderr.length > 200) this.stderr.shift();
    });
    await once(child, 'spawn');
    return { link: { input: child.stdout!, output: child.stdin! }, ended: exited(child) };
  }

  async cut(): Promise<void> {
    const child = this.#take();
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
      await exited(child);
      return;
    }
    process.kill(-child.pid!, 'SIGKILL');
    await exited(child);
    const deadline = Date.now() + 5_000;
    while (processGroupAlive(child.pid!)) {
      if (Date.now() > deadline) throw new Error(`a process of device group ${child.pid} survived SIGKILL`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async stop(): Promise<void> {
    const child = this.#take();
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await exited(child);
    clearTimeout(timer);
    if (child.exitCode !== 0) throw new Error(`device program exited with ${child.exitCode ?? child.signalCode}`);
  }

  #take(): ChildProcess {
    const child = this.#child;
    if (child === undefined || child.pid === undefined) throw new Error('the device program is not running');
    this.#child = undefined;
    return child;
  }
}

/** One QMP command on a fresh monitor connection: greeting, capabilities, command. */
export async function qmpExecute(socketPath: string, command: string, args?: Record<string, unknown>): Promise<unknown> {
  const socket = net.connect(socketPath);
  try {
    await once(socket, 'connect');
    const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
    const next = async (): Promise<Record<string, unknown>> => {
      for (;;) {
        const { value, done } = await lines.next();
        if (done) throw new Error('QMP monitor closed the connection');
        const message = JSON.parse(value) as Record<string, unknown>;
        if (!('event' in message)) return message;
      }
    };
    if (!('QMP' in (await next()))) throw new Error('QMP greeting missing');
    const send = async (execute: string, argumentsValue?: Record<string, unknown>): Promise<unknown> => {
      socket.write(`${JSON.stringify(argumentsValue === undefined ? { execute } : { execute, arguments: argumentsValue })}\n`);
      const reply = await next();
      if ('error' in reply) throw new Error(`QMP ${execute} failed: ${JSON.stringify(reply.error)}`);
      return reply.return;
    };
    await send('qmp_capabilities');
    return await send(command, args);
  } finally {
    socket.destroy();
  }
}

/**
 * Storage below the guest. `afterPowerCut` runs with QEMU gone and before the
 * next boot, for example to replay a write log only up to its last flush.
 */
export interface StorageLayer {
  readonly profile: StorageProfile;
  afterPowerCut(): Promise<void>;
}

export const HOST_KEEPS_ISSUED_WRITES_LAYER: StorageLayer = Object.freeze({
  profile: HOST_KEEPS_ISSUED_WRITES,
  afterPowerCut: async () => {},
});

export interface QemuDriverOptions {
  readonly fault: 'os-crash' | 'power-loss';
  /** The QEMU command. Its arguments must include `-qmp unix:<qmpSocket>,server=on,wait=off`. */
  readonly command: string;
  readonly args: readonly string[];
  readonly qmpSocket: string;
  /** The guest boots the device program, which connects here (QEMU user networking: 10.0.2.2). */
  readonly listenPort: number;
  readonly storage: StorageLayer;
  readonly bootTimeoutMs?: number;
}

/**
 * A Windows guest under QEMU/KVM.
 *
 * - OS crash: QMP `inject-nmi`. The guest must bugcheck on NMI
 *   (`CrashControl\NMICrashDump=1`) and reboot. QEMU keeps running, so every
 *   write the guest issued before the crash stays.
 * - Power loss: SIGKILL of QEMU, then the storage layer, then a new boot. Not
 *   QMP `quit`: QEMU then closes its block devices and flushes them, which a
 *   power cut never does.
 */
export class QemuDriver implements PowerCutDriver {
  readonly fault: 'os-crash' | 'power-loss';
  readonly storageProfile: StorageProfile;
  readonly #options: QemuDriverOptions;
  #qemu: ChildProcess | undefined;
  #server: net.Server | undefined;
  #socket: net.Socket | undefined;
  readonly #connections: net.Socket[] = [];
  #waiter: ((socket: net.Socket) => void) | undefined;

  constructor(options: QemuDriverOptions) {
    this.fault = options.fault;
    this.storageProfile = options.storage.profile;
    this.#options = options;
  }

  async start(): Promise<DeviceRun> {
    if (this.#server === undefined) {
      const server = net.createServer((socket) => {
        if (this.#waiter !== undefined) {
          const waiter = this.#waiter;
          this.#waiter = undefined;
          waiter(socket);
        } else this.#connections.push(socket);
      });
      server.listen(this.#options.listenPort);
      await once(server, 'listening');
      this.#server = server;
    }
    if (this.#qemu === undefined) {
      this.#qemu = spawn(this.#options.command, [...this.#options.args], { stdio: ['ignore', 'inherit', 'inherit'] });
      await once(this.#qemu, 'spawn');
    }
    const socket = await this.#nextConnection();
    this.#socket = socket;
    return { link: { input: socket, output: socket }, ended: once(socket, 'close').then(() => undefined) };
  }

  async cut(): Promise<void> {
    const socket = this.#socket;
    this.#socket = undefined;
    if (this.fault === 'os-crash') {
      await qmpExecute(this.#options.qmpSocket, 'inject-nmi');
    } else {
      const qemu = this.#qemu;
      this.#qemu = undefined;
      if (qemu === undefined) throw new Error('QEMU is not running');
      qemu.kill('SIGKILL');
      await exited(qemu);
      await this.#options.storage.afterPowerCut();
    }
    // The guest cannot close this socket any more; the Host side drops it.
    socket?.destroy();
  }

  async stop(): Promise<void> {
    this.#socket?.destroy();
    const qemu = this.#qemu;
    this.#qemu = undefined;
    if (qemu !== undefined) {
      await qmpExecute(this.#options.qmpSocket, 'quit');
      await exited(qemu);
    }
    this.#server?.close();
    this.#server = undefined;
  }

  #nextConnection(): Promise<net.Socket> {
    const ready = this.#connections.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiter = undefined;
        reject(new Error('the guest device program did not connect before the boot timeout'));
      }, this.#options.bootTimeoutMs ?? 600_000);
      this.#waiter = (socket) => {
        clearTimeout(timer);
        resolve(socket);
      };
    });
  }
}
