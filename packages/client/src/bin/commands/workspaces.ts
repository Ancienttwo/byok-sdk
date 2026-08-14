import type { DaemonConfig } from '../../index';
import { GIT_ERROR_CATEGORIES } from '../../daemon/git-workspace';
import { GitWorkspaceStore, type GitWorkspaceLedgerRecord } from '../../daemon/git-workspace-store';
import { resolveStoreDir } from '../config';

/**
 * Error categories stable enough to render from a ledger record — projected
 * from `daemon/git-workspace.ts`'s `GIT_ERROR_CATEGORIES` (the single source
 * of truth for the `GitErrorCategory` union) rather than carrying a literal
 * copy that could drift from it; the runtime half of that guarantee is
 * `__tests__/git-category-drift.test.ts`.
 *
 * @internal Exported for the drift-guard test only (never re-exported from
 * `index.ts`).
 */
export const STABLE_ERROR_CATEGORIES = new Set<string>(GIT_ERROR_CATEGORIES);

export interface WorkspacesCommandDeps {
  log?: (line: string) => void;
  store?: Pick<GitWorkspaceStore, 'list'>;
  showPaths?: boolean;
}

function abbreviateCommit(value: string | undefined): string {
  if (!value) return '-';
  return value.length > 8 ? value.slice(0, 8) : value;
}

function formatWorkspaceLine(record: GitWorkspaceLedgerRecord, showPaths: boolean): string {
  const parts = [
    `taskId=${record.taskId}`,
    `workspaceId=${record.workspaceId}`,
    `phase=${record.phase}`,
    `baseline=${abbreviateCommit(record.baseline)}`,
    `current=${abbreviateCommit(record.current)}`,
    `commits=${record.commitsSinceBaseline}`,
    `dirty=${record.staged}/${record.unstaged}/${record.untracked}/${record.conflicted}`,
    `updatedAt=${record.updatedAt}`,
  ];
  if (record.errorCategory && STABLE_ERROR_CATEGORIES.has(record.errorCategory)) parts.push(`error=${record.errorCategory}`);
  if (showPaths) parts.push(`path=${record.workspaceDir}`);
  return parts.join(' ');
}

/**
 * Lists the private Git workspace ledger without probing or changing any
 * workspace. The ledger store already defines missing, corrupt, and future
 * version behavior; this command deliberately preserves those outcomes.
 */
export async function runWorkspacesCommand(config: DaemonConfig, deps: WorkspacesCommandDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const store = deps.store ?? new GitWorkspaceStore(resolveStoreDir(config));
  const records = await store.list();
  if (records.length === 0) {
    log('(no workspaces recorded)');
    return;
  }
  for (const record of records) log(formatWorkspaceLine(record, deps.showPaths === true));
}

export { abbreviateCommit, formatWorkspaceLine };
