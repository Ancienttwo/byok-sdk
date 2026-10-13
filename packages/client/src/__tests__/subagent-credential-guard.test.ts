import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertSubagentProviderCredential } from '../subagents/credential-guard';
import { PI_RPC_IPC_KEY_MARKER } from '../adapters/pi/launcher-credential';

const bridge = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('../subagents/runner-bridge.js', () => ({
  runSubagentRunnerEntry: async (argv: readonly string[]) => { bridge.calls.push(argv); },
}));
const { runSubagentRunner } = await import('../bin/subagent-runner-host');

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function agentDir(models?: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'byok-subagent-guard-')); dirs.push(dir);
  if (models !== undefined) writeFileSync(path.join(dir, 'models.json'), models);
  return dir;
}
const provider = (apiKey: string) => JSON.stringify({ providers: { 'byok-sdk-probe': { baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey, models: [{ id: 'probe' }] } } });

// #385: in the BYOK pi-rpc lane the key lives only in the parent host's memory.
describe('subagent provider credential guard', () => {
  it('refuses a projection that carries the rpc IPC marker', () => {
    expect(() => assertSubagentProviderCredential(agentDir(provider(PI_RPC_IPC_KEY_MARKER))))
      .toThrow(/^byok_subagent_credential_unavailable: /);
  });

  it.each([
    ['no projection', undefined],
    ['a device models.json key reference', provider('$OPENAI_API_KEY')],
    ['the keyless placeholder', provider('byok-sdk-auth-none')],
  ])('leaves %s to Pi', (_name, models) => {
    expect(() => assertSubagentProviderCredential(agentDir(models))).not.toThrow();
  });

  it('refuses a projection it cannot parse', () => {
    expect(() => assertSubagentProviderCredential(agentDir('{not json'))).toThrow(/^byok_subagent_projection_unreadable: /);
  });

  it('stops the background runner before the vendored entry reads its config', async () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir(provider(PI_RPC_IPC_KEY_MARKER)));
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(runSubagentRunner('/tmp/runner-config.json')).rejects.toThrow('exit 1');
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(stderr.mock.calls[0]![0])).toContain('byok_subagent_credential_unavailable');
    expect(bridge.calls).toEqual([]);
  });
});
