import { mkdtempSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { createExecutionScratch, ScratchRoot, type ExecutionScratch } from '../../daemon/retention/scratch';

const roots: string[] = [];
export function testScratchRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 's-'));
  roots.push(root);
  return root;
}
export function testScratchOwner(): ScratchRoot { return new ScratchRoot(testScratchRoot()); }
export function testExecutionScratch(): Promise<ExecutionScratch> { return createExecutionScratch({ root: testScratchRoot() }); }
afterAll(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
