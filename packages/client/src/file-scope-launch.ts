import type { ToolFileScope } from './tool-authorization';
import {
  FileScopeGuardError,
  resolveFileScopeGrant,
  type FileScopeGrant,
  type FileScopeIo,
} from './file-scope-guard';
import type { SerializedFileScopeGrant } from './file-scope-serialization';

export {
  parseSerializedFileScopeGrant,
  serializeFileScopeGrant,
  type SerializedFileScopeGrant,
  type SerializedFileScopeRoot,
} from './file-scope-serialization';

export interface VerifySerializedFileScopeGrantOptions {
  readonly platform?: NodeJS.Platform;
  readonly io?: FileScopeIo;
}

/**
 * Re-resolve every serialized root before a session exists and prove the
 * resulting grant still has the exact digest the daemon admitted. A missing,
 * replaced, symlinked or cross-platform root fails closed here; the host never
 * creates a session with a scope it could not verify.
 *
 * This is the only part of the launch format that touches the filesystem; the
 * adapter serializes grants through file-scope-serialization.ts, which is
 * deliberately free of fs imports.
 */
export async function verifySerializedFileScopeGrant(
  serialized: SerializedFileScopeGrant,
  options: VerifySerializedFileScopeGrantOptions = {},
): Promise<FileScopeGrant> {
  const fileScope: ToolFileScope = {
    mode: serialized.mode,
    ...(serialized.mode === 'home' ? {} : {
      roots: serialized.roots.map((root) => Object.freeze({ id: root.id, path: root.lexicalPath, access: root.access })),
    }),
  };
  let grant: FileScopeGrant;
  try {
    grant = await resolveFileScopeGrant({
      fileScope,
      home: { path: serialized.home.lexicalPath, identity: { dev: BigInt(serialized.home.dev), ino: BigInt(serialized.home.ino) } },
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.io === undefined ? {} : { io: options.io }),
    });
  } catch (error) {
    if (error instanceof FileScopeGuardError) throw error;
    throw new FileScopeGuardError('file_scope_unavailable', 'io_error', { cause: error });
  }
  if (grant.digest !== serialized.digest
    || grant.home.path !== serialized.home.path
    || grant.home.lexicalPath !== serialized.home.lexicalPath
    || grant.roots.length !== serialized.roots.length) {
    throw new FileScopeGuardError('file_scope_unavailable', 'root_identity_changed', { rootId: 'home' });
  }
  for (let index = 0; index < grant.roots.length; index += 1) {
    const actual = grant.roots[index]!;
    const expected = serialized.roots[index]!;
    if (actual.id !== expected.id || actual.path !== expected.path || actual.lexicalPath !== expected.lexicalPath
      || actual.access !== expected.access) {
      throw new FileScopeGuardError('file_scope_unavailable', 'root_identity_changed', { rootId: expected.id });
    }
  }
  return grant;
}
