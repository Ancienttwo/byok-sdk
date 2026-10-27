/** Schema-free protocol values. Import this entry when runtime schemas are unnecessary. */
export * from './version';
export * from './task-state';
export * from './capability-constants';

/** Maximum raw UTF-8 content bytes in one local Host Agent-memory export; no truncation. */
export const AGENT_MEMORY_MAX_SNAPSHOT_BYTES = 1024 * 1024;
/** Maximum memory files in one local Host export, including MEMORY.md. */
export const AGENT_MEMORY_MAX_SNAPSHOT_FILES = 128;

/** The frozen wire runtime ids. Any other adapter id is a custom harness (`harnessId`). */
export const RUNTIME_IDS = Object.freeze(['pi', 'claude', 'codex'] as const);

/** Maximum length of a served model name. */
export const TERMINAL_INFERENCE_USAGE_MODEL_MAX_LENGTH = 160;
