/**
 * An absolute path in quotes, as Node filesystem errors name it
 * (`open '/path'`). The matching quote ends it, so every segment may hold
 * spaces, the last one too.
 */
const QUOTED_LOCAL_PATH = /(['"`])(?:\/|[A-Za-z]:[\\/]|\\\\)(?:(?!\1)[^\r\n])*\1/g;

/**
 * The absolute command of a Node spawn error (`spawn /path ENOENT`). Node
 * does not quote it, so the error code after it ends it, and every segment
 * may hold spaces, the last one too.
 */
const SPAWN_LOCAL_PATH = /(?<=(?:^|\s)spawn(?:Sync)? )(?:\/|[A-Za-z]:[\\/]|\\\\)[^\r\n]*?(?= (?:E[A-Z0-9]+|UNKNOWN)(?!\w))/g;

/**
 * An absolute POSIX, drive-letter or UNC path that starts a token. Inner
 * segments may hold spaces (`Application Support/`); the last segment ends at
 * the first space, so the words after the path stay.
 */
const ABSOLUTE_LOCAL_PATH = /(?<=^|[\s'"`(=])(?:\/|[A-Za-z]:[\\/]|\\\\)(?:[^\s'"`,;)\\/]+(?: +[^\s'"`,;)\\/]+)*[\\/])*[^\s'"`,;)\\/]*/g;

/**
 * Agent-home and session-handoff errors, and the filesystem errors under
 * them, name local paths: the canonical home, lease markers, run directories.
 * So do the filesystem errors of the preparation store, the Agent message
 * outbox, the artifact open and a runtime adapter's detect/prepare, and an
 * MCP server probe's spawn error and quoted stderr.
 * `task.decline`, `task.fail` and `task.progress` leave this device, so a
 * reason that forwards one keeps the error's wording and drops each absolute
 * path.
 */
export function outboundErrorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err))
    .replace(QUOTED_LOCAL_PATH, '$1<local path>$1')
    .replace(SPAWN_LOCAL_PATH, '<local path>')
    .replace(ABSOLUTE_LOCAL_PATH, '<local path>');
}
