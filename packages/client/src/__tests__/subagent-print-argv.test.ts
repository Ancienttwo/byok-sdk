import { describe, expect, it } from 'vitest';
import { parsePiPrintArgv } from '../subagents/print-argv';

describe('parsePiPrintArgv follows the Pi CLI value grammar', () => {
  it('reads the task after a valueless --no-tools (the profiles.ts model probe argv)', () => {
    // Exactly `profiles.ts`: resolvePiSubagentSpawn("pi-subagent-print", [...]).
    expect(parsePiPrintArgv(['-p', '--model', 'openai/gpt-5', '--no-tools', 'Reply with exactly "OK".'])).toEqual({
      model: 'openai/gpt-5', sessionFile: null, task: 'Reply with exactly "OK".', taskFile: null,
    });
  });

  it('reads the vendor buildPiArgs shape, value flags included', () => {
    const argv = ['--mode', 'json', '-p', '--no-session', '--session-dir', '/s', '--model', 'p/m:high',
      '--tools', 'read,bash', '--no-extensions', '--extension', '/ext.js', '--mcp-config', '/tmp/mcp.json',
      '--no-context-files', '--no-skills', '--append-system-prompt', '/tmp/prompt.md', 'Task: do it'];
    expect(parsePiPrintArgv(argv)).toEqual({ model: 'p/m:high', sessionFile: null, task: 'Task: do it', taskFile: null });
  });

  it('reads a resumed session file and a task delivered through @file', () => {
    expect(parsePiPrintArgv(['--mode', 'json', '-p', '--session', '/s/run.jsonl', '--no-tools', '@/tmp/task.md'])).toEqual({
      model: undefined, sessionFile: '/s/run.jsonl', task: '', taskFile: '/tmp/task.md',
    });
  });

  it('takes the -p message the way Pi does', () => {
    expect(parsePiPrintArgv(['-p', 'inline task', '--no-tools']).task).toBe('inline task');
    expect(parsePiPrintArgv(['-p', '--no-tools']).task).toBe('');
  });
});
