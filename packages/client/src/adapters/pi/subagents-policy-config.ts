export const BYOK_PI_PERMISSION_MODE = 'BYOK_PI_PERMISSION_MODE';

/** SDK-owned extension tools that do not mutate the task workspace. */
export const BYOK_PI_READONLY_PARENT_TOOLS = ['subagent', 'todo'] as const;

/** Child tools retained when a readonly parent delegates through pi-subagents. */
export const BYOK_PI_READONLY_SUBAGENT_TOOLS = ['read', 'grep', 'find', 'ls'] as const;

/** Package-provided read-only roles; writer and ambient custom roles stay unavailable. */
export const BYOK_PI_READONLY_SUBAGENT_AGENTS = [
  'reviewer',
  'oracle',
  'codex-exec',
  'claude-code',
  'cursor-agent',
] as const;
