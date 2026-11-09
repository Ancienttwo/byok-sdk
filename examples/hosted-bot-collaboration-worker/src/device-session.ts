/** Shared example device lifecycle; custody and machine identity are SDK defaults unless the IPC fixture overrides them. */
import path from 'node:path';
import { createAgentHomeProjectionConsumer, createDaemonWithAdapters, type DaemonConfig, type DaemonOverrides,
  type RuntimeAdapter } from '@byok-sdk/client';
import { createRuntimeAdapters } from '@byok-sdk/client/adapters';
import { policy } from '@byok-sdk/example-host-execution-core/test-support';
import { BotStubAdapter } from '../../basic/goal-btw.test-support';

export type DeviceEvent =
  | { type: 'ready'; deviceId: string }
  | { type: 'started'; taskId: string; agentId: string }
  | { type: 'finished'; taskId: string }
  | { type: 'error'; taskId?: string; message: string };
export type DeviceCommand = { type: 'finish'; taskId: string; document: unknown } | { type: 'stop' };
export type RuntimeMode = 'stub' | 'real';

export function deviceConfig(serverUrl: string, root: string): DaemonConfig {
  return { productId: 'hosted-collaboration-worker', productName: 'Hosted collaboration Worker',
    localAgentRelease: { version: '0.0.0-example' }, serverUrl, storeDir: path.join(root, 'sdk'),
    agentHome: { hostStorageRoot: path.join(root, 'homes'), projection: createAgentHomeProjectionConsumer(async ({ projection, writeHomeFile }) => {
      await writeHomeFile('AGENTS.md', String((projection as { persona?: unknown }).persona ?? ''));
    }) },
    agentEgress: { policy },
  };
}

/** Observe the public operation seam, retaining optional launch and lease hooks and their receivers. */
function reportStarts(adapter: RuntimeAdapter, send: (event: DeviceEvent) => void): RuntimeAdapter {
  return {
    descriptor: adapter.descriptor,
    detect: signal => adapter.detect(signal),
    runtimeEnvironment: () => adapter.runtimeEnvironment(),
    ...(adapter.projectMcpEnvironment === undefined ? {} : { projectMcpEnvironment: adapter.projectMcpEnvironment.bind(adapter) }),
    async prepare(input) {
      const result = await adapter.prepare(input);
      if (result.kind === 'reject') return result;
      const operation = result.operation;
      return { kind: 'prepared', operation: {
        ...(operation.acquireSessionLease === undefined ? {} : { acquireSessionLease: operation.acquireSessionLease.bind(operation) }),
        ...(operation.resolveRuntimeLaunch === undefined ? {} : { resolveRuntimeLaunch: operation.resolveRuntimeLaunch.bind(operation) }),
        async start(start) {
          const session = await operation.start(start);
          send({ type: 'started', taskId: start.manifest.taskId, agentId: start.manifest.agentRef?.agentId ?? '' });
          return session;
        },
      } };
    },
  };
}

export function createDeviceSession(config: DaemonConfig, runtime: RuntimeMode, send: (event: DeviceEvent) => void,
  overrides: DaemonOverrides = {}) {
  const stub = runtime === 'stub' ? new BotStubAdapter() : undefined;
  const adapters = stub ? [stub] : createRuntimeAdapters({});
  const daemon = createDaemonWithAdapters(config, adapters.map(adapter => reportStarts(adapter, send)), overrides);
  const unsubscribe = daemon.subscribe(event => {
    if (runtime === 'real' && event.kind === 'completed') send({ type: 'finished', taskId: event.taskId });
    if (runtime === 'real' && (event.kind === 'failed' || event.kind === 'cancelled')) {
      send({ type: 'error', taskId: event.taskId, message: 'runtime task did not complete' });
    }
  });
  return {
    daemon,
    async pair(code: string) {
      const { deviceId } = await daemon.pair(code);
      await daemon.start();
      for (const deadline = Date.now() + 30_000; ;) {
        const lifecycle = daemon.status().lifecycle;
        if (lifecycle.phase === 'running' && lifecycle.connection === 'open') break;
        if (lifecycle.phase === 'halted' || lifecycle.phase === 'crashed' || Date.now() > deadline) {
          throw new Error('daemon did not become ready');
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      send({ type: 'ready', deviceId });
    },
    async finish(taskId: string, document: unknown) {
      if (!stub) throw new Error('finish is only available with the stub runtime');
      const session = stub.sessions.get(taskId);
      if (!session) throw new Error(`no runtime session for ${taskId}`);
      await session.finish(document);
      send({ type: 'finished', taskId });
    },
    async stop() { unsubscribe(); await daemon.stop(); },
  };
}
