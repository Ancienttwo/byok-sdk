import { spawnSync } from 'node:child_process';
import * as rpcHost from '#byok-pi-runtime-host';
import * as preparedHost from '#byok-pi-runtime-host';
import { runSdkReservedHelper } from '../bin/sdk-reserved-helper-runners';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BYOK_SDK_HELPER_SUBCOMMAND,
  resolveSdkReservedHelperBin,
  runSdkReservedHelperCommand,
} from '../sdk-reserved-helper-host';
import { preflightAgentMessageMcp } from '../daemon/agent-message-mcp-preflight';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/**
 * Stands in for the allowlisted child environment `buildRuntimeEnv` produces
 * for the selected runtime — the preflight never sees `process.env` itself.
 */
const PROBE_BASE_ENV: Readonly<Record<string, string>> = { PATH: process.env.PATH ?? '' };

async function fixture(name: string, source: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-sdk-helper-'));
  roots.push(root);
  const file = path.join(root, name);
  await fs.writeFile(file, source, 'utf8');
  return file;
}

describe('SDK-reserved helper host composition', () => {
  it('keeps normal product argv untouched and resolves one explicit self-executable shape for all helpers', async () => {
    await expect(runSdkReservedHelperCommand(['status'])).resolves.toBe(false);
    await expect(runSdkReservedHelperCommand([BYOK_SDK_HELPER_SUBCOMMAND, 'unknown'])).rejects.toThrow(/invalid/);
    for (const kind of ['agent-message-mcp', 'agent-memory-mcp', 'approval-mcp', 'agent-team-mcp', 'mcp-env'] as const) {
      expect(resolveSdkReservedHelperBin(kind, { mode: 'self-executable', executable: '/product/salesko-agent' }))
        .toEqual({
          command: '/product/salesko-agent',
          args: [BYOK_SDK_HELPER_SUBCOMMAND, kind],
          source: 'self-executable',
        });
    }
    expect(() => resolveSdkReservedHelperBin('agent-message-mcp', {
      mode: 'self-executable', executable: 'relative-product',
    })).toThrow(/absolute executable path/);
  });

  it('inserts an explicit interpreter entry before the same fixed helper prefix', () => {
    for (const kind of ['agent-message-mcp', 'agent-memory-mcp', 'approval-mcp', 'agent-team-mcp', 'mcp-env', 'pi-rpc', 'pi-prepared'] as const) {
      expect(resolveSdkReservedHelperBin(kind, {
        mode: 'self-executable', executable: '/runtime/bun', entry: '/release with spaces/sdk.js',
      })).toEqual({command:'/runtime/bun', args:['/release with spaces/sdk.js', BYOK_SDK_HELPER_SUBCOMMAND, kind], source:'self-executable'});
    }
    for (const entry of ['relative.js', '/bad\nentry.js', '/bad\u0000entry.js']) {
      expect(() => resolveSdkReservedHelperBin('pi-rpc', {mode:'self-executable', entry})).toThrow(/absolute single-line/);
    }
    expect(resolveSdkReservedHelperBin('pi-rpc').args[0]).toMatch(/bin[/\\]byok-pi-rpc\.js$/u);
    expect(resolveSdkReservedHelperBin('pi-prepared').args[0]).toMatch(/bin[/\\]byok-pi-prepared\.js$/u);
  });

  it('forwards variable Pi argv to the corresponding callable entry without invoking another kind', async () => {
    const rpc = vi.spyOn(rpcHost, 'runPiRpcHost').mockResolvedValue();
    const prepared = vi.spyOn(preparedHost, 'runPiPreparedHost').mockResolvedValue();
    const argv = ['--config', '/session with spaces/config.json', '--mode', 'rpc', '--no-skills'];
    await expect(runSdkReservedHelperCommand([BYOK_SDK_HELPER_SUBCOMMAND, 'pi-rpc', ...argv])).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledExactlyOnceWith(argv);
    expect(prepared).not.toHaveBeenCalled();
    const preparedArgs = ['--config', '/session/prepared.json'];
    await expect(runSdkReservedHelperCommand([BYOK_SDK_HELPER_SUBCOMMAND, 'pi-prepared', ...preparedArgs])).resolves.toBe(true);
    expect(prepared).toHaveBeenCalledExactlyOnceWith(preparedArgs);
    // The callable entry owns its usage check, including a missing config.
    await runSdkReservedHelperCommand([BYOK_SDK_HELPER_SUBCOMMAND, 'pi-prepared']);
    expect(prepared).toHaveBeenLastCalledWith([]);
  });

  it('retains exact MCP arity at both dispatch boundaries', async () => {
    for (const kind of ['agent-message-mcp', 'agent-memory-mcp', 'approval-mcp', 'agent-team-mcp', 'mcp-env'] as const) {
      await expect(runSdkReservedHelperCommand([BYOK_SDK_HELPER_SUBCOMMAND, kind, '--config', '/x'])).rejects.toThrow(/invalid/);
      await expect(runSdkReservedHelper(kind, ['extra'])).rejects.toThrow(/do not accept arguments/);
    }
    await expect(runSdkReservedHelperCommand([BYOK_SDK_HELPER_SUBCOMMAND])).rejects.toThrow(/invalid/);
  });

  it('keeps prepared import side-effect free and gives callable and thin bin the same usage validation', async () => {
    const hostPath = path.resolve(import.meta.dirname, '../../dist/bin/pi-runtime-host.js');
    const binPath = path.resolve(import.meta.dirname, '../bin/byok-pi-prepared.ts');
    const caller = await fixture('prepared-caller.ts', `
      import { runPiPreparedHost } from ${JSON.stringify(hostPath)};
      console.log('imported');
      try { await runPiPreparedHost(['--config-digest='+'a'.repeat(64), '--config', 'relative']); }
      catch (error) { console.error(error.message); process.exitCode = 1; }
    `);
    const env = {PATH:process.env.PATH!, HOME:process.env.HOME!};
    const callable = spawnSync('bun', [caller], {env,encoding:'utf8',timeout:15_000});
    const thin = spawnSync('bun', [binPath, `--config-digest=${'a'.repeat(64)}`, '--config', 'relative'], {env,encoding:'utf8',timeout:15_000});
    expect(callable.status).toBe(78);
    expect(callable.stdout.trim()).toBe('imported');
    expect(callable.stderr).toBe('byok-pi-prepared: --config must be an absolute path\n');
    expect(thin.status).toBe(78);
    expect(thin.stderr).toBe('byok-pi-prepared: --config must be an absolute path\n');
  });

  it.each([
    { argv: ['--config', 'relative', '--mode', 'rpc'], reason: '--config must be an absolute path' },
    { argv: ['--config', '/config', '--mode', 'rpc', '--mode', 'rpc'], reason: 'duplicate argument --mode' },
    { argv: ['--unknown'], reason: 'unsupported argument --unknown' },
  ])('ordinary host renders non-digest usage: $reason', async ({ argv, reason }) => {
    const hostPath = path.resolve(import.meta.dirname, '../../dist/bin/pi-runtime-host.js');
    const binPath = path.resolve(import.meta.dirname, '../bin/byok-pi-rpc.ts');
    const caller = await fixture('rpc-usage-caller.ts', `
      import { runPiRpcHost } from ${JSON.stringify(hostPath)};
      try { await runPiRpcHost(process.argv.slice(2)); }
      catch (error) { console.error(error.stack); process.exitCode = 1; }
    `);
    const env = { PATH: process.env.PATH!, HOME: process.env.HOME! };
    for (const entry of [caller, binPath]) {
      const result = spawnSync('bun', [entry, `--config-digest=${'a'.repeat(64)}`, ...argv], { env, encoding: 'utf8', timeout: 15_000 });
      expect(result.status).toBe(78);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(`byok-pi-rpc: ${reason}\n`);
    }
  });

  it.each((['pi-rpc', 'pi-prepared'] as const).flatMap(kind => [
    { kind, label: 'missing', argv: [], reason: 'exactly one --config-digest=<sha256> is required' },
    { kind, label: 'duplicate', argv: [`--config-digest=${'a'.repeat(64)}`, `--config-digest=${'a'.repeat(64)}`], reason: 'exactly one --config-digest=<sha256> is required' },
    { kind, label: 'malformed', argv: [`--config-digest=${'A'.repeat(64)}`], reason: '--config-digest must contain 64 lowercase hexadecimal characters' },
  ]))('$kind reports $label digest usage identically from callable and thin bin', async ({ kind, argv, reason }) => {
    const exportName = kind === 'pi-rpc' ? 'runPiRpcHost' : 'runPiPreparedHost';
    const hostPath = path.resolve(import.meta.dirname, '../../dist/bin/pi-runtime-host.js');
    const binPath = path.resolve(import.meta.dirname, `../bin/byok-${kind}.ts`);
    const caller = await fixture(`${kind}-digest-caller.ts`, `
      import { ${exportName} } from ${JSON.stringify(hostPath)};
      console.log('imported');
      try { await ${exportName}(process.argv.slice(2)); }
      catch (error) { console.error(error.stack); process.exitCode = 1; }
    `);
    const env = { PATH: process.env.PATH!, HOME: process.env.HOME! };
    for (const [entry, expectedStdout] of [[caller, 'imported\n'], [binPath, '']] as const) {
      const result = spawnSync('bun', [entry, ...argv], { env, encoding: 'utf8', timeout: 15_000 });
      expect(result.status, `${kind} ${entry} ${argv.join(' ')}`).toBe(78);
      expect(result.stdout).toBe(expectedStdout);
      expect(result.stderr).toBe(`byok-${kind}: ${reason}\n`);
    }
  });

  /**
   * The registry refuses a non-absolute MCP server `command` for operator
   * configuration (`toolset-registry.ts`), but the reserved helpers never pass
   * through it — they are built here. Pinning the same property at the source
   * keeps the two from drifting apart silently: a helper resolved to a bare
   * name would reach a launcher-wrapped runtime as a PATH lookup performed
   * after the chdir, which is exactly what the registry rule exists to prevent.
   */
  it('builds every reserved helper command absolute by construction, in both host modes', () => {
    for (const kind of ['agent-message-mcp', 'agent-memory-mcp', 'approval-mcp', 'agent-team-mcp', 'mcp-env'] as const) {
      const distScript = resolveSdkReservedHelperBin(kind);
      expect(distScript.source).toBe('dist-script');
      // `process.execPath` is the absolute path of the running executable,
      // unlike a bare `node` that a PATH lookup would have to resolve.
      expect(distScript.command).toBe(process.execPath);
      expect(path.isAbsolute(distScript.command)).toBe(true);
      expect(distScript.command.startsWith('-')).toBe(false);
      expect(distScript.args.every((arg) => path.isAbsolute(arg))).toBe(true);

      const selfExecutable = resolveSdkReservedHelperBin(kind, { mode: 'self-executable' });
      expect(selfExecutable.command).toBe(process.execPath);
      expect(path.isAbsolute(selfExecutable.command)).toBe(true);

      const hosted = resolveSdkReservedHelperBin(kind, {
        mode: 'self-executable', executable: '/product/salesko-agent',
      });
      expect(path.isAbsolute(hosted.command)).toBe(true);
      expect(hosted.command.startsWith('-')).toBe(false);
      // The only way an operator-supplied executable enters this shape is
      // through the assertion, so a relative one can never become a command.
      expect(() => resolveSdkReservedHelperBin(kind, { mode: 'self-executable', executable: './salesko-agent' }))
        .toThrow(/absolute executable path/);
      expect(() => resolveSdkReservedHelperBin(kind, { mode: 'self-executable', executable: 'salesko-agent' }))
        .toThrow(/absolute executable path/);
    }
  });

  it('handshakes the exact message helper command before runtime admission', async () => {
    const helper = await fixture('helper.mjs', `
      import { createInterface } from 'node:readline';
      const reader = createInterface({ input: process.stdin, terminal: false });
      let initialized = false;
      const reply = (id, result) => console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
      reader.on('line', (line) => {
        const request = JSON.parse(line);
        if (request.id === undefined || request.id === null) {
          if (request.method === 'notifications/initialized') initialized = true;
          return;
        }
        if (request.method === 'initialize') {
          reply(request.id, {
            protocolVersion: request.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'byok-message-helper', version: '0.0.0' },
          });
          return;
        }
        if (request.method === 'tools/list' && initialized) {
          reply(request.id, {
            tools: [{ name: 'send_agent_message', description: '', inputSchema: { type: 'object' } }],
          });
        }
      });
    `);
    await expect(preflightAgentMessageMcp({
      command: process.execPath,
      args: [helper],
      env: { BYOK_STORE_DIR: '/tmp/store', BYOK_PRODUCT_ID: 'product', BYOK_AGENT_MESSAGE_CONTEXT: 'context' },
    }, PROBE_BASE_ENV)).resolves.toBeUndefined();

    const broken = await fixture('broken.mjs', `process.stderr.write('unknown command\\n'); process.exit(2);`);
    await expect(preflightAgentMessageMcp({ command: process.execPath, args: [broken] }, PROBE_BASE_ENV))
      .rejects.toThrow(/exited before.*unknown command/s);
  });

  it('admits an exact helper whose single-file startup exceeds the former three-second bound', async () => {
    const delayedHelper = await fixture('delayed-helper.mjs', `
      import { createInterface } from 'node:readline';
      const reader = createInterface({ input: process.stdin, terminal: false });
      let initialized = false;
      const reply = (id, result) => console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
      reader.on('line', (line) => {
        const request = JSON.parse(line);
        if (request.id === undefined || request.id === null) {
          if (request.method === 'notifications/initialized') initialized = true;
          return;
        }
        if (request.method === 'initialize') {
          reply(request.id, {
            protocolVersion: request.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'byok-message-helper', version: '0.0.0' },
          });
          return;
        }
        if (request.method === 'tools/list' && initialized) {
          // Slower than the former three-second bound, on purpose.
          setTimeout(() => reply(request.id, {
            tools: [{ name: 'send_agent_message', description: '', inputSchema: { type: 'object' } }],
          }), 3250);
        }
      });
    `);

    await expect(preflightAgentMessageMcp({
      command: process.execPath,
      args: [delayedHelper],
    }, PROBE_BASE_ENV)).resolves.toBeUndefined();
  });
});

it.each(['pi-subagent-runner', 'pi-subagent-print'])('explicitly refuses declared but inactive %s dispatch', async kind => {
  await expect(runSdkReservedHelperCommand([BYOK_SDK_HELPER_SUBCOMMAND, kind])).rejects.toThrow(
    'SDK descendant runtime dispatch is not enabled: custody execution gates pending');
});
