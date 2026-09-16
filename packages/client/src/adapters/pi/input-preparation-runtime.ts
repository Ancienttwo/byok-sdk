import type { ToolImplementationAuthority } from '@byok-sdk/implementation-identity';
import { decideRuntimeLaunch, resolveRuntimeImplementation } from '../../daemon/tool-implementation-identity';
import { resolvePiRuntimeIdentity } from './resolve-bin';
import {
  createPiInputPreparationCompiler, InputPreparationRuntimeIdentityError,
  piRuntimeIdentityFromAttestedRecord, resolveInstalledPiRuntimeIdentity,
  type InputPreparationCompiler,
} from './input-preparation';

/** Resolve once before daemon admission. Configured refusal never discovers a dev package. */
export async function resolvePiInputPreparationCompiler(options: {
  authority?: ToolImplementationAuthority;
  env: Readonly<Record<string, string>>;
  sessionCwd: string;
}): Promise<InputPreparationCompiler> {
  if (options.authority === undefined) {
    return createPiInputPreparationCompiler(resolveInstalledPiRuntimeIdentity());
  }
  const declaration = await resolveRuntimeImplementation(options.authority,
    { subject: { kind: 'runtime', runtimeId: 'pi' }, runtimeEntry: 'pi-prepared' },
    record => ({ ...options.env, ...(record.assetRoot === undefined ? {} : { PI_PACKAGE_DIR: record.assetRoot }) }));
  const identity = declaration.kind === 'attested' ? declaration.identity : declaration;
  if (identity.kind !== 'attested') {
    throw new InputPreparationRuntimeIdentityError(`configured pi-prepared implementation unavailable: ${identity.reason}`);
  }
  const decision = decideRuntimeLaunch(identity, {
    runtimeId: 'pi', kind: 'pi-prepared', sessionCwd: options.sessionCwd,
    pin: resolvePiRuntimeIdentity(), credentialSource: 'pi-auth-store',
    directoryValues: identity.assetRoot === undefined ? {} : { PI_PACKAGE_DIR: identity.assetRoot },
  });
  if (decision.kind !== 'attested') {
    throw new InputPreparationRuntimeIdentityError(`configured pi-prepared launch unavailable: ${decision.kind === 'declined' ? decision.reason : decision.kind}`);
  }
  return createPiInputPreparationCompiler(piRuntimeIdentityFromAttestedRecord(identity));
}
