import { hasUserKeyShape } from './admission';
import { CloudDoError } from './errors';
import { RollingLeakGuard } from './leak-guard';
import { PLATFORM_PROFILES, platformCredentialReader, type PlatformProfileId } from './platform-credentials';

/** Keep the existing pre-storage text guard shared by submission and tool data. */
export async function admitCloudText(env: Readonly<Record<string, unknown>>, text: string, selected?: PlatformProfileId): Promise<void> {
  if (typeof text !== 'string') throw new CloudDoError('CLOUD_REQUEST_INVALID');
  if (hasUserKeyShape(text)) throw new CloudDoError('CLOUD_USER_CREDENTIAL_REJECTED');
  const credentials = platformCredentialReader(env);
  for (const [id, profile] of Object.entries(PLATFORM_PROFILES)) {
    let key: string | undefined;
    try {
      if (env[profile.binding] === undefined) continue;
      key = await credentials.get(profile.secretName);
    } catch {
      // A broken unused profile does not disable a valid selected provider.
      // Every valid configured key still gets the pre-storage text check.
      if (selected && id !== selected) continue;
      throw new CloudDoError('CLOUD_MODEL_CREDENTIAL_UNAVAILABLE');
    }
    const guard = new RollingLeakGuard(key!);
    try { guard.push(text); guard.finish(); }
    catch { throw new CloudDoError('CLOUD_USER_CREDENTIAL_REJECTED'); }
  }
}

/** Check decoded JSON values before any part enters pi or the invocation ledger. */
export async function admitCloudPayload(env: Readonly<Record<string, unknown>>, value: unknown, selected?: PlatformProfileId): Promise<void> {
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = async (item: unknown, depth: number): Promise<void> => {
    if (++nodes > 10_000 || depth > 32) throw new CloudDoError('CLOUD_REQUEST_INVALID');
    if (typeof item === 'string') { await admitCloudText(env, item, selected); return; }
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return;
    if (!item || typeof item !== 'object' || ancestors.has(item)) throw new CloudDoError('CLOUD_REQUEST_INVALID');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new CloudDoError('CLOUD_REQUEST_INVALID');
    }
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (Reflect.ownKeys(item).length !== item.length + 1) throw new CloudDoError('CLOUD_REQUEST_INVALID');
        for (let i = 0; i < item.length; i++) {
          const field = Object.getOwnPropertyDescriptor(item, String(i));
          if (!field || !('value' in field) || !field.enumerable) throw new CloudDoError('CLOUD_REQUEST_INVALID');
          await visit(field.value, depth + 1);
        }
      } else {
        for (const key of Reflect.ownKeys(item)) {
          const field = Object.getOwnPropertyDescriptor(item, key);
          // Accessors, symbols and hidden fields are not persisted JSON data.
          if (typeof key !== 'string' || !field || !('value' in field) || !field.enumerable) {
            throw new CloudDoError('CLOUD_REQUEST_INVALID');
          }
          await visit(key, depth + 1);
          await visit(field.value, depth + 1);
        }
      }
    } finally { ancestors.delete(item); }
  };
  await visit(value, 0);
}
