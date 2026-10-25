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

export interface WindowsProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  /** Creation time in Unix milliseconds; with the PID it names one process, not a reused PID. */
  readonly created: number;
}

const LIST_WINDOWS_PROCESSES = 'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ '
  + 'pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name; '
  + 'created = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } } | ConvertTo-Json -Compress';

async function windowsProcesses(): Promise<WindowsProcess[]> {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LIST_WINDOWS_PROCESSES], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as WindowsProcess | WindowsProcess[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** `roots` and every process started under them, by parent links; a child is never older than its parent. */
export function windowsTree(all: readonly WindowsProcess[], roots: readonly WindowsProcess[], createdBy = Infinity): WindowsProcess[] {
  const tree = new Map(roots.map((entry) => [entry.pid, entry]));
  for (let grown = true; grown;) {
    grown = false;
    for (const entry of all) {
      const parent = tree.get(entry.ppid);
      if (tree.has(entry.pid) || parent === undefined || entry.created < parent.created || entry.created > createdBy) continue;
      tree.set(entry.pid, entry);
      grown = true;
    }
  }
  return [...tree.values()];
}

/** A process taskkill named, by its place in the device tree. The device starts only the helper. */
export interface WindowsKilledProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly role: 'device' | 'helper' | 'helper-child';
}

/** Each `PID <n> (child process of PID <m>)` taskkill names: the tree at the moment it killed. */
export function taskkillNamedProcesses(output: string, devicePid: number): WindowsKilledProcess[] {
  const named = [...output.matchAll(/PID (\d+) \(child process of PID (\d+)\)/gu)].map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]) }));
  const helpers = new Set(named.filter((entry) => entry.ppid === devicePid).map((entry) => entry.pid));
  return named.map((entry) => ({
    ...entry,
    role: entry.pid === devicePid ? 'device' : helpers.has(entry.pid) ? 'helper' : 'helper-child',
  }));
}

/** What one Windows cut killed, and what taskkill said about it. */
export interface WindowsKillRecord {
  readonly killed: readonly WindowsKilledProcess[];
  readonly taskkill: Readonly<{ exitCode: number; output: string }>;
  /** A helper was in the tree when taskkill ran, so the cut hit it alive. */
  readonly helperAlive: boolean;
  /** Milliseconds from taskkill's return until no process of the tree was left. */
  readonly goneAfterMs: number;
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
 * process group with SIGKILL and waits until the group is empty.
 *
 * Windows has no process group. `start` records the device process with its
 * creation time, so the cut itself waits for nothing: `taskkill /T /F`
 * (TerminateProcess over the tree) runs at the trigger. Its output names
 * every process of the tree at that moment. The cut then requires that none
 * of them, and nothing they started, is still alive; creation times rule out
 * a reused PID. The taskkill exit code is kept as evidence, not trusted:
 * libuv puts each non-detached child in a kill-on-close job, so terminating
 * the device can leave its helper already terminating when taskkill reaches
 * it.
 */
export class ProcessKillDriver implements PowerCutDriver {
  readonly fault = 'process-crash' as const;
  readonly storageProfile = OS_CACHE_KEEPS_WRITES;
  readonly stderr: string[] = [];
  readonly windowsKills: WindowsKillRecord[] = [];
  readonly #options: ProcessKillDriverOptions;
  #child: ChildProcess | undefined;
  #windowsDevice: WindowsProcess | undefined;

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
    if (process.platform === 'win32') {
      this.#windowsDevice = (await windowsProcesses()).find((entry) => entry.pid === child.pid);
      if (this.#windowsDevice === undefined) throw new Error(`device process ${child.pid} exited at start`);
    }
    return { link: { input: child.stdout!, output: child.stdin! }, ended: exited(child) };
  }

  async cut(): Promise<void> {
    const child = this.#take();
    if (process.platform === 'win32') {
      await this.#cutWindows(child);
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
    this.#windowsDevice = undefined;
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await exited(child);
    clearTimeout(timer);
    if (child.exitCode !== 0) throw new Error(`device program exited with ${child.exitCode ?? child.signalCode}`);
  }

  async #cutWindows(child: ChildProcess): Promise<void> {
    const device = this.#windowsDevice!;
    this.#windowsDevice = undefined;
    let taskkill: WindowsKillRecord['taskkill'];
    try {
      const { stdout, stderr } = await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
      taskkill = { exitCode: 0, output: `${stdout}${stderr}`.trim() };
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: string; stderr?: string };
      taskkill = { exitCode: typeof failure.code === 'number' ? failure.code : -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim() };
    }
    const killedAt = Date.now();
    const killed = taskkillNamedProcesses(taskkill.output, device.pid);
    // Every named PID belongs to a process created between the device start
    // and the kill; anything else with that PID now is a reuse.
    const anchors = [device, ...killed.filter((entry) => entry.pid !== device.pid)
      .map((entry) => ({ pid: entry.pid, ppid: entry.ppid, name: '', created: device.created }))];
    let survivors: WindowsProcess[];
    for (;;) {
      const alive = await windowsProcesses();
      survivors = windowsTree(alive, anchors, killedAt).filter((entry) =>
        alive.some((other) => other.pid === entry.pid && other.created >= device.created && other.created <= killedAt));
      if (survivors.length === 0 || Date.now() - killedAt > 10_000) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (survivors.length > 0) throw new Error(`device tree survived the cut: ${JSON.stringify({ killed, taskkill, survivors })}`);
    await exited(child);
    this.windowsKills.push({ killed, taskkill, helperAlive: killed.some((entry) => entry.role === 'helper'), goneAfterMs: Date.now() - killedAt });
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
 * Storage below the guest. On a power cut, `cut` runs while QEMU is still
 * alive, so a disconnect cannot flush the layer first: for example SIGKILL of
 * an nbdkit `cache=writeback` server drops every write since the last flush.
 * `prepareBoot` runs with QEMU gone, before the next boot.
 */
export interface StorageLayer {
  readonly profile: StorageProfile;
  cut(): Promise<void>;
  prepareBoot(): Promise<void>;
}

export const HOST_KEEPS_ISSUED_WRITES_LAYER: StorageLayer = Object.freeze({
  profile: HOST_KEEPS_ISSUED_WRITES,
  cut: async () => {},
  prepareBoot: async () => {},
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
 * - OS crash: QMP `inject-nmi`. Windows 8 and later bugcheck on an NMI; the
 *   guest must reboot automatically and write no crash dump to the disk under
 *   test. QEMU keeps running, so every write the guest issued stays.
 * - Power loss: the storage layer's `cut`, SIGKILL of QEMU, the layer's
 *   `prepareBoot`, then a new boot. Never QMP `quit`, `stop` or a pause
 *   before the cut: QEMU then flushes its block devices, which a power cut
 *   never does.
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
      await this.#options.storage.cut();
      qemu.kill('SIGKILL');
      await exited(qemu);
      await this.#options.storage.prepareBoot();
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
