import { appendFileSync, existsSync, promises as fs, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../../daemon/agent-egress-policy';
import { connectControlClient } from '../../bin/control-client';
import { runSdkReservedHelperCommand } from '../../sdk-reserved-helper-host';
import type { AgentEvent } from '@byok-sdk/protocol';
import { createDaemonWithAdapters, type DaemonOverrides } from '../../daemon/create-daemon';
import { SqliteLocalTaskJournal, type JournalFaultStep } from '../../daemon/journal/sqlite-journal';
import { DeviceStore } from '../../daemon/store';
import {
  freezeRuntimeAdapterDescriptor,
  type RuntimeAdapter,
  type RuntimeAdapterPrepareInput,
  type RuntimeAdapterPrepareResult,
  type RuntimeOperationStartInput,
  type Session,
} from '../../types';

interface Config {
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

class ControlledSession implements Session {
  readonly sessionRef: string;
  private closed = false;

  constructor(private readonly taskId: string, private readonly input: RuntimeOperationStartInput) {
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
        while (!self.closed) {
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
      permissionModes: ['auto'],
    },
    environmentRequirements: { credentialNames: [] },
  });

  async detect() {
    return { present: true, version: 'fixture', authPresent: true };
  }

  async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    void input;
    return {
      kind: 'prepared',
      operation: {
        start: async (startInput: RuntimeOperationStartInput) => {
          const taskId = startInput.manifest.taskId;
          appendFileSync(
            path.join(config.controlDir, 'runtime-starts.jsonl'),
            `${JSON.stringify({ taskId, pid: process.pid, instruction: startInput.instruction })}\n`,
          );
          return new ControlledSession(taskId, startInput);
        },
      },
    };
  }
}

const journal = new SqliteLocalTaskJournal({
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
const overrides = {
  hostedJournal: { journal },
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
    storeDir: config.storeDir,
    hostedJournal: { mode: 'sqlite' },
    sdkHelperHost: { mode: 'self-executable' },
    ...(config.agentHome === true ? { agentHome: { hostStorageRoot: path.join(config.storeDir, 'agent-home') }, agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY } } : {}),
  },
  [new ControlledAdapter()],
  overrides,
);

if (config.action === 'unpair') {
  await daemon.unpair();
  await journal.close();
  process.stdout.write(`${JSON.stringify({ unpaired: true })}\n`);
  process.exit(0);
}

const paired = config.pairingCode === undefined ? undefined : await daemon.pair(config.pairingCode);
await daemon.start();
const device = paired ?? await new DeviceStore(config.storeDir, undefined, config.productId).load();
process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid, deviceId: device?.deviceId })}\n`);

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  void (async () => {
    const command = JSON.parse(line) as { command?: string };
    if (command.command !== 'stop') throw new Error(`unknown daemon fixture command ${command.command}`);
    await daemon.stop();
    await journal.close();
    process.stdout.write(`${JSON.stringify({ stopped: true })}\n`);
    process.exit(0);
  })().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
});
