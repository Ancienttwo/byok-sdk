import { describe, expect, it, vi } from 'vitest';
import {
  resolveSdkHelperImplementation,
  reverifyToolImplementationIdentity,
  type SdkHelperEntryV1,
  type ToolImplementationFsProbe,
  type ToolImplementationInstallRecordV1,
} from '../identity';
import {
  assertSdkHelperSpawnBinding,
  parseSdkHelperSpawnBinding,
  sdkHelperLaunch,
  type SdkHelperSpawnBindingV1,
} from '../spawn-binding';

const baseEnv = { PATH: '/usr/bin', HOME: '/home/agent' };
const hash = (char: string) => char.repeat(64);

function record(entry: SdkHelperEntryV1, form: 'compiled-executable' | 'interpreter+bundle' = 'compiled-executable'): ToolImplementationInstallRecordV1 {
  return {
    kind: 'attested', authority: 'host-install-record', manifestRevision: 'helper-v1', form,
    installPath: '/release/agent-memory-helper.js', closureDigest: hash('a'), closureKind: 'artifact',
    ...(form === 'interpreter+bundle' ? { interpreter: { path: '/release/node', digest: hash('b'), loadCommandsDigest: hash('c') } } : {}),
    launchArgv: ['__byok_sdk_helper', entry], launchCwd: '/release',
  };
}

function probeFor(recordValue: ToolImplementationInstallRecordV1, changed?: 'closure' | 'interpreter'): ToolImplementationFsProbe {
  const digests = new Map<string, string>([[recordValue.installPath, changed === 'closure' ? hash('d') : recordValue.closureDigest]]);
  if (recordValue.interpreter) digests.set(recordValue.interpreter.path, changed === 'interpreter' ? hash('e') : recordValue.interpreter.digest);
  return {
    realpath: vi.fn(async (target: string) => target),
    lstat: vi.fn(async () => ({ uid: 0, gid: 0, mode: 0o100555, size: 11, dev: 1, ino: 2, mtimeMs: 1000,
      isFile: true, isSymbolicLink: false })),
    digest: vi.fn(async (target: string) => {
      const value = digests.get(target);
      if (value === undefined) throw new Error(`unmapped ${target}`);
      return value;
    }),
  };
}

async function attested(entry: SdkHelperEntryV1, form: 'compiled-executable' | 'interpreter+bundle' = 'compiled-executable') {
  const response = record(entry, form);
  const result = await resolveSdkHelperImplementation(
    { resolve: vi.fn(async () => response) },
    { subject: { kind: 'sdk-helper', helperId: 'agent-memory' }, entry },
    baseEnv,
    probeFor(response),
  );
  if (result.kind !== 'attested') throw new Error(`unexpected identity ${result.reason}`);
  return { identity: result, response };
}

function binding(identity: Awaited<ReturnType<typeof attested>>['identity'], helperEntry: SdkHelperEntryV1): SdkHelperSpawnBindingV1 {
  const launch = sdkHelperLaunch(identity, helperEntry);
  if (launch === undefined) throw new Error('missing launch');
  return {
    format: 'byok.sdk-helper-spawn', version: 1,
    subject: { kind: 'sdk-helper', helperId: 'agent-memory' }, helperEntry, identity,
    ...launch,
    ...(helperEntry === 'agent-memory-mcp' ? { agentMemoryMode: 'read' as const } : {}),
  };
}

function executionEnv(mode: 'read' | 'read-write' = 'read') {
  return {
    ...baseEnv,
    BYOK_STORE_DIR: '/private/store',
    BYOK_PRODUCT_ID: 'product-1',
    BYOK_AGENT_MEMORY_CONTEXT: 'opaque-context',
    BYOK_PREPARED_AGENT_MEMORY_MODE: mode,
  };
}

describe('agent-memory SDK helper identity', () => {
  it('resolves only the finite helper subject and its exact entry argv', async () => {
    const response = record('agent-memory-describe');
    const resolve = vi.fn(async () => response);
    const result = await resolveSdkHelperImplementation(
      { resolve },
      { subject: { kind: 'sdk-helper', helperId: 'agent-memory' }, entry: 'agent-memory-describe' },
      baseEnv,
      probeFor(response),
    );
    expect(result.kind).toBe('attested');
    expect(resolve).toHaveBeenCalledExactlyOnceWith({
      subject: { kind: 'sdk-helper', helperId: 'agent-memory' }, entry: 'agent-memory-describe',
    });
    const retargeted = await resolveSdkHelperImplementation(
      { resolve: async () => ({ ...response, launchArgv: ['__byok_sdk_helper', 'agent-memory-mcp'] }) },
      { subject: { kind: 'sdk-helper', helperId: 'agent-memory' }, entry: 'agent-memory-describe' },
      baseEnv,
      probeFor(response),
    );
    expect(retargeted).toEqual({ kind: 'unavailable', reason: 'install_record_mismatch' });
  });

  it('rejects descriptor credentials and does not widen Host-MCP control-name admission', async () => {
    const descriptor = await attested('agent-memory-describe');
    const launch = binding(descriptor.identity, 'agent-memory-describe');
    expect(parseSdkHelperSpawnBinding(launch)).toBeDefined();
    await expect(assertSdkHelperSpawnBinding(launch, { ...sdkHelperLaunch(descriptor.identity, 'agent-memory-describe')!,
      env: { ...baseEnv, BYOK_AGENT_MEMORY_CONTEXT: 'forbidden' } }, probeFor(descriptor.response)))
      .rejects.toThrow(/descriptor lifecycle environment forbidden/);
    expect(await reverifyToolImplementationIdentity(descriptor.identity,
      { ...baseEnv, BYOK_AGENT_MEMORY_CONTEXT: 'still-forbidden-for-host-mcp' }, probeFor(descriptor.response)))
      .toEqual({ reason: 'launch_env_unexpected_control_name', subject: 'launch-env' });
  });

  it('requires role-derived mode and exact execution lifecycle names', async () => {
    const execution = await attested('agent-memory-mcp');
    const launch = binding(execution.identity, 'agent-memory-mcp');
    await expect(assertSdkHelperSpawnBinding(launch, { ...sdkHelperLaunch(execution.identity, 'agent-memory-mcp')!,
      env: executionEnv() }, probeFor(execution.response))).resolves.toBeUndefined();
    await expect(assertSdkHelperSpawnBinding(launch, { ...sdkHelperLaunch(execution.identity, 'agent-memory-mcp')!,
      env: executionEnv('read-write') }, probeFor(execution.response))).rejects.toThrow(/execution lifecycle environment drift/);
    expect(parseSdkHelperSpawnBinding({ ...launch, agentMemoryMode: undefined })).toBeUndefined();
  });

  it('refuses closure and interpreter drift before helper spawn', async () => {
    const compiled = await attested('agent-memory-mcp');
    const compiledLaunch = binding(compiled.identity, 'agent-memory-mcp');
    await expect(assertSdkHelperSpawnBinding(compiledLaunch, { ...sdkHelperLaunch(compiled.identity, 'agent-memory-mcp')!,
      env: executionEnv() }, probeFor(compiled.response, 'closure'))).rejects.toThrow(/reverify_failed \(artifact\)/);

    const bundled = await attested('agent-memory-mcp', 'interpreter+bundle');
    const bundledLaunch = binding(bundled.identity, 'agent-memory-mcp');
    await expect(assertSdkHelperSpawnBinding(bundledLaunch, { ...sdkHelperLaunch(bundled.identity, 'agent-memory-mcp')!,
      env: executionEnv() }, probeFor(bundled.response, 'interpreter'))).rejects.toThrow(/reverify_failed \(interpreter\)/);
  });
  it('refuses provider credentials and unrelated Host task authority on either SDK helper role', async () => {
    for (const entry of ['agent-memory-describe', 'agent-memory-mcp'] as const) {
      const value = await attested(entry);
      const sealed = binding(value.identity, entry);
      for (const extra of [
        { OPENAI_API_KEY: 'fixture-only' }, { CODEX_API_KEY: 'fixture-only' },
        { CODEX_ACCESS_TOKEN: 'fixture-only' }, { Codex_Access_Token: 'fixture-only' },
        { BYOK_HOST_TOOLSET_CONTEXT: 'host-task' },
      ] as Record<string, string>[]) {
        await expect(assertSdkHelperSpawnBinding(sealed, {
          command: sealed.command, fixedArgv: sealed.fixedArgv, cwd: sealed.cwd,
          env: { ...(entry === 'agent-memory-mcp' ? executionEnv() : baseEnv), ...extra },
        }, probeFor(value.response))).rejects.toThrow('launch_env_unexpected_control_name');
      }
    }
  });

});
