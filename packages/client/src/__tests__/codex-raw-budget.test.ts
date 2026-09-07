import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CodexProcessRunner, CODEX_MAX_FRAME_BYTES, CODEX_MAX_STDERR_BYTES } from '../adapters/codex/process-runner';

describe('Codex raw frame budget', () => {
  it.each([false, true])('rejects oversized raw output before delivering a frame (newline=%s)', async newline => {
    const failures: Error[] = [];
    const events: unknown[] = [];
    const runner = new CodexProcessRunner({ command: process.execPath,
      args: ['-e', `process.stdout.write('x'.repeat(${CODEX_MAX_FRAME_BYTES + 1}) + ${JSON.stringify(newline ? '\n' : '')}); setInterval(() => {}, 1000);`],
      cwd: process.cwd(), env: process.env, onEvent: event => events.push(event), onFailure: error => failures.push(error),
    });
    try {
      await runner.waitClosed();
      expect(failures).toHaveLength(1);
      expect(failures[0]?.message).toContain('byte budget');
      expect(events).toHaveLength(0);
    } finally { await runner.dispose(); }
  });

  it('accepts UTF-8 split across chunks, CRLF, and several frames', async () => {
    const events: unknown[] = [];
    const runner = new CodexProcessRunner({ command: process.execPath,
      args: ['-e', `const b=Buffer.from('{"type":"one","text":"中文"}\\r\\n{"type":"two"}\\n'); for(const byte of b) process.stdout.write(Buffer.from([byte]));`],
      cwd: process.cwd(), env: process.env, onEvent: event => events.push(event), spawnFn: spawn,
    });
    await runner.waitClosed();
    await runner.dispose();
    expect(events).toEqual([{ type: 'one', text: '中文' }, { type: 'two' }]);
  });
  it('delivers a large Unicode prompt through stdin and closes EOF', async () => {
    const instruction = '-秘密🚀\n'.repeat(30_000);
    const events: unknown[] = [];
    const runner = new CodexProcessRunner({ command: process.execPath, instruction,
      args: ['-e', `let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>console.log(JSON.stringify({type:'prompt',text:s})))`],
      cwd: process.cwd(), env: process.env, onEvent: e => events.push(e),
    });
    await runner.waitClosed(); await runner.dispose();
    expect(events).toEqual([{ type: 'prompt', text: instruction }]);
  });

  it('bounds an oversized stderr diagnostic', async () => {
    const runner = new CodexProcessRunner({ command: process.execPath,
      args: ['-e', `process.stderr.write('x'.repeat(2*1024*1024));process.exitCode=1`],
      cwd: process.cwd(), env: process.env, onEvent: () => {},
    });
    await runner.waitClosed(); await runner.dispose();
    expect(Buffer.byteLength(runner.buildExitError('run')!.message)).toBeLessThan(CODEX_MAX_STDERR_BYTES + 200);
  });

});
