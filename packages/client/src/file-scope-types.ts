/**
 * The closed file-scope result vocabulary. It is deliberately separate from
 * `file-scope-guard` so the loopback IPC and the adapter's grant serializer can
 * import it without loading the guard's filesystem primitives.
 */

/** The closed reasons the guard reports. */
export type FileScopeGuardReason =
  | 'outside_scope'
  | 'read_only'
  | 'symlink'
  | 'hardlink'
  | 'not_regular_file'
  | 'cross_device'
  | 'path_syntax'
  | 'cwd_outside_scope'
  | 'internal_path'
  | 'root_identity_changed'
  | 'unsupported_platform'
  | 'root_missing'
  | 'not_directory'
  | 'io_error';

export type FileScopeGuardCode = 'file_scope_denied' | 'file_scope_unavailable' | 'file_scope_unsupported';

/** Closed values the deny-audit channel may carry; anything else is rejected. */
export const FILE_SCOPE_GUARD_REASONS: readonly FileScopeGuardReason[] = Object.freeze([
  'outside_scope', 'read_only', 'symlink', 'hardlink', 'not_regular_file', 'cross_device',
  'path_syntax', 'cwd_outside_scope', 'internal_path', 'root_identity_changed',
  'unsupported_platform', 'root_missing', 'not_directory', 'io_error',
]);
export const FILE_SCOPE_GUARD_CODES: readonly FileScopeGuardCode[] = Object.freeze([
  'file_scope_denied', 'file_scope_unavailable', 'file_scope_unsupported',
]);
