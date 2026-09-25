import { buildRuntimeEnv } from '../../daemon/environment';
import { PROVIDER_CREDENTIAL_ENV_NAMES } from '../provider-credential-environment';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensureSecureDir } from '../../util/secure-dir';
import {
  CONTROLLED_PI_DIRECTORY_ENV_NAMES, projectKeysPiInheritedEnvironment,
  parseImplementationSpawnBinding, type RuntimeEntryV1,
  type ImplementationSpawnBindingV1, type ToolImplementationAuthority, type ResolvedRuntimeImplementationV1,
} from '@byok-sdk/implementation-identity';
import {
  decideRuntimeLaunch, resolveRuntimeImplementation, type RuntimeLaunchDecisionV1, type RuntimeLaunchKindV1,
} from '../../daemon/tool-implementation-identity';
import { resolveTrustedLaunchCwd } from '../../daemon/trusted-launch-cwd';
import { RuntimeExecutionFailure } from '../../runtime-failure';
import { resolvePiRuntimeIdentity } from './resolve-bin';
import { createRuntimeDescendantPlan, requiredRuntimePlanKinds, type RuntimeDescendantPlanV1 } from './runtime-descendant-plan';

export interface PiRuntimeLaunchResources {
  readonly kind: RuntimeLaunchKindV1;
  readonly declaration: ResolvedRuntimeImplementationV1;
  readonly decision: RuntimeLaunchDecisionV1;
  readonly binding: ImplementationSpawnBindingV1;
  readonly descendantPlan: RuntimeDescendantPlanV1 | null;
  readonly env: Readonly<Record<string, string>>;
  readonly sessionCwd: string;
  readonly credentialSource: 'pi-auth-store' | 'keys-profile';
  /** A single client-owned cleanup authority, idempotent across declined/start/terminal paths. */
  release(): Promise<void>;
}

function failure(reason: string): RuntimeExecutionFailure {
  return new RuntimeExecutionFailure({ phase: 'start', category: 'authority', retry: 'non-retryable', reason });
}

export async function resolvePiRuntimeLaunch(options: {
  authority?: ToolImplementationAuthority;
  kind: RuntimeLaunchKindV1;
  sessionCwd: string;
  env: Readonly<Record<string, string | undefined>>;
  projectionRoot: string;
  keysSessionDir?: string;
  /** Evaluated only after an explicitly unconfigured authority decision. */
  resolveDevInvocation: () => { command: string; entry?: string };
}): Promise<PiRuntimeLaunchResources> {
  const source = options.keysSessionDir === undefined ? 'pi-auth-store' : 'keys-profile';
  const original = Object.fromEntries(Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const inherited = options.kind === 'pi-prepared'
    ? buildRuntimeEnv({ ambient: original, requirements: {
      baseNames: [...CONTROLLED_PI_DIRECTORY_ENV_NAMES],
      credentialNames: PROVIDER_CREDENTIAL_ENV_NAMES,
    } })
    : original;
  let env = source === 'keys-profile' ? projectKeysPiInheritedEnvironment(inherited) : { ...inherited };
  let projectionDir: string | undefined;
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    if (projectionDir !== undefined) await fs.rm(projectionDir, { recursive: true, force: true });
    released = true;
  };
  try {
    if (options.keysSessionDir !== undefined) {
      const root = path.resolve(options.projectionRoot);
      const session = path.resolve(options.sessionCwd);
      if (root === session || root.startsWith(`${session}${path.sep}`)) throw failure('runtime projection root is inside session cwd');
      await ensureSecureDir(root);
      const stat = await fs.lstat(root);
      if (stat.isSymbolicLink() || !stat.isDirectory() || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700)
        || (process.getuid !== undefined && stat.uid !== process.getuid())) throw failure('runtime projection root is not owned private directory');
      const canonicalRoot = await fs.realpath(root);
      const canonicalSession = await fs.realpath(session);
      if (canonicalRoot === canonicalSession || canonicalRoot.startsWith(`${canonicalSession}${path.sep}`)) {
        throw failure('runtime projection root resolves inside session cwd');
      }
      projectionDir = await fs.mkdtemp(path.join(canonicalRoot, 'pi-'));
      await ensureSecureDir(projectionDir);
      env.PI_CODING_AGENT_DIR = projectionDir;
      env.PI_CODING_AGENT_SESSION_DIR = options.keysSessionDir;
    }
    const declaration = await resolveRuntimeImplementation(options.authority,
      { subject: { kind: 'runtime', runtimeId: 'pi' }, runtimeEntry: options.kind },
      (record) => {
        if (record.assetRoot !== undefined) env = { ...env, PI_PACKAGE_DIR: record.assetRoot };
        return env;
      });
    const identity = declaration.kind === 'attested' ? declaration.identity : declaration;
    if (options.authority !== undefined && identity.kind === 'unavailable' && identity.reason === 'resolver_unconfigured') {
      throw failure('configured runtime authority returned resolver_unconfigured');
    }
    const directoryValues = Object.fromEntries(CONTROLLED_PI_DIRECTORY_ENV_NAMES.flatMap((name) => env[name] === undefined ? [] : [[name, env[name]!]]));
    const decision = decideRuntimeLaunch(identity, {
      runtimeId: 'pi', kind: options.kind, sessionCwd: options.sessionCwd,
      pin: resolvePiRuntimeIdentity(), credentialSource: source, directoryValues,
    });
    if (decision.kind === 'declined') throw failure(`runtime implementation unavailable: ${decision.reason}`);
    let binding: ImplementationSpawnBindingV1;
    if (decision.kind === 'attested') {
      const description = decision.description;
      binding = Object.freeze({ format: 'byok.implementation-spawn', version: 1, identity,
        command: description.command, ...(description.entry === undefined ? {} : { entry: description.entry }),
        fixedArgv: description.fixedArgv, cwd: description.processCwd, envCommitments: description.directoryValues });
    } else {
      const dev = options.resolveDevInvocation();
      const cwd = await resolveTrustedLaunchCwd();
      if (cwd.kind !== 'resolved') throw failure(`Pi process cwd unavailable: ${cwd.reason}`);
      binding = Object.freeze({ format: 'byok.implementation-spawn', version: 1, identity,
        command: dev.command, ...(dev.entry === undefined ? {} : { entry: dev.entry }),
        fixedArgv: Object.freeze([]), cwd: cwd.dir, envCommitments: Object.freeze(directoryValues) });
    }
    let descendantPlan: RuntimeDescendantPlanV1 | null = null;
    if (declaration.kind === 'attested') {
      const rows: {kind: RuntimeEntryV1; template: ImplementationSpawnBindingV1}[] = [{kind:options.kind,template:binding}];
      const required = requiredRuntimePlanKinds(options.kind, declaration.descendantPolicy, declaration.edges);
      // Each prefix comes from its own Host-resolved locator. Never retarget a
      // parent's binding, synthesize unavailable rows or discover another bin.
      for (const kind of required) {
        if (kind === options.kind) continue;
        const descendant = await resolveRuntimeImplementation(options.authority,
          {subject:{kind:'runtime',runtimeId:'pi'},runtimeEntry:kind}, env);
        if (descendant.kind !== 'attested') throw failure(`descendant implementation unavailable: ${kind}: ${descendant.reason}`);
        if (JSON.stringify(descendant.descendantPolicy) !== JSON.stringify(declaration.descendantPolicy)
          || JSON.stringify(descendant.edges) !== JSON.stringify(declaration.edges)) throw failure('descendant declaration differs from self');
        const identity = descendant.identity;
        const template = parseImplementationSpawnBinding({format:'byok.implementation-spawn',version:1,identity,
          command:identity.form === 'interpreter+bundle' ? identity.interpreter?.path : identity.installPath,
          ...(identity.form === 'interpreter+bundle' ? {entry:identity.installPath} : {}),
          fixedArgv:identity.launchArgv,cwd:identity.launchCwd,envCommitments:binding.envCommitments});
        if (template === undefined) throw failure('descendant implementation binding is invalid');
        rows.push({kind,template});
      }
      try {
        descendantPlan = createRuntimeDescendantPlan(options.kind,binding,declaration,rows);
      } catch (error) {
        throw failure(error instanceof Error ? error.message : String(error));
      }
    }
    return Object.freeze({ kind: options.kind, declaration, decision, binding, descendantPlan, env: Object.freeze(env), sessionCwd: options.sessionCwd,
      credentialSource: source, release });
  } catch (error) {
    await release();
    throw error;
  }
}
