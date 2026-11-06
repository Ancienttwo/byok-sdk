import { existsSync, mkdtempSync, promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { createExecutionScratch, ScratchRoot, type ExecutionScratch } from '../../daemon/retention/scratch';

/** The context a reserved MCP entry points at: the file named by its last argument. */
export function reservedMcpContext(server: { readonly args?: readonly string[] } | undefined): Record<string, string> {
  return JSON.parse(readFileSync(server!.args!.at(-1)!, 'utf8')) as Record<string, string>;
}

/** The token of {@link reservedMcpContext}, or `undefined` for an entry the task did not get. */
export function reservedMcpToken(server: { readonly args?: readonly string[] } | undefined): string {
  return (server === undefined ? undefined : reservedMcpContext(server).contextToken) as string;
}

/** The nonce of a Host toolset entry, or `undefined` for an entry whose last argument names no such context file. */
export function hostToolsetToken(server: { readonly args?: readonly string[] } | undefined): string | undefined {
  const file = server?.args?.at(-1);
  return file !== undefined && path.basename(file).startsWith('host-toolset-') && existsSync(file) ? reservedMcpContext(server).contextToken : undefined;
}

const roots: string[] = [];
export function testScratchRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 's-'));
  roots.push(root);
  return root;
}
export function testScratchOwner(): ScratchRoot { return new ScratchRoot(testScratchRoot()); }
export function testExecutionScratch(): Promise<ExecutionScratch> { return createExecutionScratch({ root: testScratchRoot() }); }
afterAll(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
