import path from 'node:path';
import type { AcpPermissionRequest } from '../../runtime/acp-session-runtime';
import { comparablePath } from '../../util/comparable-path';

/** A memory reader's Agent home and its own run directory, the only place below the home it may write. */
export interface AgyReaderScope {
  readonly home: string;
  readonly run: string;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(comparablePath(root), comparablePath(target));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * agy still asks for a file outside its workspace, even with
 * `--dangerously-skip-permissions`. A `cancelled` answer means the client
 * cancelled the turn, so every answer here is an explicit option. A writer runs
 * in all mode, as on other runtimes, and the reminders report what it wrote. A
 * reader may read its home but not write there; `--add-dir` would open both.
 */
export function agyPermissionDecision(request: AcpPermissionRequest, reader: AgyReaderScope | undefined): 'allow_once' | 'reject_once' {
  if (reader === undefined || request.toolCall.kind === 'read') return 'allow_once';
  const located = (request.toolCall.locations ?? []).map(location => location.path);
  const input = (request.toolCall.rawInput as { readonly Path?: unknown } | null | undefined)?.Path;
  const targets = typeof input === 'string' ? [...located, input] : located;
  return targets.map(target => path.resolve(reader.run, target)).some(target => inside(reader.home, target) && !inside(reader.run, target))
    ? 'reject_once' : 'allow_once';
}
