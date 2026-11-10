/**
 * The H Host as a Worker on local workerd (#794 D3, Worker row): the authenticated command entry, a pass, a device process, a
 * pass, and the clock. One substrate, one device process and one scope for the file; each test seeds its own Agent.
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeviceSimulator } from '../../../packages/testkit/src/index';
import { alarmReports, openHome, RUN, until, type Home } from './worker.test-support';
import { readHostScope, sha256Hex } from './host-scopes';
import { template } from '@byok-sdk/example-host-execution-core/test-support';

it('validates operator arguments and environment without exposing their values', () => {
  const script = fileURLToPath(new URL('./operator-provision-cli.ts', import.meta.url));
  const env = { ...process.env, DATABASE_URL: '', HOST_SCHEMA: '' };
  for (const [args, expected] of [[['scope'], 'Invalid arguments'], [['entitlement', 'tenant'], 'DATABASE_URL is required'],
    [['scope', 'scope', '--owner', 'owner', '--config', 'config.json'], 'HOST_SCHEMA must be a valid schema name']] as const) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { encoding: 'utf8',
      env: expected.startsWith('HOST_SCHEMA') ? { ...env, DATABASE_URL: 'postgres://localhost/db' } : env });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(expected);
  }
});

describe.skipIf(!RUN)('H Host on local workerd (#794 D3)', () => {
  let h: Home;
  beforeAll(async () => { h = await openHome(); });
  afterAll(async () => { await h?.close(); });

  it('provisions and rotates a scope token while preserving its entitlement', async () => {
    const scope = `provision-${randomUUID()}`, owner = { id: 'owner', kind: 'human' } as const;
    const config = { models: { default: template('pending', 'main') }, readOnlyToolsets: [] };
    const first = await h.substrate.provision(scope, owner, config);
    const dir = mkdtempSync(join(tmpdir(), 'w5-provision-'));
    try {
      const configFile = join(dir, 'config.json');
      writeFileSync(configFile, JSON.stringify(config));
      const script = fileURLToPath(new URL('./operator-provision-cli.ts', import.meta.url));
      const env = { ...process.env, DATABASE_URL: h.substrate.connectionString, HOST_SCHEMA: h.substrate.hostSchema };
      const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { encoding: 'utf8', env });
      const newTenant = `${scope}-new`;
      const created = run('entitlement', newTenant);
      expect([created.status, created.stdout, created.stderr]).toEqual([0, '', '']);
      const entitlement = run('entitlement', scope);
      expect([entitlement.status, entitlement.stdout, entitlement.stderr]).toEqual([0, '', '']);
      const result = run('scope', scope, '--owner', owner.id, '--config', configFile);
      expect([result.status, result.stderr]).toEqual([0, '']);
      expect(result.stdout).toMatch(/^[0-9a-f]{48}\n$/);
      const second = result.stdout.trim();
      const row = await readHostScope(h.substrate.pool, h.substrate.hostSchema, scope);
      expect(first).not.toBe(second);
      expect(row).toEqual({ scope, owner, config, ownerTokenSha256: await sha256Hex(second) });
      expect(JSON.stringify(row)).not.toContain(second);
      const stored = await h.substrate.pool.query('SELECT tenant_id, version FROM storage_entitlement WHERE tenant_id = ANY($1) ORDER BY tenant_id', [[scope, newTenant]]);
      expect(stored.rows).toEqual([{ tenant_id: scope, version: '1' }, { tenant_id: newTenant, version: '1' }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('runs one owner Turn: the entry commits, a pass offers it, the device runs it, a pass applies the terminal once', async () => {
    const { token } = await h.bot();
    const { turnId, task } = await h.input(token);
    await until(async () => (await h.worker.passes(), (await h.intent(turnId))?.submission === 'delivered' || undefined));
    await h.device.waitForStart(task);
    await h.device.finish(task, {});
    await until(async () => (await h.worker.passes(), (await h.turn(turnId))?.status === 'succeeded' || undefined));
    expect(await h.intent(turnId)).toMatchObject({ tries: 1, submission: 'delivered', conclusion: 'succeeded' });
    expect(await h.commands()).toContain(task);
    expect(await h.mailbox(task)).toEqual([{ type: 'task.offer', session: 'fresh', egress: true }]);
  });

  it('rejects a request with no valid owner session, and writes nothing', async () => {
    await h.bot();
    const before = await h.substrate.store.dump(h.home);
    expect((await h.worker.input('not-a-session', 'main', 'k', 'Hello')).status).toBe(401);
    expect(await h.substrate.store.dump(h.home)).toBe(before);
  });

  it('streams a board row written after the stream opened: the pools live as long as the response body', async () => {
    // A simulated device of the scope's tenant, which holds a device bearer.
    const { code } = await h.worker.admin<{ code: string }>('/host/pairing-code', { scope: h.home });
    const device = await createDeviceSimulator({ baseUrl: h.worker.base });
    const { accessToken } = await device.pair(code);
    const abort = new AbortController();
    const response = await fetch(`${h.worker.base}/byok/board/stream`, { headers: { authorization: `Bearer ${accessToken}` }, signal: abort.signal });
    try {
      expect([response.status, response.headers.get('content-type')]).toEqual([200, 'text/event-stream; charset=utf-8']);
      // The headers are back, so the serving invocation's fetch has returned. Only then the Host writes a row.
      const itemId = `item-${randomUUID()}`;
      await h.worker.admin('/host/board-item', { scope: h.home, item: { itemId, channel: 'worker', title: 'After the headers' } });
      const reader = response.body!.getReader(), decoder = new TextDecoder();
      let text = '';
      const deadline = Date.now() + 30_000;
      while (!text.includes(itemId)) {
        if (Date.now() > deadline) throw new Error(`no board event for ${itemId}:\n${text}`);
        const { done, value } = await reader.read();
        if (done) throw new Error(`the stream ended before the board event:\n${text}`);
        text += decoder.decode(value, { stream: true });
      }
      const event = text.split('\n\n').find(block => block.includes(itemId))!;
      expect(event).toMatch(/^event: board\nid: \d+\ndata: /);
      expect(JSON.parse(event.slice(event.indexOf('data: ') + 'data: '.length))).toMatchObject({ itemId, channel: 'worker' });
    } finally {
      abort.abort();
    }
  });

  it('the cron trigger only arms the clock, and the clock\'s alarm runs the Host passes', async () => {
    // Requests do not arm it: the tests above sent many, and no alarm pass ran.
    expect(alarmReports(h.worker)).toEqual([]);
    await h.worker.armClock();
    expect(h.worker.lines('[h-clock] cron')).toEqual([expect.stringContaining('armed true')]);
    await until(async () => alarmReports(h.worker).length >= 2 || undefined);
    // The clock has its alarm, so a second cron arms nothing.
    await h.worker.armClock();
    await until(async () => h.worker.lines('[h-clock] cron').length === 2 || undefined);
    expect(h.worker.lines('[h-clock] cron')[1]).toContain('armed false');
  });
});
