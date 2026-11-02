import type { BigIntStats } from 'node:fs';

/**
 * File-state comparisons for pathname-bound reads. Neither compares ctime:
 * metadata-only changes (a post-rename chmod, inherited Windows ACLs pushed by
 * icacls) move ctime without replacing the file or its bytes (#1342).
 */
type FileState = Pick<BigIntStats, 'dev' | 'ino' | 'size' | 'mtimeNs'>;

/** Same inode on the same device. */
export function sameFile(left: Pick<FileState, 'dev' | 'ino'>, right: Pick<FileState, 'dev' | 'ino'>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Same inode with the same size and content mtime. */
export function sameContent(left: FileState, right: FileState): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs;
}
