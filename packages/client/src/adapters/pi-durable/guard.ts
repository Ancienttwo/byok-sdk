import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { realpath, lstat } from 'node:fs/promises';

function contained(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
/** Resolve every existing ancestor, including the nearest parent of a new file. */
async function canonical(candidate: string): Promise<string> {
  try { return await realpath(candidate); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A dangling symlink is a denial, not a new pathname.
    try { if ((await lstat(candidate)).isSymbolicLink()) throw new Error('dangling tool path'); }
    catch (statError) { if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError; }
    const parent = path.dirname(candidate);
    if (parent === candidate) throw error;
    return path.join(await canonical(parent), path.basename(candidate));
  }
}
/** Public-tool spelling, mirrored from exact Pi 1.0 (private path-utils is not imported). */
export function normalizeDurableToolPath(value: string): string {
  const spaces = value.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu, ' ');
  return spaces.startsWith('@') ? spaces.slice(1) : spaces;
}
function toolPath(cwd: string, value: string): string {
  let normalized = normalizeDurableToolPath(value);
  if (normalized === '~') normalized = homedir();
  else if (normalized.startsWith('~/') || (process.platform === 'win32' && normalized.startsWith('~\\'))) normalized = path.join(homedir(), normalized.slice(2));
  else if (normalized.startsWith('file://')) { try { normalized = fileURLToPath(normalized); } catch {} }
  return path.resolve(cwd, normalized);
}
/** Bash is YOLO: literal loader/control assignments are denied; no shell path sandbox is claimed. */
export async function durableToolDenial(name: string, args: Record<string, unknown>, cwd: string, replicaRoot: string): Promise<string | undefined> {
  if (name === 'bash') {
    if (typeof args.command !== 'string') return 'invalid shell command';
    return /\b(?:BYOK_[A-Z0-9_]*|LD_[A-Z0-9_]*|DYLD_[A-Z0-9_]*|NODE_OPTIONS)\s*=/u.test(args.command)
      ? 'loader or BYOK control assignment denied' : undefined;
  }
  if (!['read', 'write', 'edit'].includes(name)) return undefined;
  if (typeof args.path !== 'string' || args.path.length === 0) return 'invalid structured tool path';
  const candidate = toolPath(cwd, args.path);
  const home = await realpath(cwd), store = await canonical(path.resolve(replicaRoot));
  const candidates = name === 'read' ? [candidate, candidate.replace(/ (AM|PM)\./giu, '\u202F$1.'), candidate.normalize('NFD'), candidate.replace(/'/gu, '\u2019'), candidate.normalize('NFD').replace(/'/gu, '\u2019')] : [candidate];
  for (const variant of new Set(candidates)) {
    const resolved = await canonical(variant);
    if (!contained(path.resolve(cwd), candidate) || !contained(home, resolved) || contained(store, resolved)) return 'structured tool path outside workspace or inside replica store';
  }
  return undefined;
}
