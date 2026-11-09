/** Shared example device lifecycle; custody and machine identity are SDK defaults unless the IPC fixture overrides them. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentHomeProjectionConsumer, createDaemonWithAdapters, type DaemonConfig, type DaemonOverrides,
  type RuntimeAdapter, type RuntimeOperationStartInput } from '@byok-sdk/client';
import { createRuntimeAdapters } from '@byok-sdk/client/adapters';
import { policy } from '@byok-sdk/example-host-execution-core/test-support';
import { BotStubAdapter } from '../../basic/goal-btw.test-support';
import { ZeroHitAdapter } from '../../hosted-bot-collaboration/src/zero-hit-runtime.test-support';

type PublicSigningKey = import('../../../packages/core/src/sealed-payload/index.js').MemberKeyBundleV1['signingPublicJwk'];

export type DeviceEvent =
  | { type: 'approval-code'; code: string }
  | { type: 'canary-result'; taskId: string; sha256: string }
  | { type: 'paired'; deviceId: string }
  | { type: 'ready'; deviceId: string }
  | { type: 'started'; taskId: string; agentId: string }
  | { type: 'finished'; taskId: string }
  | { type: 'error'; taskId?: string; message: string };
export type DeviceCommand = { type: 'finish'; taskId: string; document: unknown }
  | { type: 'member-bundle'; bundle: unknown } | { type: 'approve' } | { type: 'reject' }
  | { type: 'canary'; taskId: string; text: string; sealed: boolean } | { type: 'stop' };
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

export class MemberComparisonError extends Error {}

export async function sealedCore() {
  try {
    // core exposes an import-only subpath; resolve its public export from the client's installed dependency.
    const manifest = createRequire(import.meta.resolve('@byok-sdk/client')).resolve('@byok-sdk/core/package.json');
    const pkg = JSON.parse(await readFile(manifest, 'utf8')) as { exports: { './sealed-payload': { import: string } } };
    return await import(new URL(pkg.exports['./sealed-payload'].import, pathToFileURL(manifest)).href) as typeof import('../../../packages/core/src/sealed-payload/index.js');
  } catch { throw new MemberComparisonError('member comparison requires the pinned SDK sealed-payload export'); }
}

async function localMemberState(config: DaemonConfig, deviceId: string, signal?: AbortSignal) {
  const { DeviceMemberRecords } = await import('../../../packages/client/src/daemon/device-member-custody.js');
  const { createDeviceMemberCustody } = await import('../../../packages/client/src/daemon/device-credential-provider.js');
  const state = await new DeviceMemberRecords(createDeviceMemberCustody({ productId: config.productId,
    storeDir: config.storeDir!, deviceCredentials: config.deviceCredentials, nativeAssetRoot: config.nativeAssetRoot })).readState(signal);
  if (!state || state.deviceId !== deviceId || state.member.deviceId !== deviceId) throw new Error('device member state mismatch');
  return state;
}

/** Pinned checkout-only read: the member-state entry contains public data; the member-keys entry is never read. */
export async function localMemberApproval(config: DaemonConfig, deviceId: string, bundle: unknown) {
  try {
    const core = await sealedCore();
    const browser = await core.parseMemberKeyBundle(bundle);
    if (!browser || browser.deviceId !== undefined) throw new Error('expected a public browser member bundle');
    const state = await localMemberState(config, deviceId);
    return { code: (await core.memberApprovalCode(state.tenantId, browser.signingPublicJwk, state.member.signingPublicJwk)).replaceAll(' ', ''),
      signingPublicJwk: browser.signingPublicJwk };
  } catch { throw new MemberComparisonError('member comparison requires a valid public browser bundle and the pinned SDK local member-state record'); }
}

/** Observe the public operation seam, retaining optional launch and lease hooks and their receivers. */
function reportStarts(adapter: RuntimeAdapter, send: (event: DeviceEvent) => void,
  admission: () => Promise<boolean | undefined>, afterStart?: (start: RuntimeOperationStartInput) => void): RuntimeAdapter {
  return {
    descriptor: adapter.descriptor,
    detect: signal => adapter.detect(signal),
    runtimeEnvironment: () => adapter.runtimeEnvironment(),
    ...(adapter.projectMcpEnvironment === undefined ? {} : { projectMcpEnvironment: adapter.projectMcpEnvironment.bind(adapter) }),
    async prepare(input) {
      const bound = await admission();
      if (bound !== true) return { kind: 'reject', reason: bound === undefined ? 'member binding pending' : 'member binding failed', retryable: false };
      const result = await adapter.prepare(input);
      if (result.kind === 'reject') return result;
      const operation = result.operation;
      return { kind: 'prepared', operation: {
        ...(operation.acquireSessionLease === undefined ? {} : { acquireSessionLease: operation.acquireSessionLease.bind(operation) }),
        ...(operation.resolveRuntimeLaunch === undefined ? {} : { resolveRuntimeLaunch: operation.resolveRuntimeLaunch.bind(operation) }),
        async start(start) {
          const session = await operation.start(start);
          send({ type: 'started', taskId: start.manifest.taskId, agentId: start.manifest.agentRef?.agentId ?? '' });
          afterStart?.(start);
          return session;
        },
      } };
    },
  };
}

function memberBinding() {
  let resolve!: (bound: boolean) => void;
  const promise = new Promise<boolean>(done => { resolve = done; });
  return { promise, resolve };
}

export function createDeviceSession(config: DaemonConfig, runtime: RuntimeMode, send: (event: DeviceEvent) => void,
  overrides: DaemonOverrides = {}, stubCanary = false, canaryControls = false) {
  const scripted = runtime === 'stub' && (stubCanary || canaryControls) ? new ZeroHitAdapter() : undefined;
  const stub = runtime === 'stub' ? scripted ?? new BotStubAdapter() : undefined;
  const adapters = stub ? [stub] : createRuntimeAdapters({});
  const autoFinish = !stubCanary ? undefined : (start: RuntimeOperationStartInput) => {
    // Return the session before submitting a result: TaskRunner must first publish its active task.
    setImmediate(() => {
      const taskId = start.manifest.taskId;
      const session = scripted!.sessions.get(taskId)!;
      if (start.kind !== 'instruction') {
        session.fail(); send({ type: 'error', taskId, message: 'stub canary requires an instruction task' }); return;
      }
      void session.finish({ text: start.instruction }).then(() => {
        send({ type: 'canary-result', taskId, sha256: createHash('sha256').update(start.instruction, 'utf8').digest('hex') });
      }).catch(() => { send({ type: 'error', taskId, message: 'stub canary result failed' }); });
    });
  };
  let binding = memberBinding();
  binding.resolve(true);
  const lifetime = new AbortController();
  const admission = () => Promise.race([binding.promise, Promise.resolve(undefined)]);
  const daemon = createDaemonWithAdapters(stubCanary ? { ...config, agentMemoryMcp: 'off' } : config,
    adapters.map(adapter => reportStarts(adapter, send, admission, autoFinish)), overrides);
  const unsubscribe = daemon.subscribe(event => {
    if ((runtime === 'real' || stubCanary) && event.kind === 'completed') send({ type: 'finished', taskId: event.taskId });
    if ((runtime === 'real' || stubCanary) && (event.kind === 'failed' || event.kind === 'cancelled')) {
      send({ type: 'error', taskId: event.taskId, message: 'runtime task did not complete' });
    }
  });
  let pairedDeviceId: string | undefined, memberPairing = false;
  let comparedKey: PublicSigningKey | undefined;
  let pairingDeadline = 0;
  async function bindComparedMember(deviceId: string, signal: AbortSignal) {
    try {
      while (Date.now() < pairingDeadline) {
        signal.throwIfAborted();
        const state = await localMemberState(config, deviceId, signal);
        signal.throwIfAborted();
        if (Date.now() >= pairingDeadline) throw new Error('pairing verification expired');
        const key = state.anchor?.approverSigningPublicJwk;
        if (key) {
          if (!comparedKey || key.kty !== comparedKey.kty || key.crv !== comparedKey.crv || key.x !== comparedKey.x || key.y !== comparedKey.y) {
            throw new Error('relayed member does not match local approval');
          }
          binding.resolve(true);
          return;
        }
        await delay(Math.min(25, pairingDeadline - Date.now()), undefined, { signal });
      }
      throw new Error('member relay anchor missing');
    } catch {
      binding.resolve(false);
      const message = 'member relay did not bind the locally approved browser key';
      send({ type: 'error', message });
      await daemon.stop();
    }
  }
  async function start(signal: AbortSignal = lifetime.signal) {
    if (!pairedDeviceId) throw new Error('device is not paired');
    if (memberPairing && !comparedKey) throw new MemberComparisonError('member comparison is required before startup');
    const startupSignal = AbortSignal.any([signal, lifetime.signal]);
    startupSignal.throwIfAborted();
    await daemon.start();
    if (memberPairing) await bindComparedMember(pairedDeviceId, AbortSignal.any([
      startupSignal, AbortSignal.timeout(Math.max(0, pairingDeadline - Date.now())),
    ]));
    if (!(await binding.promise)) throw new MemberComparisonError('member relay did not bind the locally approved browser key');
    for (const deadline = Date.now() + 30_000; ;) {
      startupSignal.throwIfAborted();
      const lifecycle = daemon.status().lifecycle;
      if (lifecycle.phase === 'running' && lifecycle.connection === 'open') break;
      if (lifecycle.phase === 'halted' || lifecycle.phase === 'crashed' || Date.now() > deadline) throw new Error('daemon did not become ready');
      await delay(25, undefined, { signal: startupSignal });
    }
    send({ type: 'ready', deviceId: pairedDeviceId });
  }
  return {
    daemon, start,
    async pair(code: string, verificationSecret?: string) {
      memberPairing = verificationSecret !== undefined;
      binding = memberBinding();
      if (memberPairing) {
        const initiated = Date.now();
        try {
          const { PAIRING_VERIFICATION_TTL_MS: ttl } = await import('../../../packages/client/src/daemon/device-member.js');
          if (!Number.isFinite(ttl) || ttl <= 0) throw new Error('invalid pairing TTL');
          pairingDeadline = initiated + ttl;
        } catch {
          binding.resolve(false);
          throw new MemberComparisonError('member comparison requires the pinned SDK pairing-verification TTL');
        }
      } else binding.resolve(true);
      const { deviceId } = await daemon.pair(code, verificationSecret === undefined ? undefined : { verificationSecret });
      pairedDeviceId = deviceId;
      comparedKey = undefined;
      if (memberPairing) send({ type: 'paired', deviceId });
      else await start();
    },
    async compareMember(bundle: unknown) {
      if (!pairedDeviceId) throw new Error('device is not paired');
      const { code, signingPublicJwk } = await localMemberApproval(config, pairedDeviceId, bundle);
      comparedKey = signingPublicJwk;
      send({ type: 'approval-code', code });
    },
    async finish(taskId: string, document: unknown) {
      if (!stub) throw new Error('finish is only available with the stub runtime');
      const session = stub.sessions.get(taskId);
      if (!session) throw new Error(`no runtime session for ${taskId}`);
      await session.finish(document);
      send({ type: 'finished', taskId });
    },
    async canary(taskId: string, text: string, sealed: boolean, signal = AbortSignal.timeout(60_000)) {
      if (!stub) throw new Error('canary is only available with the stub runtime');
      if (!scripted || !canaryControls) throw new Error('canary requires --canary-controls');
      const session = scripted.sessions.get(taskId);
      if (!session) throw new Error('no runtime session for canary');
      if (!session.instruction.includes(text)) throw new Error('device did not open instruction');
      session.emit({ type: 'progress', text: `Progress ${text}` });
      for (const deadline = Date.now() + 60_000; !session.steers.includes(`Steer ${text}`);) {
        if (session.closed || Date.now() > deadline) throw new Error('canary steer timed out');
        await delay(25, undefined, { signal });
      }
      if (!session.start.approvalChannel) throw new Error('canary approval channel missing');
      const approval = session.start.approvalChannel.request(`Approve ${text}`);
      let cancel!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        cancel = () => reject(new Error('canary interrupted'));
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      });
      try {
        if (!(await Promise.race([approval, aborted])).approved) throw new Error('canary approval refused');
      } finally { signal.removeEventListener('abort', cancel); }
      signal.throwIfAborted();
      await writeFile(path.join(session.workspaceDir, 'notes.txt'), `${text}${'.'.repeat(70_000)}`);
      session.emit({ type: 'artifact', name: 'notes.txt', contentType: 'text/plain' });
      for (let i = 0; i < 2; i++) session.emit({ type: 'progress', text: `${text}${'.'.repeat(sealed ? 140_000 : 60_000)}` });
      await session.finish({ text });
      for (const deadline = Date.now() + 60_000; !session.closed || daemon.status().activeTaskCount > 0;) {
        if (Date.now() > deadline) throw new Error('canary cleanup timed out');
        await delay(25, undefined, { signal });
      }
      send({ type: 'finished', taskId });
    },
    async stop() { lifetime.abort(); binding.resolve(false); unsubscribe(); await daemon.stop(); },
  };
}
