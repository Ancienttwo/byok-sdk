import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { ProviderProfileBinding } from '@byok-sdk/protocol';
import type { RuntimeAdapterPrepareInput, RuntimeDetectResult } from '../../types';
import type { HermesAdapterOptions, HermesModelSelection } from './hermes-adapter';
import type { HermesByokLauncher, PreparedHermesCustody } from './hermes-custody';
import type { HermesGatewayIdentity } from './gateway-identity';
import { hermesVersionLine } from './hermes-version';

/** Caller-owned dependencies preserve runtime identities across the private lazy boundary. */
interface Dependencies {
  createHermesProfile: typeof import('./hermes-home').createHermesProfile;
  removeHermesProfile: typeof import('./hermes-home').removeHermesProfile;
  createOwnedLineProcessSpawn: typeof import('../../runtime/owned-line-process').createOwnedLineProcessSpawn;
  hermesEnvironment: (base: Readonly<Record<string, string | undefined>>, home: string) => Record<string, string>;
  buildAllowlistedEnv: typeof import('../../daemon/environment').buildAllowlistedEnv;
  buildRuntimeEnv: typeof import('../../daemon/environment').buildRuntimeEnv;
  AcpConnection: typeof import('./acp-connection').AcpConnection;
  AcpMethodNotFound: typeof import('./acp-connection').AcpMethodNotFound;
  withDeadline: <T>(promise: Promise<T>, ms: number, signal: AbortSignal | undefined, onTimeout: () => Error) => Promise<T>;
  INITIALIZE_PARAMS: Record<string, unknown>;
  classifyDetectError: typeof import('../detect-outcome').classifyDetectError;
  assertHermesModelSelection: typeof import('./hermes-home').assertHermesModelSelection;
  hermesCustodyArgs: typeof import('./hermes-custody').hermesCustodyArgs;
  identifyHermesGateway: typeof import('./gateway-identity').identifyHermesGateway;
}

export function createHermesAsyncRuntime(deps: Dependencies) {
  const { createHermesProfile, removeHermesProfile, createOwnedLineProcessSpawn, hermesEnvironment, buildAllowlistedEnv, buildRuntimeEnv, AcpConnection, AcpMethodNotFound, withDeadline, INITIALIZE_PARAMS, classifyDetectError, assertHermesModelSelection, hermesCustodyArgs, identifyHermesGateway } = deps;
  const VERSION_TIMEOUT_MS = 5_000;
  const GATEWAY_POLL_MS = 100;
type ProbeFailure = Exclude<RuntimeDetectResult, { kind: 'available' }>;

/**
 * `hermes --version` with the SDK root as `HERMES_HOME`. The shared probe
 * would use the ambient home: Hermes then reads the user's `~/.hermes` config
 * and writes its update-check cache there.
 */
function probeHermesVersion(command: string, env: Record<string, string>): Promise<{ kind: 'available'; line: string } | ProbeFailure> {
  return new Promise((resolve) => {
    try {
      execFile(command, ['--version'], { encoding: 'utf8', env, timeout: VERSION_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
        if (error === null) resolve({ kind: 'available', line: hermesVersionLine(stdout) || hermesVersionLine(stderr) });
        else if ((error as { code?: unknown }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') resolve({ kind: 'probe-failed' });
        else if (error.killed === true && error.signal === 'SIGKILL') resolve({ kind: 'timeout' });
        else resolve(classifyDetectError(error));
      });
    } catch (error) {
      resolve(classifyDetectError(error));
    }
  });
}

/** A busy gateway can miss one `identify` deadline; ask a few times before treating it as gone. */
async function identifyAfterAttach(home: string): Promise<HermesGatewayIdentity | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const identity = await identifyHermesGateway(home);
    if (identity !== undefined) return identity;
    await new Promise((resolve) => setTimeout(resolve, GATEWAY_POLL_MS));
  }
  return undefined;
}

/** SIGKILL to a detached Hermes gateway's own process group (it starts in a new session), else to the pid. */
function stopProcessGroup(pid: number): void {
  try { process.kill(-pid, 'SIGKILL'); } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

  async function probeAcp(root: string, options: HermesAdapterOptions, command: string, signal: AbortSignal | undefined): Promise<{ kind: 'available'; authPresent: boolean } | ProbeFailure> {
    const home = await createHermesProfile(root, `detect-${randomBytes(6).toString('hex')}`, options.model);
    const child = createOwnedLineProcessSpawn({ nativeAssetRoot: options.nativeAssetRoot, spawnFn: options.spawnFn })(command, ['acp'], {
      cwd: home, env: hermesEnvironment(options.byokLauncher ? buildAllowlistedEnv({ ambient: process.env }) : buildRuntimeEnv({ ambient: process.env }), home),
    });
    let timedOut = false;
    try {
      await child.spawned;
      const connection = new AcpConnection(child, {
        notification: () => {},
        request: (method) => { throw new AcpMethodNotFound(method); },
      });
      child.onExit(() => connection.close(new Error('hermes acp exited during the probe')));
      const result = await withDeadline(
        connection.request('initialize', INITIALIZE_PARAMS),
        options.probeTimeoutMs ?? 180_000,
        signal,
        () => { timedOut = true; return new Error('timeout'); },
      ) as { protocolVersion?: unknown; authMethods?: unknown } | null;
      if (result?.protocolVersion !== 1) return { kind: 'probe-failed' };
      const methods = Array.isArray(result.authMethods) ? result.authMethods as Array<{ id?: unknown; type?: unknown }> : [];
      return { kind: 'available', authPresent: methods.some((method) => method.type === undefined && typeof method.id === 'string' && method.id !== 'hermes-setup') };
    } catch {
      return timedOut ? { kind: 'timeout' } : { kind: 'probe-failed' };
    } finally {
      await child.dispose().catch(() => {});
      await removeHermesProfile(root, home).catch(() => {});
    }
  }


  return { probeHermesVersion, probeAcp, prepareHermesCustody: (launcher: HermesByokLauncher, offer: RuntimeAdapterPrepareInput['offer']) => prepareHermesCustody(launcher, offer, deps), identifyAfterAttach, stopProcessGroup };
}

export async function prepareHermesCustody(launcher: HermesByokLauncher, offer: RuntimeAdapterPrepareInput['offer'], { hermesCustodyArgs, buildAllowlistedEnv, assertHermesModelSelection }: Pick<Dependencies, 'hermesCustodyArgs' | 'buildAllowlistedEnv' | 'assertHermesModelSelection'>): Promise<PreparedHermesCustody> {
  // Copy only non-secret binding fields. The keys launcher owns strict validation;
  // keep the adapters entry free of runtime protocol/Zod dependencies.
  const selected = await launcher.selectProfile(offer);
  const binding: ProviderProfileBinding = {
    profileRef: selected.profileRef, profileRevision: selected.profileRevision,
    profileHash: selected.profileHash, modelId: selected.modelId,
    requiredCapabilities: [...selected.requiredCapabilities],
  };
  const stdout = await new Promise<string>((resolve, reject) => execFile(launcher.command, hermesCustodyArgs(launcher, binding),
    { env: buildAllowlistedEnv({ ambient: process.env }), timeout: 5000, maxBuffer: 16_384, encoding: 'utf8' },
    (error, output) => error ? reject(new Error('Hermes custody admission failed')) : resolve(output)));
  const model = JSON.parse(stdout) as HermesModelSelection;
  assertHermesModelSelection(model, 'Hermes custody model');
  if (model.provider !== 'custom' || model.model !== binding.modelId || model.keyEnv !== 'SDK_HERMES_PROVIDER_KEY' || model.baseUrl === undefined) throw new Error('Hermes custody model mismatch');
  return { binding, model };
}
