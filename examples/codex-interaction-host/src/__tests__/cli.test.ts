import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const running: { child: ReturnType<typeof spawn>; done: Promise<number | null> }[] = [];
afterEach(async () => {
  for (const { child, done } of running.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    // The bounded hook waits for the CLI's own SDK disposal receipt. Never let
    // a failed readiness assertion leave its process overlapping the next case.
    await done;
  }
});
function start(args: string[]) {
  // Same compiled entrypoint a local operator runs, with only controlled stdin.
  const child = spawn(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout!.setEncoding('utf8'); child.stdout!.on('data', chunk => { stdout += chunk; });
  child.stderr!.setEncoding('utf8'); child.stderr!.on('data', chunk => { stderr += chunk; });
  const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  running.push({ child, done });
  const lines = (type: string): Record<string, any>[] => stdout.split('\n').filter(line => line.startsWith(`${type} `))
    .map(line => JSON.parse(line.slice(type.length + 1)));
  return { child, done, lines, stdout: () => stdout, stderr: () => stderr };
}
describe('compiled fixture-only CLI', () => {
  it.each([[], ['--live'], ['--fixture', 'unknown']].map(args => ({ args })))
  ('refuses $args without starting a session', async ({ args }) => {
    const f = start(args); expect(await f.done).toBe(2);
    expect(f.stdout()).toBe(''); expect(f.stderr()).toContain('No live Codex launcher');
  });
  it('displays a native request, accepts controlled terminal input, and prints a local receipt', async () => {
    const f = start(['--fixture', 'approval']);
    await vi.waitFor(() => { expect(f.stderr()).toBe(''); expect(f.lines('answer-template')).toHaveLength(1); }, { timeout: 15_000 });
    const answer: Record<string, unknown> = { ...f.lines('answer-template')[0], decision: 'deny' };
    f.child.stdin!.write(`${JSON.stringify(answer)}\n`);
    expect(await f.done).toBe(0);
    expect(f.lines('receipt')).toEqual([expect.objectContaining({ requestId: answer.requestId,
      status: 'responded', duplicate: false, meaning: 'local-transport-write-only' })]);
    expect(f.lines('host')[0]?.mode).toBe('offline-fixture-only'); expect(f.stderr()).toBe('');
  });
  it('Ctrl-C closes the owned process without turning the pending request into approval', async () => {
    const f = start(['--fixture', 'approval']);
    await vi.waitFor(() => { expect(f.stderr()).toBe(''); expect(f.lines('request')).toHaveLength(1); }, { timeout: 15_000 });
    f.child.kill('SIGINT'); expect(await f.done).toBe(0);
    expect(f.lines('receipt')).toEqual([expect.objectContaining({ status: 'cancelled', reason: 'closed' })]);
    expect(f.lines('error')).toEqual([]);
  });
});
