import { describe, expect, it } from 'vitest';
import { spawnOwnedLineProcess } from '../runtime/owned-line-process';
describe('persistent Codex transport budget', () => {
  it.each([false, true])(
    'rejects oversized line before delivery (newline=%s)',
    async (newline) => {
      const child = spawnOwnedLineProcess(
        process.execPath,
        [
          '-e',
          `process.stdout.write('x'.repeat(1024*1024+1)+${JSON.stringify(newline ? '\n' : '')});setInterval(()=>{},1000)`,
        ],
        { env: {} },
      );
      const lines: string[] = [];
      child.onLine((line) => lines.push(line));
      await child.spawned;
      await expect(child.exited).rejects.toThrow('byte budget');
      expect(lines).toEqual([]);
    },
  );
  it('preserves split UTF8, CRLF and multiple frames', async () => {
    const child = spawnOwnedLineProcess(
      process.execPath,
      [
        '-e',
        `const b=Buffer.from('{"text":"中文"}\\r\\n{}\\n');for(const byte of b)process.stdout.write(Buffer.from([byte]));`,
      ],
      { env: {} },
    );
    const lines: string[] = [];
    child.onLine((line) => lines.push(line));
    await child.exited;
    expect(lines).toEqual(['{"text":"中文"}', '{}']);
  });
  it('delivers a large Unicode prompt over persistent JSONL stdin without shell/argv exposure', async () => {
    const child = spawnOwnedLineProcess(
      process.execPath,
      [
        '-e',
        `require('readline').createInterface({input:process.stdin}).on('line',s=>{process.stdout.write(s+'\\n',()=>process.exit())})`,
      ],
      { env: {} },
    );
    let resolve!: (line: string) => void;
    const line = new Promise<string>((r) => (resolve = r));
    child.onLine(resolve);
    await child.spawned;
    const prompt = '-秘密🚀\n'.repeat(30000);
    child.write(JSON.stringify({ prompt }) + '\n');
    expect(JSON.parse(await line)).toEqual({ prompt });
    await child.exited;
  });
  it('drains oversized stderr without retaining or blocking it', async () => {
    const child = spawnOwnedLineProcess(
      process.execPath,
      [
        '-e',
        `process.stderr.write('x'.repeat(2*1024*1024));process.exitCode=1`,
      ],
      { env: {} },
    );
    expect(await child.exited).toBe(1);
  });
});
