import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderNativeSessions, NativeSessionsUnavailableError, type NativeSessionsIO } from '../daemon/native-sessions/renderer';

const fixture = readFileSync(new URL('./fixtures/native-sessions/pi-1.5.0.jsonl', import.meta.url), 'utf8');
const header = JSON.parse(fixture.split('\n')[0]!);
const home = path.resolve('/agent');
const sessionDir = path.resolve('/sessions');
const ledgerDir = path.join(home, '.byok/runtime-sessions');
const fileName = (id: string) => `2026-11-07T00-00-00-000Z_${id}.jsonl`;
const ledgerName = (id: string) => `pi-${createHash('sha256').update(id).digest('hex')}.jsonl`;
const ledger = (id: string) => JSON.stringify({ version: 1, agentRef: { agentId: 'agent', profileRevision: '1' }, taskId: 'task', sessionRef: id, runtimeId: 'pi', cwd: home, leaseId: 'lease', updatedAt: '2026-11-07T00:00:00.000Z' }) + '\n';
const message = (id: string, command = 'echo useful', timestamp = 2000, name = 'bash') => JSON.stringify({ type: 'message', id, parentId: null, timestamp: new Date(timestamp).toISOString(), message: { role: 'assistant', timestamp, content: [{ type: 'toolCall', id, name, arguments: { command } }] } }) + '\n';
const head = (id = header.id) => JSON.stringify({ ...header, id, cwd: home }) + '\n';
const paddingRecord = JSON.stringify({ type: 'custom', data: 'x'.repeat(60 * 1024) }) + '\n';

function setup(text = fixture.replaceAll('"cwd":"/agent"', `"cwd":${JSON.stringify(home)}`)) {
  const files = new Map<string, Buffer>([
    [path.join(ledgerDir, ledgerName(header.id)), Buffer.from(ledger(header.id))],
    [path.join(sessionDir, fileName(header.id)), Buffer.from(text)],
  ]);
  const reads: { file: string; offset: number; length: number }[] = [];
  let closed = 0;
  const io: NativeSessionsIO = {
    async lstat() { return { kind: 'directory' }; },
    async realpath(file) { return file; },
    async *list(directory) { for (const file of files.keys()) if (path.dirname(file) === directory) yield path.basename(file); },
    async open(file) {
      const bytes = files.get(file);
      if (!bytes) throw new Error('private unreadable path');
      return {
        size: bytes.length,
        async read(offset, length) { reads.push({ file, offset, length }); return bytes.subarray(offset, offset + Math.min(length, 4093)); },
        async close() { closed++; },
      };
    },
  };
  const input = { home, sessionDir, window: { fromMs: 1000, toMs: 4000 }, signal: new AbortController().signal, deadlineMs: Date.now() + 60_000, io };
  return { files, reads, io, input, get closed() { return closed; }, run: () => renderNativeSessions(input) };
}

describe('native Pi session input', () => {
  it('projects the real pinned SessionManager fixture, all tools and result branches, excluding content', async () => {
    const result = await setup().run();
    expect(JSON.parse(result.jsonLine).calls).toEqual([
      { tool: 'bash', arguments: { command: 'echo useful' }, result: 'ok' },
      { tool: 'read', arguments: { path: 'notes/read.md' }, result: 'error' },
      { tool: 'write', arguments: { path: 'notes/write.md' }, result: 'ok' },
      { tool: 'edit', arguments: { path: 'notes/edit.md' }, result: 'ok' },
      { tool: 'ls', arguments: { path: 'notes' }, result: 'ok' },
      { tool: 'find', arguments: { path: 'notes' }, result: 'ok' },
      { tool: 'grep', arguments: { path: 'notes' }, result: 'ok' },
      { tool: 'mcp.search', result: 'ok' }, { tool: 'extension', result: 'none' },
    ]);
    expect(result.jsonLine).not.toContain('EXCLUDED_CONTENT_CANARY');
    expect(result.jsonLine).not.toContain('\n');
    expect(result.counts).toMatchObject({ files: 1, calls: 9, omittedCalls: 0, skippedFiles: 0 });
  });
  it.each([
    ["docker login --pass''word shortsecret", 'docker login'],
    ['run --to\\ken shortsecret', 'run'],
    ['mysql -phunter2', 'mysql'],
    ["run --to''ken shortvalue", 'run'],
    ['PASSWORD=abc\\ secretSuffix command', undefined],
    ['PASSWORD="abc"\'secretSuffix\' command', undefined],
    ['PASSWORD=[redacted]secretSuffix command', undefined],
    ['PASSWORD=[secretvalue] command', undefined],
    ['  git\tremote add origin', 'git remote add'],
    ['echo ' + 'a'.repeat(23) + 'b', 'echo'],
    ['echo ' + 'a'.repeat(23) + ' after', 'echo ' + 'a'.repeat(23) + ' after'],
    ['echo xoxb-abcdefghij', 'echo xoxb-abcdefghij'],
    ['', undefined],
  ])('projects only allowlisted command words: %s', async (command, expected) => {
    const result = await setup(head() + message('call', command)).run();
    expect(JSON.parse(result.jsonLine).calls).toEqual([{ tool: 'bash', ...(expected ? { arguments: { command: expected } } : {}), result: 'none' }]);
  });
  it.each(['find', 'grep'])('drops free-text patterns from %s by name', async tool => {
    const entry = JSON.parse(message('call', '', 2000, tool));
    entry.message.content[0].arguments = { pattern: 'PATTERN_CANARY' };
    const result = await setup(head() + JSON.stringify(entry) + '\n').run();
    expect(JSON.parse(result.jsonLine).calls).toEqual([{ tool, result: 'none' }]);
  });
  it.each([
    ['shared', 'echo sk-abcdefghijklmnop12345678'],
    ['PEM', 'echo -----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----'],
    ['Slack', 'echo xoxb-abcdefghij'], ['GitLab', 'echo glpat-' + 'a'.repeat(20)],
    ['npm', 'echo npm_' + 'a'.repeat(36)], ['HF', 'echo hf_' + 'a'.repeat(30)],
    ['mixed token', 'echo abcdefghijklmnopqrstuv1234'],
  ])('redacts %s in paths before summary truncation', async (_rule, value) => {
    const entry = JSON.parse(message('call', '', 2000, 'read'));
    entry.message.content[0].arguments = { path: '/agent/' + value };
    const result = await setup(head() + JSON.stringify(entry) + '\n').run();
    const summary = JSON.parse(result.jsonLine).calls[0].arguments.path;
    expect(summary).toContain('[redacted]');
    expect(summary).not.toContain('short secret');
    expect(summary).not.toContain('shorttoken');
    expect(summary).not.toContain('private-material');
  });
  it('selects only the first bash line and the requested window', async () => {
    const result = await setup(head() + message('old', 'old', 999) + message('call', 'git status\r\nexcluded') + message('late', 'late', 4001)).run();
    const calls = JSON.parse(result.jsonLine).calls;
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments).toEqual({ command: 'git status' });
  });
  it.each(['glpat-' + 'a'.repeat(20), 'https:/alice:hunter2@example.com/file'])('fails non-retryably when the serialized tool name contains a secret: %s', async name => {
    await expect(setup(head() + message('call', '', 2000, name)).run()).rejects.toMatchObject({ detail: 'secret_detected', retryable: false });
  });
  it.each(['read', 'write', 'edit', 'ls', 'find', 'grep'].flatMap(tool =>
    ['/agent/https://user:shortpassword@host/file', 'https://alice:hunter2@example.com/file', '/agent/https://user:' + 'p'.repeat(263) + '@host/file'].map(value => [tool, value] as const),
  ))('replaces URL-like %s paths with a fixed marker: %s', async (tool, value) => {
    const entry = JSON.parse(message('call', '', 2000, tool));
    entry.message.content[0].arguments = { path: value };
    const result = await setup(head() + JSON.stringify(entry) + '\n').run();
    expect(JSON.parse(result.jsonLine).calls[0].arguments.path).toBe('[url]');
  });
  it.each([256, 257])('applies the raw path byte limit at %i bytes', async bytes => {
    const value = '界'.repeat(85) + 'x'.repeat(bytes - 255);
    const entry = JSON.parse(message('call', '', 2000, 'read'));
    entry.message.content[0].arguments = { path: value };
    expect(Buffer.byteLength(value)).toBe(bytes);
    const result = await setup(head() + JSON.stringify(entry) + '\n').run();
    expect(JSON.parse(result.jsonLine).calls[0].arguments.path).toBe(bytes === 256 ? value : '[omitted: too long]');
  });
  it.each(['--token=[secretvalue]', '--password short,secret', '--token "a"\'shortsecret\''])('stops before punctuation and adjacent quotes in flags: %s', async flags => {
    const result = await setup(head() + message('call', `run ${flags} done`)).run();
    expect(JSON.parse(result.jsonLine).calls[0].arguments.command).toBe('run');
  });
  it('bounds command-word selection on a long hyphen run', async () => {
    const started = performance.now();
    const result = await setup(head() + message('call', 'printf %s ' + '-'.repeat(131072))).run();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(JSON.parse(result.jsonLine).calls[0].arguments).toEqual({ command: 'printf' });
  });
  it.each([
    ["bash -c 'docker login --password shortsecret'", 'bash'],
    ["bash <<< 'docker login --password shortsecret'", 'bash'],
    ["docker login $'--password' shortsecret", 'docker login'],
    ['--password=abc\\ secretSuffix', undefined],
    ['echo --password ' + 'x'.repeat(980) + ' npm_' + 'a'.repeat(36), 'echo'],
    ['echo ' + 'x'.repeat(235) + ' --token shortsecret', 'echo'],
    ['echo ' + 'x'.repeat(245) + ' --token shortsecret', 'echo'],
    ['x'.repeat(248) + ' npm_' + 'a'.repeat(36), undefined],
    ['界'.repeat(100) + '\nexcluded', undefined],
  ])('stops command selection before free-text syntax: %s', async (command, expected) => {
    const result = await setup(head() + message('call', command)).run();
    expect(JSON.parse(result.jsonLine).calls[0].arguments).toEqual(expected ? { command: expected } : undefined);
  });
  it('omits an overlong raw path before normalization or redaction', async () => {
    const entry = JSON.parse(message('call', '', 2000, 'read'));
    entry.message.content[0].arguments = { path: '/agent/' + './'.repeat(497) + 'npm_' + 'a'.repeat(36) };
    const result = await setup(head() + JSON.stringify(entry) + '\n').run();
    expect(Object.values(JSON.parse(result.jsonLine).calls[0].arguments)).toEqual(['[omitted: too long]']);
  });
  it.each(['--token[redacted]', '--token=[redacted]', '--token [redacted]'])('accepts a complete serialized marker: %s', async name => {
    expect(JSON.parse((await setup(head() + message('call', '', 2000, name)).run()).jsonLine).calls[0].tool).toBe(name);
  });
  it('omits overlong paths without exposing token prefixes or splitting UTF-8', async () => {
    const value = 'x'.repeat(248) + ' npm_' + 'a'.repeat(36);
    const entry = JSON.parse(message('call', '', 2000, 'find'));
    entry.message.content[0].arguments = { path: '/agent/' + value, pattern: value };
    const result = await setup(head() + JSON.stringify(entry) + '\n').run();
    for (const summary of Object.values(JSON.parse(result.jsonLine).calls[0].arguments) as string[]) {
      expect(summary).not.toContain('npm_');
      expect(summary).not.toContain('aaaa');
      expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(256);
      expect(summary).toBe('[omitted: too long]');
    }
    entry.message.content[0].arguments = { path: '/agent/' + '界'.repeat(100) };
    const unicode = JSON.parse((await setup(head() + JSON.stringify(entry) + '\n').run()).jsonLine).calls[0].arguments.path;
    expect(unicode).toBe('[omitted: too long]');
    expect(unicode).not.toContain('\uFFFD');
  });
  it.each(['version', 'id', 'cwd', 'bad-line'])('skips the entire file on %s, including earlier valid calls', async reason => {
    let text = head() + message('valid');
    if (reason === 'version') text = text.replace('"version":3', '"version":999');
    if (reason === 'id') text = text.replace(header.id, 'different');
    if (reason === 'cwd') text = text.replace(JSON.stringify(home), JSON.stringify(path.resolve('/elsewhere')));
    if (reason === 'bad-line') text += '{bad\n';
    const result = await setup(text).run();
    expect(JSON.parse(result.jsonLine).calls).toEqual([]);
    expect(result.counts.skippedFiles).toBe(1);
  });
  it('skips the whole file when any record exceeds the validation bound', async () => {
    const result = await setup(head() + message('earlier') + 'x'.repeat(256 * 1024 + 1) + '\n' + message('later')).run();
    expect(result.counts).toMatchObject({ calls: 0, skippedRecords: 1, skippedFiles: 1, skippedFilesByReason: { oversized_record: 1 } });
  });
  it('stops the header probe at the record bound even without a newline', async () => {
    const f = setup(JSON.stringify({ ...header, cwd: home, padding: 'x'.repeat(9 * 1024 * 1024) }) + '\n' + message('valid'));
    const result = await f.run();
    expect(result.counts).toMatchObject({ calls: 0, skippedRecords: 1, skippedFiles: 1 });
    expect(f.reads.filter(read => read.file.startsWith(sessionDir)).reduce((total, read) => total + Math.min(read.length, 4093), 0)).toBeLessThanOrEqual(256 * 1024 + 1);
  });
  it('reads only the tail 8 MiB plus a bounded header and skips the partial first record', async () => {
    const f = setup(head() + paddingRecord.repeat(154) + message('valid'));
    const result = await f.run();
    expect(result.counts.calls).toBe(1);
    const reads = f.reads.filter(r => r.file.startsWith(sessionDir));
    const size = f.files.get(path.join(sessionDir, fileName(header.id)))!.length;
    expect(reads.filter(r => r.offset > 0).every(r => r.offset >= size - 8 * 1024 * 1024)).toBe(true);
  });
  it('retains the newest 2000 calls and counts omissions', async () => {
    const f = setup(head() + Array.from({ length: 2001 }, (_, i) => message(`call-${i}`, '', 1000 + i, i === 0 ? 'old' : i === 2000 ? 'new' : 'x')).join(''));
    const result = await f.run();
    expect(result.counts).toMatchObject({ calls: 2000, omittedCalls: 1 });
    expect(result.jsonLine).not.toContain('"old"');
    expect(JSON.parse(result.jsonLine).calls.at(-1).tool).toBe('new');
  });
  it('retains newest calls under the serialized 64 KiB cap and counts dropped calls', async () => {
    const result = await setup(head() + Array.from({ length: 400 }, (_, i) => {
      const entry = JSON.parse(message(`call-${i}`, '', 1000 + i, 'read'));
      entry.message.content[0].arguments = { path: `${i} ` + 'x'.repeat(250) };
      return JSON.stringify(entry) + '\n';
    }).join('')).run();
    const calls = JSON.parse(result.jsonLine).calls;
    expect(Buffer.byteLength(result.jsonLine)).toBeLessThanOrEqual(64 * 1024);
    expect(calls.at(-1).arguments.path).toMatch(/^399 /);
    expect(result.counts.omittedCalls).toBe(400 - calls.length);
    expect(result.counts.omittedCalls).toBeGreaterThan(0);
  });
  it('fails closed beyond 512 ledgers', async () => {
    const f = setup();
    for (let i = 0; i < 512; i++) f.files.set(path.join(ledgerDir, ledgerName(`s-${i}`)), Buffer.from(ledger(`s-${i}`)));
    await expect(f.run()).rejects.toMatchObject({ detail: 'ledger_limit' });
  });
  it('fails closed beyond 32 MiB total reads', async () => {
    const f = setup();
    for (let i = 0; i < 5; i++) {
      const id = `s-${i}`;
      f.files.set(path.join(ledgerDir, ledgerName(id)), Buffer.from(ledger(id)));
      f.files.set(path.join(sessionDir, fileName(id)), Buffer.from(head(id) + paddingRecord.repeat(137)));
    }
    await expect(f.run()).rejects.toMatchObject({ detail: 'read_limit' });
  });
  it('aborts pending IO promptly, without exposing the abort reason', async () => {
    const f = setup();
    const controller = new AbortController();
    f.io.realpath = async () => { controller.abort('PRIVATE'); return new Promise(() => {}); };
    await expect(renderNativeSessions({ ...f.input, signal: controller.signal })).rejects.toMatchObject({ message: 'native_sessions_unavailable: aborted', retryable: false });
    const reading = setup();
    const abortRead = new AbortController();
    let closed = false;
    reading.io.open = async () => ({ size: 1, async read() { abortRead.abort('PRIVATE'); return Buffer.from('\n'); }, async close() { closed = true; } });
    await expect(renderNativeSessions({ ...reading.input, signal: abortRead.signal })).rejects.toMatchObject({ detail: 'aborted' });
    await new Promise(resolve => setImmediate(resolve));
    expect(closed).toBe(true);
  });
  it('enforces the supplied startup deadline', async () => {
    const f = setup();
    await expect(renderNativeSessions({ ...f.input, deadlineMs: Date.now() - 1 })).rejects.toMatchObject({ detail: 'deadline' });
  });
  it.each(['directory', 'ledger', 'session'])('reports %s IO failures using only closed details', async where => {
    const f = setup();
    if (where === 'directory') f.io.list = async function* () { throw new Error('PRIVATE'); };
    else if (where === 'ledger') f.files.delete(path.join(ledgerDir, ledgerName(header.id)));
    else {
      const open = f.io.open;
      f.io.open = async (file, signal) => { if (file.startsWith(sessionDir)) throw Object.assign(new Error('PRIVATE'), { code: 'EACCES' }); return open(file, signal); };
    }
    if (where === 'ledger') f.io.list = async function* (directory) { if (directory === ledgerDir) yield ledgerName(header.id); };
    await expect(f.run()).rejects.toBeInstanceOf(NativeSessionsUnavailableError);
    await expect(f.run()).rejects.not.toThrow('PRIVATE');
  });
  it('renders zero counts when the Agent has no ledger directory', async () => {
    const f = setup();
    f.io.lstat = async () => { throw Object.assign(new Error('PRIVATE'), { code: 'ENOENT' }); };
    const result = await f.run();
    expect(JSON.parse(result.jsonLine)).toEqual({ calls: [], omittedCalls: 0 });
    expect(result.counts).toEqual({ ledgers: 0, files: 0, skippedFiles: 0, skippedRecords: 0, calls: 0, omittedCalls: 0, bytesRead: 0, skippedFilesByReason: {} });
  });
  it.each(['ledger', 'session'])('handles ENOENT during %s directory enumeration without partial results', async kind => {
    const f = setup();
    f.files.set(path.join(ledgerDir, ledgerName('other')), Buffer.from(ledger('other')));
    const list = f.io.list;
    f.io.list = async function* (directory, signal) {
      if (directory !== (kind === 'ledger' ? ledgerDir : sessionDir)) { yield* list(directory, signal); return; }
      yield kind === 'ledger' ? ledgerName(header.id) : fileName(header.id);
      throw Object.assign(new Error('PRIVATE'), { code: 'ENOENT' });
    };
    const result = await f.run();
    expect(JSON.parse(result.jsonLine)).toEqual({ calls: [], omittedCalls: 0 });
    if (kind === 'ledger') expect(result.counts).toEqual({ ledgers: 0, files: 0, skippedFiles: 0, skippedRecords: 0, calls: 0, omittedCalls: 0, bytesRead: 0, skippedFilesByReason: {} });
    else expect(result.counts).toMatchObject({ ledgers: 2, files: 0, calls: 0, skippedFiles: 2, skippedFilesByReason: { session_missing: 2 } });
  });
  it.each(['EACCES', 'EIO', 'file', 'symlink'])('rejects ledger directory %s instead of treating it as no history', async kind => {
    const f = setup();
    f.io.lstat = async () => {
      if (kind === 'file' || kind === 'symlink') return { kind };
      throw Object.assign(new Error('PRIVATE'), { code: kind });
    };
    await expect(f.run()).rejects.toMatchObject({ detail: 'ledger_unreadable' });
  });
  it.each(['file', 'directory'])('counts a missing session %s as a retention skip', async kind => {
    const f = setup();
    if (kind === 'file') f.files.delete(path.join(sessionDir, fileName(header.id)));
    else f.io.realpath = async file => { if (file === sessionDir) throw Object.assign(new Error('PRIVATE'), { code: 'ENOENT' }); return file; };
    const result = await f.run();
    expect(result.counts).toMatchObject({ calls: 0, skippedFiles: 1, skippedFilesByReason: { session_missing: 1 } });
  });
  it('uses the ledger parser and skips a corrupt ledger atomically', async () => {
    const f = setup();
    f.files.set(path.join(ledgerDir, ledgerName(header.id)), Buffer.from(ledger(header.id) + '{bad\n'));
    const result = await f.run();
    expect(result.counts).toMatchObject({ calls: 0, skippedFiles: 1 });
  });
  it('orders calls across sessions by call time and excludes non-Pi ledgers', async () => {
    const f = setup(head() + message('last', 'last', 3000));
    const other = 'other';
    f.files.set(path.join(ledgerDir, ledgerName(other)), Buffer.from(ledger(other)));
    f.files.set(path.join(sessionDir, fileName(other)), Buffer.from(head(other) + message('first', 'first', 1500)));
    f.files.set(path.join(ledgerDir, ledgerName('nonpi').replace(/^pi-/, 'codex-')), Buffer.from(ledger('nonpi').replace('"runtimeId":"pi"', '"runtimeId":"codex"')));
    const result = await f.run();
    expect(JSON.parse(result.jsonLine).calls.map((call: { arguments: { command: string } }) => call.arguments.command)).toEqual(['first', 'last']);
    expect(result.counts).toMatchObject({ ledgers: 3, files: 2, skippedFiles: 0 });
  });
});
