import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, promises as fs, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../../daemon/agent-egress-policy';
import { adoptOwnedProcessTree, disposeOwnedProcessTree, requestOwnedProcessTreeTermination, withOwnedProcessTree } from '../../adapters/process-tree';
import { connectControlClient } from '../../bin/control-client';
import { runSdkReservedHelperCommand } from '../../sdk-reserved-helper-host';
import type { AgentEvent } from '@byok-sdk/protocol';
import { createDaemonWithAdapters, type DaemonOverrides } from '../../daemon/create-daemon';
import { SqliteLocalTaskJournal, type JournalFaultStep } from '../../daemon/journal/sqlite-journal';
import { CursorStore } from '../../daemon/cursor-store';
import { DeviceStore } from '../../daemon/store';
import { createDeviceCredentialStore } from '../../daemon/device-credential-provider';
import { waitForDaemonOpen } from './lifecycle-barrier';
import {
  freezeRuntimeAdapterDescriptor,
  type RuntimeAdapter,
  type RuntimeAdapterPrepareInput,
  type RuntimeAdapterPrepareResult,
  type RuntimeOperationStartInput,
  type Session,
} from '../../types';

interface Config {
  readonly deviceCredentials?: { readonly macosKeychainPath: string };
  readonly scratchRoot: string;
  readonly productId: string;
  readonly serverUrl: string;
  readonly storeDir: string;
  readonly workspaceRoot: string;
  readonly controlDir: string;
  readonly pairingCode?: string;
  readonly action?: 'run' | 'unpair';
  readonly journalFault?: JournalFaultStep | 'append:after-commit';
  readonly recoveryFault?: 'terminal:before-send' | 'terminal:queued' | 'outbound:before-post' | 'outbound:after-ack';
  readonly agentHome?: boolean;
  readonly holdTerminalConfirmation?: boolean;
  /** #924: the cursor is never saved past seq 0, as if the daemon died before the save. */
  readonly holdCursorSave?: boolean;
  /** #384: the runtime owns a real POSIX process group with an in-group tool shell and its grandchild. */
  readonly ownedRuntimeTree?: boolean;
}

if (await runSdkReservedHelperCommand()) process.exit(0);

const config = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Config;
await fs.mkdir(config.controlDir, { recursive: true });

function checkpoint(name: string): void {
  writeFileSync(path.join(config.controlDir, `${name}.reached`), `${process.pid}\n`);
}

function killAt(name: string): void {
  checkpoint(name.replaceAll(':', '-'));
  process.kill(process.pid, 'SIGKILL');
}

function recoveryFaultArmed(step: NonNullable<Config['recoveryFault']>): boolean {
  return existsSync(path.join(config.controlDir, `${step.replaceAll(':', '-')}.arm`));
}

/**
 * A runtime root for #384 / #393: a group leader that ignores stdin EOF (what
 * a daemon SIGKILL delivers), with a tool shell (and that shell's own child)
 * in its group and one child in a session of its own.
 */
async function spawnOwnedRuntimeTree(taskId: string): Promise<ChildProcess> {
  const treeFile = path.join(config.controlDir, 'runtime-tree.json');
  const child = spawn('/bin/sh', ['-c', `sh -c 'sleep 600; :' & tool=$!; perl -MPOSIX -e 'POSIX::setsid(); exec "sleep", "600"' & printf '{"rootPid":%d,"toolPid":%d,"sessionPid":%d}' $$ $tool $! > "$1.tmp"; mv "$1.tmp" "$1"; wait`, 'fixture-runtime', treeFile], withOwnedProcessTree({
    stdio: ['pipe', 'ignore', 'ignore'],
  }));
  await adoptOwnedProcessTree({ child, label: `fixture ${taskId}` });
  return child;
}

class ControlledSession implements Session {
  readonly sessionRef: string;
  private closed = false;

  constructor(private readonly taskId: string, private readonly input: RuntimeOperationStartInput, private readonly tree?: ChildProcess) {
    this.sessionRef = `fixture-${taskId}`;
  }

  get events(): AsyncIterable<AgentEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        const server = self.input.mcpServers?.byokagentmessage;
        if (server !== undefined) {
          const connected = await connectControlClient({ storeDir: config.storeDir, productId: config.productId });
          if (!connected.ok) throw new Error(connected.reason);
          try {
            await connected.client.request('agent_messages.publish', { contextToken: server.env!.BYOK_AGENT_MESSAGE_CONTEXT, contentType: 'text/markdown', body: '**exact durable reply**' });
            checkpoint('message-staged');
          } finally { connected.client.close(); }
        }
        const finishFile = path.join(config.controlDir, `${self.taskId}.finish.json`);
        // A result-document task submits through the same control route the
        // SDK result helper's submit_result forwards to, when the test asks.
        const resultServer = self.input.mcpServers?.byokagentresult;
        const submitFile = path.join(config.controlDir, `${self.taskId}.submit.json`);
        let submitted = false;
        while (!self.closed) {
          if (resultServer !== undefined && !submitted && existsSync(submitFile)) {
            submitted = true;
            const outcome = JSON.parse(await fs.readFile(submitFile, 'utf8')) as unknown;
            const connected = await connectControlClient({ storeDir: config.storeDir, productId: config.productId });
            if (!connected.ok) throw new Error(connected.reason);
            try {
              const receipt = await connected.client.request('agent_results.submit', { contextToken: resultServer.env!.BYOK_AGENT_RESULT_CONTEXT, outcome });
              writeFileSync(path.join(config.controlDir, `${self.taskId}.receipt.json`), JSON.stringify(receipt));
              checkpoint('result-staged');
            } finally { connected.client.close(); }
          }
          if (existsSync(finishFile)) {
            const finish = JSON.parse(await fs.readFile(finishFile, 'utf8')) as { summary?: string };
            if (finish.summary !== undefined) yield { type: 'progress', text: finish.summary };
            yield { type: 'turn_end' };
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      },
    };
  }

  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}

  async interrupt(): Promise<void> {
    writeFileSync(path.join(config.controlDir, `${this.taskId}.interrupted`), 'interrupted\n');
  }

  async close(): Promise<void> {
    this.closed = true;
    const tree = this.tree;
    if (tree !== undefined) {
      const closed = new Promise<void>((resolve) => {
        if (tree.exitCode !== null || tree.signalCode !== null) resolve();
        else tree.once('close', () => resolve());
      });
      const options = { child: tree, waitClosed: () => closed, isClosed: () => tree.exitCode !== null || tree.signalCode !== null, label: `fixture ${this.taskId}` };
      await requestOwnedProcessTreeTermination(options);
      await disposeOwnedProcessTree(options);
    }
    writeFileSync(path.join(config.controlDir, `${this.taskId}.closed`), 'closed\n');
  }

  async resolveApproval(): Promise<void> {
    throw new Error('controlled execution-recovery fixture has no approval flow');
  }
}

class ControlledAdapter implements RuntimeAdapter {
  readonly descriptor = freezeRuntimeAdapterDescriptor({
    id: 'pi',
    supportsDispatchSelection: true,
    capabilities: {
      steer: true,
      resume: true,
      approvalInteractive: false,
      mcpToolsets: true,
    },
  });

  async detect() {
    return { kind: 'available' as const, version: 'fixture', authPresent: true };
  }

  async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    void input;
    return {
      kind: 'prepared',
      operation: {
        start: async (startInput: RuntimeOperationStartInput) => {
          if (startInput.kind !== 'instruction') {
            throw new Error('execution-recovery fixture adapter has no prepared-input lane');
          }
          const taskId = startInput.manifest.taskId;
          appendFileSync(
            path.join(config.controlDir, 'runtime-starts.jsonl'),
            `${JSON.stringify({ taskId, pid: process.pid, instruction: startInput.instruction })}\n`,
          );
          return new ControlledSession(taskId, startInput, config.ownedRuntimeTree === true ? await spawnOwnedRuntimeTree(taskId) : undefined);
        },
      },
    };
  }
}

// Only a journal fault or barrier needs an injected journal; otherwise the
// daemon opens its own, as with the default config.
const journal = config.journalFault === undefined && config.holdTerminalConfirmation !== true ? undefined : new SqliteLocalTaskJournal({
  storeDir: config.storeDir,
  ...(config.journalFault === undefined
    ? {}
    : {
        faults: {
          onStep(step: JournalFaultStep | 'append:after-commit') {
            if (step === config.journalFault) killAt(step);
          },
        },
      }),
});
// Test-only barrier: cloud acceptance can precede the daemon's durable confirmation.
if (journal !== undefined && config.holdTerminalConfirmation === true) {
  const confirmTerminal = journal.confirmTerminal.bind(journal);
  journal.confirmTerminal = async (...args: Parameters<typeof confirmTerminal>) => {
    checkpoint('terminal-confirmation');
    while (!existsSync(path.join(config.controlDir, 'terminal-confirmation.release'))) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return confirmTerminal(...args);
  };
}
if (config.holdCursorSave === true) {
  const save = CursorStore.prototype.save;
  CursorStore.prototype.save = async function (this: CursorStore, ...args: Parameters<typeof save>) {
    if (args[2] === 0) return save.apply(this, args);
    checkpoint('cursor-save-held');
    return new Promise<never>(() => {});
  };
}
const overrides = {
  ...(journal === undefined ? {} : { journal }),
  longPoll: { retryDelayMs: 20, idleDelayMs: 10 },
  ...(config.recoveryFault === undefined
    ? {}
    : {
        executionRecoveryFault(step: NonNullable<Config['recoveryFault']>) {
          if (step === config.recoveryFault && recoveryFaultArmed(step)) killAt(step);
        },
      }),
} as unknown as DaemonOverrides;
const daemon = createDaemonWithAdapters(
  {
    localAgentRelease: { version: '0.0.0-execution-recovery-fixture' },
    productName: 'Execution recovery fixture',
    productId: config.productId,
    serverUrl: config.serverUrl,
    workspaceRoot: config.workspaceRoot,
    storage: { scratchRoot: config.scratchRoot }, storeDir: config.storeDir,
    deviceCredentials: config.deviceCredentials,
    sdkHelperHost: { mode: 'self-executable' },
    ...(config.agentHome === true ? { agentHome: { hostStorageRoot: path.join(config.storeDir, 'agent-home') }, agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY } } : {}),
  },
  [new ControlledAdapter()],
  overrides,
);

daemon.subscribe((event) => {
  if (event.kind === 'outbound-rejected') process.stdout.write(`${JSON.stringify({ event })}\n`);
});

if (config.action === 'unpair') {
  await daemon.unpair();
  await journal?.close();
  process.stdout.write(`${JSON.stringify({ unpaired: true })}\n`);
  process.exit(0);
}

const paired = config.pairingCode === undefined ? undefined : await daemon.pair(config.pairingCode);
await daemon.start();
// #391: start() is local startup only; "ready" means the cloud accepted this run's hello.
await waitForDaemonOpen(daemon);
const device = paired ?? await new DeviceStore(config.storeDir, createDeviceCredentialStore(config)).load();
process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid, deviceId: device?.deviceId })}\n`);

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  void (async () => {
    const command = JSON.parse(line) as { command?: string };
    if (command.command !== 'stop') throw new Error(`unknown daemon fixture command ${command.command}`);
    await daemon.stop();
    await journal?.close();
    process.stdout.write(`${JSON.stringify({ stopped: true })}\n`);
    process.exit(0);
  })().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
});
