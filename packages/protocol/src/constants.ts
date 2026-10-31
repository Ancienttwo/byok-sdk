/** Schema-free protocol values. Import this entry when runtime schemas are unnecessary. */
export * from './version';
export * from './task-state';
export * from './capability-constants';
export * from './failure-reason';

/** Maximum raw UTF-8 content bytes in one local Host Agent-memory export; no truncation. */
export const AGENT_MEMORY_MAX_SNAPSHOT_BYTES = 1024 * 1024;
/** Maximum memory files in one local Host export, including MEMORY.md. */
export const AGENT_MEMORY_MAX_SNAPSHOT_FILES = 128;

/** The frozen wire runtime ids. Any other adapter id is a custom harness (`harnessId`). */
export const RUNTIME_IDS = Object.freeze(['pi', 'claude', 'codex'] as const);

/**
 * Why a runtime is unavailable before claim (#1103 D6). Append-only: a cause is
 * never renamed, removed or given a new meaning. The wire reads an unknown
 * well-formed token as `unknown` and keeps it verbatim (#1121), so a newer
 * device can add one without a protocol bump. Names are snake_case, unlike the
 * kebab-case detection kinds, because the mapping is explicit and never a
 * string transformation.
 */
export const RUNTIME_UNAVAILABLE_CAUSES = Object.freeze([
  /** Detection: `not-found`. */
  'not_installed',
  /** Detection: `not-executable`. */
  'not_executable',
  /** Detection: `timeout`. */
  'probe_timeout',
  /** Detection: `probe-failed`. */
  'probe_failed',
  /** Detection: `refused` / `app_server_unavailable`. */
  'app_server_unavailable',
  /** Detection: `refused` / `acp_unavailable`. */
  'acp_unavailable',
  /** Detection: `refused` / `platform_unsupported`. */
  'platform_unsupported',
  /** The login-shell environment capture failed (#1095). */
  'environment_unavailable',
  /** A Host-configured version policy blocked the installed token (#1103). */
  'version_blocked',
  /** The offer named an id this daemon has no adapter for. */
  'runtime_not_configured',
  /** The device runtime allowlist excludes the requested id. */
  'runtime_not_allowed',
  /** Automatic selection exhausted every candidate. */
  'none_available',
] as const);

/** One append-only `runtime_unavailable` cause. */
export type RuntimeUnavailableCause = (typeof RUNTIME_UNAVAILABLE_CAUSES)[number];

/** Maximum length of a served model name. */
export const TERMINAL_INFERENCE_USAGE_MODEL_MAX_LENGTH = 160;
