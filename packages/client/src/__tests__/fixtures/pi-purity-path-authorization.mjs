// Pure path policy: no filesystem, process, environment or native descriptor access.
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function nativeAuthorizationPath(value, openCwd) {
  let native;
  if (value instanceof URL) {
    try { native = fileURLToPath(value); } catch { return undefined; }
  } else if (Buffer.isBuffer(value)) native = value.toString('utf8');
  else if (typeof value === 'string') native = value;
  else return undefined;
  // Strings, including literal "file:" names, keep native path semantics.
  return path.resolve(openCwd, native);
}

export function rememberAuthorizedFd(authorizations, fd, value, openCwd) {
  if (!Number.isInteger(fd) || fd < 0) return;
  const native = nativeAuthorizationPath(value, openCwd);
  // A reused descriptor must never inherit an older authorization.
  authorizations.delete(fd);
  if (native !== undefined) authorizations.set(fd, native);
}

export function authorizationPath(authorizations, value, currentCwd) {
  return typeof value === 'number' ? authorizations.get(value)
    : nativeAuthorizationPath(value, currentCwd);
}

export function liesWithinReadRoots(native, roots) {
  return typeof native === 'string' && roots.some((root) =>
    native === root || native.startsWith(`${root}${path.sep}`));
}
