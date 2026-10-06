import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const name = '@byok-sdk/cloud-do';
const version = '0.24.0-rc.1';
const moduleUrl = new URL('./registry-contract.mjs', import.meta.url).href;

test('installed npm against a loopback registry preserves first-publication/tag semantics with a non-default configured tag', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'byok-registry-npm-'));
  const requests = [];
  let mode = 'existing';
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    assert.equal(request.method, 'GET', 'the regression fixture never accepts registry writes');
    response.setHeader('content-type', 'application/json');
    if (mode === 'absent' || (mode === 'missing-tags' && request.url.startsWith('/-/package/'))) {
      response.writeHead(404); response.end(JSON.stringify({ error: 'Not found' })); return;
    }
    if (mode === 'auth' || mode === 'transient') {
      response.writeHead(mode === 'auth' ? 401 : 503); response.end(JSON.stringify({ error: mode })); return;
    }
    if (mode === 'tombstone') {
      response.end(JSON.stringify({ _id: name, name, time: { unpublished: { time: '2026-01-01T00:00:00.000Z' } } })); return;
    }
    const tags = mode === 'stable' ? { latest: '0.23.0', rc: version } : { rc: version };
    if (request.url.startsWith('/-/package/')) { response.end(JSON.stringify(tags)); return; }
    response.end(JSON.stringify({ _id: name, name, 'dist-tags': tags, versions: {
      ...(mode === 'stable' ? { '0.23.0': { name, version: '0.23.0' } } : {}),
      [version]: { name, version },
    } }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    writeFileSync(path.join(temp, 'userconfig'), '');
    writeFileSync(path.join(temp, 'globalconfig'), '');
    const env = {
      PATH: process.env.PATH, HOME: temp,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
      npm_config_registry: `http://127.0.0.1:${server.address().port}`,
      npm_config_userconfig: path.join(temp, 'userconfig'),
      npm_config_globalconfig: path.join(temp, 'globalconfig'),
      npm_config_tag: 'next', npm_config_fetch_retries: '0', npm_config_fetch_timeout: '5000',
    };
    const invocation = process.platform === 'win32'
      ? { command: process.execPath, prefix: [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')] }
      : { command: 'npm', prefix: [] };
    const run = async (expression) => {
      const source = `import { npmPackageExists, npmDistTags, npmView } from ${JSON.stringify(moduleUrl)};
        const options = ${JSON.stringify({ invocation, cwd: temp, name })};
        try { console.log(JSON.stringify({ value: ${expression} })); }
        catch (error) { console.log(JSON.stringify({ error: error.message })); }`;
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
        cwd: temp, env: { ...env, npm_config_cache: path.join(temp, `cache-${mode}`) }, timeout: 15000,
      });
      return JSON.parse(stdout);
    };
    // npm's bare-name view with configured tag=next synthesizes E404 for an existing package.
    assert.match((await run(`npmView({ ...options, selector: options.name, fields: ['dist-tags'] })`)).error, /E404/);
    assert.deepEqual(await run('npmPackageExists(options)'), { value: true });
    assert.deepEqual(await run('npmDistTags(options)'), { value: { rc: version } });
    assert.deepEqual(await run(`npmView({ ...options, selector: options.name + '@${version}', fields: ['dist-tags'] })`),
      { value: { found: true, value: { rc: version } } });
    mode = 'stable';
    assert.deepEqual(await run('npmDistTags(options)'), { value: { latest: '0.23.0', rc: version } });
    mode = 'missing-tags';
    assert.match((await run('npmDistTags(options)')).error, /failed/);
    assert.deepEqual(await run('npmPackageExists(options)'), { value: true });
    mode = 'absent';
    assert.deepEqual(await run('npmPackageExists(options)'), { value: false });
    for (mode of ['tombstone', 'auth', 'transient']) {
      assert.match((await run('npmPackageExists(options)')).error, /package probe.*failed/);
    }
    assert.ok(requests.length >= 10);
    assert.ok(requests.every((request) => request.method === 'GET'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(temp, { recursive: true, force: true });
  }
});
