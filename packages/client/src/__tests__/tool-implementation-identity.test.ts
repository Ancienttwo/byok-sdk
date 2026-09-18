import { runtimeRecordFixture } from './fixtures/runtime-resolution';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertToolImplementationBeforeSpawn,
  parseToolImplementationIdentity,
  realToolImplementationFsProbe,
  resolveToolImplementationIdentity,
  resolveRuntimeImplementation,
  type McpImplementationLocatorV1,
  type RuntimeImplementationLocatorV1,
  reverifyToolImplementationIdentity,
  TOOL_IMPLEMENTATION_LAUNCH_ENV_LIFECYCLE_NAMES,
  toolImplementationLaunchEnvNamesDigest,
  toolImplementationLoaderEnvValuesDigest,
  ToolImplementationReverifyError,
  unexpectedLaunchEnvControlNames,
  type ToolImplementationAttestedV1,
  type ToolImplementationAuthority,
  type ToolImplementationFsProbe,
  type ToolImplementationIdentityV1,
  type ToolImplementationInstallRecordV1,
  type ToolImplementationLocatorV1,
} from '../daemon/tool-implementation-identity';
import { LOADER_ENV_DENY_PATTERNS } from '../daemon/environment';
import { PROVIDER_CREDENTIAL_ENV_DENY_NAMES } from '../adapters/provider-credential-environment';

/**
 * Every check in this module requires a ROOT-OWNED, non-writable file, which a
 * non-root test process cannot create. The probe below wraps the REAL
 * filesystem and overrides only the two facts a test cannot produce: the owner
 * uid and the write bits. Size, mtime, dev, ino and the content digest are
 * still read off a real file on disk, so the mutation tests below mutate real
 * bytes and real timestamps.
 *
 * This is the same seam, for the same reason, as `LaunchCwdShellStat` in
 * `daemon/trusted-launch-cwd.ts`.
 */
function rootOwnedProbe(overrides: { readonly uid?: number; readonly mode?: number } = {}): ToolImplementationFsProbe {
  return {
    async lstat(target) {
      const real = await realToolImplementationFsProbe.lstat(target);
      return {
        ...real,
        uid: overrides.uid ?? 0,
        mode: overrides.mode ?? (real.mode & ~0o222),
      };
    },
    realpath: (target) => realToolImplementationFsProbe.realpath(target),
    digest: (target) => realToolImplementationFsProbe.digest(target),
  };
}

const LAUNCH = Object.freeze({
  launchCwd: '/',
  launcher: null,
});

function locator(command: string): McpImplementationLocatorV1 {
  return {
    subject: { kind: 'mcp-server', toolsetId: 'salesko', serverName: 'salesko' },
    command,
    args: [],
    launch: LAUNCH,
  };
}

/** The runtime subject's locator, for the same resolver seam. */
function runtimeLocator(command: string): RuntimeImplementationLocatorV1 {
  return { subject: { kind: 'runtime', runtimeId: 'pi' }, runtimeEntry: 'pi-rpc' };
}

const EMPTY_MAP_DIGEST = createHash('sha256').update('{}', 'utf8').digest('hex');

/**
 * The environment a runtime child of this task would receive
 * (`daemon/environment.ts`'s `buildRuntimeEnv` output): no loader-affecting
 * name, because that module denies every one of them unconditionally.
 *
 * It is an argument to resolve AND to every spawn gate below, never part of
 * the locator: a host resolver is not asked about it and could not answer.
 */
const ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/home/agent',
});

function installRecord(installPath: string, closureDigest: string): ToolImplementationInstallRecordV1 {
  return {
    kind: 'attested',
    authority: 'host-install-record',
    manifestRevision: 'salesko@2026.9.1',
    form: 'compiled-executable',
    installPath,
    closureDigest,
    closureKind: 'artifact',
    launchArgv: ['mcp', 'serve'],
    launchCwd: '/',
  };
}

function authorityReturning(answer: unknown): ToolImplementationAuthority {
  return { resolve: async () => answer as never };
}

let dir: string;
let artifact: string;
let artifactDigest: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-tool-identity-')));
  artifact = path.join(dir, 'salesko-agent');
  await fs.writeFile(artifact, 'the attested bytes\n');
  artifactDigest = await realToolImplementationFsProbe.digest(artifact);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('an unconfigured daemon attests nothing', () => {
  it('resolves every identity to resolver_unconfigured when no authority is wired', async () => {
    const identity = await resolveToolImplementationIdentity(undefined, locator(artifact), ENV);
    expect(identity).toEqual({ kind: 'unavailable', reason: 'resolver_unconfigured' });
  });

  it('never promotes an absolute path on its own into an attestation', async () => {
    // The record is well-formed and the path is absolute and real — only the
    // ownership is the ordinary one a test process can produce.
    const identity = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(artifact, artifactDigest)),
      locator(artifact),
      ENV,
      realToolImplementationFsProbe,
    );
    expect(identity).toEqual({ kind: 'unavailable', reason: 'install_record_mismatch' });
  });
});

describe('a resolver answer is measured, not believed', () => {
  it('attests a root-owned, non-writable artifact whose bytes hash to the claimed digest', async () => {
    const identity = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(artifact, artifactDigest)),
      locator(artifact),
      ENV,
      rootOwnedProbe(),
    );
    expect(identity.kind).toBe('attested');
    const attested = identity as ToolImplementationAttestedV1;
    expect(attested.installPath).toBe(artifact);
    expect(attested.installStat.uid).toBe(0);
    // SDK-measured, not resolver-supplied: the record carried no stat tuple.
    expect(attested.installStat.size).toBe((await fs.stat(artifact)).size);
  });

  it('refuses a record whose claimed digest is not the artifact on disk', async () => {
    const identity = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(artifact, 'f'.repeat(64))),
      locator(artifact),
      ENV,
      rootOwnedProbe(),
    );
    expect(identity).toEqual({ kind: 'unavailable', reason: 'install_record_mismatch' });
  });

  it('refuses a record whose installPath is a symlink to the artifact', async () => {
    const link = path.join(dir, 'current');
    await fs.symlink(artifact, link);
    const identity = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(link, artifactDigest)),
      locator(link),
      ENV,
      rootOwnedProbe(),
    );
    expect(identity).toEqual({ kind: 'unavailable', reason: 'install_record_mismatch' });
  });

  it('refuses a writable artifact even when every other fact holds', async () => {
    const identity = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(artifact, artifactDigest)),
      locator(artifact),
      ENV,
      rootOwnedProbe({ mode: 0o100644 }),
    );
    expect(identity).toEqual({ kind: 'unavailable', reason: 'install_record_mismatch' });
  });

  it('reports a resolver that throws as unattested rather than raising', async () => {
    const identity = await resolveToolImplementationIdentity(
      { resolve: async () => { throw new Error('install record unavailable'); } },
      locator(artifact),
      ENV,
      rootOwnedProbe(),
    );
    expect(identity).toEqual({ kind: 'unavailable', reason: 'implementation_identity_unattested' });
  });

  it('passes a resolver-declared unavailable reason through verbatim', async () => {
    const identity = await resolveToolImplementationIdentity(
      authorityReturning({ kind: 'unavailable', reason: 'unencapsulated_source' }),
      locator(artifact),
      ENV,
      rootOwnedProbe(),
    );
    expect(identity).toEqual({ kind: 'unavailable', reason: 'unencapsulated_source' });
  });

  it('refuses a resolver reason that is not one this SDK defines', async () => {
    const identity = await resolveToolImplementationIdentity(
      authorityReturning({ kind: 'unavailable', reason: 'trust_me' }),
      locator(artifact),
      ENV,
      rootOwnedProbe(),
    );
    expect(identity).toEqual({ kind: 'unavailable', reason: 'implementation_identity_unattested' });
  });
});

describe('the install record shape is strict', () => {
  it('rejects a record carrying an unknown key', async () => {
    const identity = await resolveToolImplementationIdentity(
      authorityReturning({ ...installRecord(artifact, artifactDigest), trusted: true }),
      locator(artifact),
      ENV,
      rootOwnedProbe(),
    );
    expect(identity).toEqual({ kind: 'unavailable', reason: 'implementation_identity_unattested' });
  });

  it('rejects a record naming an authority this SDK does not recognise', async () => {
    const identity = await resolveToolImplementationIdentity(
      authorityReturning({ ...installRecord(artifact, artifactDigest), authority: 'self-declared' }),
      locator(artifact),
      ENV,
      rootOwnedProbe(),
    );
    expect(identity).toEqual({ kind: 'unavailable', reason: 'implementation_identity_unattested' });
  });

  it('rejects a compiled-executable that also names an interpreter', async () => {
    const identity = await resolveToolImplementationIdentity(
      authorityReturning({
        ...installRecord(artifact, artifactDigest),
        interpreter: { path: '/usr/bin/node', digest: 'a'.repeat(64), loadCommandsDigest: 'b'.repeat(64) },
      }),
      locator(artifact),
      ENV,
      rootOwnedProbe(),
    );
    expect(identity).toEqual({ kind: 'unavailable', reason: 'interpreter_form_unsupported' });
  });

  it('rejects an interpreter+bundle that names no interpreter', async () => {
    const identity = await resolveToolImplementationIdentity(
      authorityReturning({ ...installRecord(artifact, artifactDigest), form: 'interpreter+bundle' }),
      locator(artifact),
      ENV,
      rootOwnedProbe(),
    );
    expect(identity).toEqual({ kind: 'unavailable', reason: 'interpreter_form_unsupported' });
  });

  it('rejects a relative installPath and a non-sha256 closureDigest', async () => {
    for (const broken of [
      { ...installRecord(artifact, artifactDigest), installPath: 'salesko-agent' },
      { ...installRecord(artifact, artifactDigest), closureDigest: 'not-a-digest' },
    ]) {
      const identity = await resolveToolImplementationIdentity(
        authorityReturning(broken),
        locator(artifact),
        ENV,
        rootOwnedProbe(),
      );
      expect(identity).toEqual({ kind: 'unavailable', reason: 'implementation_identity_unattested' });
    }
  });
});

describe('an attested identity is unconstructible from a value nobody measured', () => {
  it('refuses a parsed record that carries no SDK-measured stat tuple', () => {
    expect(parseToolImplementationIdentity(installRecord(artifact, artifactDigest))).toBeUndefined();
  });

  it('refuses a parsed record with an unknown key', async () => {
    const attested = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(artifact, artifactDigest)),
      locator(artifact),
      ENV,
      rootOwnedProbe(),
    ) as ToolImplementationAttestedV1;
    expect(parseToolImplementationIdentity({ ...attested, trusted: true })).toBeUndefined();
  });

  it('round-trips an identity this SDK produced, through JSON, unchanged', async () => {
    const attested = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(artifact, artifactDigest)),
      locator(artifact),
      ENV,
      rootOwnedProbe(),
    ) as ToolImplementationAttestedV1;
    const parsed = parseToolImplementationIdentity(JSON.parse(JSON.stringify(attested)));
    expect(parsed).toEqual(attested);
  });

  it('refuses an unavailable reason it does not define', () => {
    expect(parseToolImplementationIdentity({ kind: 'unavailable', reason: 'because' })).toBeUndefined();
    expect(parseToolImplementationIdentity({ kind: 'unavailable', reason: 'reverify_failed', extra: 1 }))
      .toBeUndefined();
  });
});

describe('reverification measures the artifact again at spawn', () => {
  async function attest(): Promise<ToolImplementationAttestedV1> {
    const identity = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(artifact, artifactDigest)),
      locator(artifact),
      ENV,
      rootOwnedProbe(),
    );
    expect(identity.kind).toBe('attested');
    return identity as ToolImplementationAttestedV1;
  }

  it('passes when nothing about the artifact changed', async () => {
    expect(await reverifyToolImplementationIdentity(await attest(), ENV, rootOwnedProbe())).toBe('ok');
  });

  it('fails when one byte of the artifact is rewritten between resolve and spawn', async () => {
    const attested = await attest();
    await fs.appendFile(artifact, '!');
    expect(await reverifyToolImplementationIdentity(attested, ENV, rootOwnedProbe()))
      .toEqual({ reason: 'install_record_mismatch', subject: 'artifact' });
  });

  it('fails on an mtime-only change, with the bytes still identical', async () => {
    const attested = await attest();
    const moved = new Date(Date.now() + 120_000);
    await fs.utimes(artifact, moved, moved);
    expect(await realToolImplementationFsProbe.digest(artifact)).toBe(attested.closureDigest);
    expect(await reverifyToolImplementationIdentity(attested, ENV, rootOwnedProbe()))
      .toEqual({ reason: 'install_record_mismatch', subject: 'artifact' });
  });

  it('fails when the artifact is replaced by a file with the same bytes', async () => {
    const attested = await attest();
    const replacement = path.join(dir, 'replacement');
    await fs.writeFile(replacement, 'the attested bytes\n');
    await fs.rename(replacement, artifact);
    expect(await realToolImplementationFsProbe.digest(artifact)).toBe(attested.closureDigest);
    expect(await reverifyToolImplementationIdentity(attested, ENV, rootOwnedProbe()))
      .toEqual({ reason: 'install_record_mismatch', subject: 'artifact' });
  });

  it('fails when the artifact is gone', async () => {
    const attested = await attest();
    await fs.rm(artifact);
    expect(await reverifyToolImplementationIdentity(attested, ENV, rootOwnedProbe()))
      .toEqual({ reason: 'install_record_mismatch', subject: 'artifact' });
  });

  it('refuses the spawn, non-retryably and with the reason, when reverification fails', async () => {
    const attested = await attest();
    await fs.appendFile(artifact, '!');
    await expect(assertToolImplementationBeforeSpawn('MCP toolset server "salesko"', attested, ENV, rootOwnedProbe()))
      .rejects.toThrow(ToolImplementationReverifyError);
    await expect(assertToolImplementationBeforeSpawn('MCP toolset server "salesko"', attested, ENV, rootOwnedProbe()))
      .rejects.toThrow(/install_record_mismatch/u);
  });

  it('lets an unavailable identity and an absent one through: neither carries a claim to break', async () => {
    await expect(assertToolImplementationBeforeSpawn('probe', undefined, ENV, rootOwnedProbe())).resolves.toBeUndefined();
    await expect(assertToolImplementationBeforeSpawn(
      'probe',
      { kind: 'unavailable', reason: 'resolver_unconfigured' },
      ENV,
      rootOwnedProbe(),
    )).resolves.toBeUndefined();
  });
});


// ---------------------------------------------------------------------------
// The launch environment is measured, never supplied
// ---------------------------------------------------------------------------

describe('the launch environment is an SDK measurement, not a resolver input', () => {
  it('refuses a record that tries to supply the env digests itself', async () => {
    for (const forged of [
      { ...installRecord(artifact, artifactDigest), launchEnvNamesDigest: 'c'.repeat(64) },
      { ...installRecord(artifact, artifactDigest), loaderEnvValuesDigest: 'd'.repeat(64) },
    ]) {
      const identity = await resolveToolImplementationIdentity(
        authorityReturning(forged),
        locator(artifact),
        ENV,
        rootOwnedProbe(),
      );
      expect(identity).toEqual({ kind: 'unavailable', reason: 'implementation_identity_unattested' });
    }
  });

  it('measures both digests off the environment the caller will spawn with', async () => {
    const identity = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(artifact, artifactDigest)),
      locator(artifact),
      ENV,
      rootOwnedProbe(),
    ) as ToolImplementationAttestedV1;
    expect(identity.launchEnvNamesDigest).toBe(toolImplementationLaunchEnvNamesDigest(ENV));
    // Nothing `buildRuntimeEnv` produces carries a loader-affecting name, so
    // the expected value is the digest of the empty canonical map.
    expect(identity.loaderEnvValuesDigest).toBe(EMPTY_MAP_DIGEST);
    expect(toolImplementationLoaderEnvValuesDigest(ENV)).toBe(EMPTY_MAP_DIGEST);
  });

  it('binds the NAMES, not the values: changing a non-loader value changes neither digest', () => {
    const changed = { ...ENV, HOME: '/home/somebody-else' };
    expect(toolImplementationLaunchEnvNamesDigest(changed))
      .toBe(toolImplementationLaunchEnvNamesDigest(ENV));
    expect(toolImplementationLoaderEnvValuesDigest(changed)).toBe(EMPTY_MAP_DIGEST);
  });

  it('changes the names digest when a name is added, removed or renamed', () => {
    const baseline = toolImplementationLaunchEnvNamesDigest(ENV);
    const { HOME, ...removed } = ENV;
    expect(toolImplementationLaunchEnvNamesDigest({ ...ENV, PYTHONPATH: '/tmp/x' })).not.toBe(baseline);
    expect(toolImplementationLaunchEnvNamesDigest(removed)).not.toBe(baseline);
    expect(toolImplementationLaunchEnvNamesDigest({ PATH: ENV.PATH!, HOMEDIR: HOME! })).not.toBe(baseline);
  });

  it('excludes exactly the names this SDK itself adds or strips between resolve and spawn', () => {
    // `withoutProviderCredentials` at a subscription boundary and the per-server
    // `env` block the task runner mints are the SDK's own doing, so an identity
    // resolved before them still matches the environment that reaches the child.
    const baseline = toolImplementationLaunchEnvNamesDigest(ENV);
    expect(toolImplementationLaunchEnvNamesDigest({ ...ENV, ANTHROPIC_API_KEY: 'sk-x' })).toBe(baseline);
    expect(toolImplementationLaunchEnvNamesDigest({ ...ENV, BYOK_HOST_TOOLSET_CONTEXT: 'nonce' })).toBe(baseline);
    // And the Pi control variables, which never reach a gated child, are NOT
    // excluded: one arriving at the gate has to be visible to be refused.
    expect(toolImplementationLaunchEnvNamesDigest({ ...ENV, BYOK_PI_MCP_CONFIG_PATH: '/tmp/c' })).not.toBe(baseline);
  });
});

describe('a spawn is refused when its environment is not the one that was measured', () => {
  async function attest(): Promise<ToolImplementationAttestedV1> {
    const identity = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(artifact, artifactDigest)),
      locator(artifact),
      ENV,
      rootOwnedProbe(),
    );
    expect(identity.kind).toBe('attested');
    return identity as ToolImplementationAttestedV1;
  }

  it('admits the spawn when the environment is the one the identity was measured against', async () => {
    expect(await reverifyToolImplementationIdentity(await attest(), { ...ENV }, rootOwnedProbe())).toBe('ok');
  });

  it('refuses a loader-affecting variable that appeared after the identity was measured', async () => {
    const attested = await attest();
    const injections: readonly Record<string, string>[] = [
      { NODE_OPTIONS: '--require /tmp/x.js' },
      { DYLD_INSERT_LIBRARIES: '/tmp/x.dylib' },
      { BASH_ENV: '/tmp/x.sh' },
    ];
    for (const injected of injections) {
      expect(await reverifyToolImplementationIdentity(attested, { ...ENV, ...injected }, rootOwnedProbe()))
        .toEqual({ reason: 'launch_env_drift', subject: 'launch-env' });
    }
  });

  it('refuses a renamed variable even though the name count is unchanged', async () => {
    const attested = await attest();
    expect(await reverifyToolImplementationIdentity(
      attested,
      { PATH: ENV.PATH!, HOMEDIR: ENV.HOME! },
      rootOwnedProbe(),
    )).toEqual({ reason: 'launch_env_drift', subject: 'launch-env' });
  });

  it('admits a changed value on a name that cannot influence a loader', async () => {
    const attested = await attest();
    expect(await reverifyToolImplementationIdentity(attested, { ...ENV, HOME: '/home/other' }, rootOwnedProbe()))
      .toBe('ok');
  });

  it('refuses the spawn itself, naming the drift', async () => {
    const attested = await attest();
    await expect(assertToolImplementationBeforeSpawn(
      'MCP toolset server "salesko"',
      attested,
      { ...ENV, NODE_OPTIONS: '--require /tmp/x.js' },
      rootOwnedProbe(),
    )).rejects.toThrow(/launch_env_drift \(launch-env\)/u);
  });
});

// ---------------------------------------------------------------------------
// interpreter+bundle: the interpreter is measured exactly as the artifact is
// ---------------------------------------------------------------------------

describe('an interpreter+bundle reverifies its interpreter as strictly as its bundle', () => {
  let interpreter: string;
  let interpreterDigest: string;

  beforeEach(async () => {
    interpreter = path.join(dir, 'salesko-node');
    await fs.writeFile(interpreter, 'the attested interpreter\n');
    interpreterDigest = await realToolImplementationFsProbe.digest(interpreter);
  });

  function bundleRecord(): ToolImplementationInstallRecordV1 {
    return {
      ...installRecord(artifact, artifactDigest),
      form: 'interpreter+bundle',
      interpreter: {
        path: interpreter,
        digest: interpreterDigest,
        loadCommandsDigest: 'e'.repeat(64),
      },
    };
  }

  async function attest(): Promise<ToolImplementationAttestedV1> {
    const identity = await resolveToolImplementationIdentity(
      authorityReturning(bundleRecord()),
      locator(artifact),
      ENV,
      rootOwnedProbe(),
    );
    expect(identity.kind).toBe('attested');
    return identity as ToolImplementationAttestedV1;
  }

  it('measures an interpreter stat tuple at resolve, which no host supplied', async () => {
    const attested = await attest();
    const live = await realToolImplementationFsProbe.lstat(interpreter);
    expect(attested.interpreterStat).toMatchObject({ ino: live.ino, size: live.size, mtimeMs: live.mtimeMs });
    // Measured through the same seam as the artifact's: root-owned there,
    // root-owned here, and it is the SDK that says so.
    expect(attested.interpreterStat?.uid).toBe(0);
  });

  it('admits the spawn while nothing about either file changed', async () => {
    expect(await reverifyToolImplementationIdentity(await attest(), ENV, rootOwnedProbe())).toBe('ok');
  });

  it('refuses a byte flipped in the interpreter, naming the interpreter', async () => {
    const attested = await attest();
    await fs.appendFile(interpreter, '!');
    expect(await reverifyToolImplementationIdentity(attested, ENV, rootOwnedProbe()))
      .toEqual({ reason: 'install_record_mismatch', subject: 'interpreter' });
  });

  it('refuses an mtime-only touch of the interpreter, with its bytes identical', async () => {
    const attested = await attest();
    const moved = new Date(Date.now() + 120_000);
    await fs.utimes(interpreter, moved, moved);
    expect(await realToolImplementationFsProbe.digest(interpreter)).toBe(attested.interpreter!.digest);
    expect(await reverifyToolImplementationIdentity(attested, ENV, rootOwnedProbe()))
      .toEqual({ reason: 'install_record_mismatch', subject: 'interpreter' });
  });

  it('refuses an interpreter that stopped being root-owned or grew a write bit', async () => {
    const attested = await attest();
    // The ownership seam, applied to the interpreter alone: every other fact
    // is still the real one read off disk.
    const movedOwnership: ToolImplementationFsProbe = {
      async lstat(target) {
        const real = await realToolImplementationFsProbe.lstat(target);
        if (target === interpreter) return { ...real, uid: 501, mode: real.mode & ~0o222 };
        return { ...real, uid: 0, mode: real.mode & ~0o222 };
      },
      realpath: (target) => realToolImplementationFsProbe.realpath(target),
      digest: (target) => realToolImplementationFsProbe.digest(target),
    };
    expect(await reverifyToolImplementationIdentity(attested, ENV, movedOwnership))
      .toEqual({ reason: 'install_record_mismatch', subject: 'interpreter' });
    const grewWriteBit: ToolImplementationFsProbe = {
      async lstat(target) {
        const real = await realToolImplementationFsProbe.lstat(target);
        if (target === interpreter) return { ...real, uid: 0, mode: (real.mode & ~0o222) | 0o200 };
        return { ...real, uid: 0, mode: real.mode & ~0o222 };
      },
      realpath: (target) => realToolImplementationFsProbe.realpath(target),
      digest: (target) => realToolImplementationFsProbe.digest(target),
    };
    expect(await reverifyToolImplementationIdentity(attested, ENV, grewWriteBit))
      .toEqual({ reason: 'install_record_mismatch', subject: 'interpreter' });
  });

  it('refuses an interpreter replaced by a different file with the same bytes', async () => {
    const attested = await attest();
    const replacement = path.join(dir, 'replacement-node');
    await fs.writeFile(replacement, 'the attested interpreter\n');
    await fs.rename(replacement, interpreter);
    expect(await realToolImplementationFsProbe.digest(interpreter)).toBe(attested.interpreter!.digest);
    expect(await reverifyToolImplementationIdentity(attested, ENV, rootOwnedProbe()))
      .toEqual({ reason: 'install_record_mismatch', subject: 'interpreter' });
  });

  it('refuses the spawn itself, naming which half moved', async () => {
    const attested = await attest();
    await fs.appendFile(interpreter, '!');
    await expect(assertToolImplementationBeforeSpawn('probe', attested, ENV, rootOwnedProbe()))
      .rejects.toThrow(/install_record_mismatch \(interpreter\)/u);
  });

  it('refuses an identity whose interpreter carries no SDK-measured tuple', async () => {
    const attested = await attest();
    const { interpreterStat, ...withoutTuple } = attested;
    expect(parseToolImplementationIdentity(withoutTuple)).toBeUndefined();
    // And the other direction: an artifact-only identity that carries one.
    const compiled = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(artifact, artifactDigest)),
      locator(artifact),
      ENV,
      rootOwnedProbe(),
    ) as ToolImplementationAttestedV1;
    expect(parseToolImplementationIdentity({ ...compiled, interpreterStat })).toBeUndefined();
  });

  it('round-trips through JSON with both tuples intact', async () => {
    const attested = await attest();
    expect(parseToolImplementationIdentity(JSON.parse(JSON.stringify(attested)))).toEqual(attested);
  });
});

// ---------------------------------------------------------------------------
// reverify_failed: the bytes moved while the stat tuple did not
// ---------------------------------------------------------------------------

/**
 * `install_record_mismatch` and `reverify_failed` are two different facts and
 * the tests above only reach the first one: every real mutation of a file on
 * disk moves its `(size, mtime, ino)` tuple too, so the tuple check fires
 * before the digest ever disagrees.
 *
 * The one case that reaches the digest check is bytes that changed WITHOUT the
 * tuple changing — a same-length in-place overwrite that also restored the
 * mtime, which is exactly the shape an attacker who can write the file would
 * aim for. It is produced here through the {@link ToolImplementationFsProbe}
 * seam rather than on disk, because the seam is the only place a test can hold
 * the tuple still while the content hash moves.
 */
describe('a byte change that leaves the stat tuple untouched is reverify_failed', () => {
  let interpreter: string;
  let interpreterDigest: string;

  beforeEach(async () => {
    interpreter = path.join(dir, 'salesko-node');
    await fs.writeFile(interpreter, 'the attested interpreter\n');
    interpreterDigest = await realToolImplementationFsProbe.digest(interpreter);
  });

  /** The root-owned probe, with ONE path's content digest answering differently. */
  function bytesMovedProbe(target: string): ToolImplementationFsProbe {
    const base = rootOwnedProbe();
    return {
      lstat: (candidate) => base.lstat(candidate),
      realpath: (candidate) => base.realpath(candidate),
      digest: async (candidate) => (candidate === target
        ? createHash('sha256').update('different bytes, identical tuple\n').digest('hex')
        : base.digest(candidate)),
    };
  }

  async function attestCompiled(): Promise<ToolImplementationAttestedV1> {
    const identity = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(artifact, artifactDigest)),
      locator(artifact),
      ENV,
      rootOwnedProbe(),
    );
    expect(identity.kind).toBe('attested');
    return identity as ToolImplementationAttestedV1;
  }

  async function attestBundle(): Promise<ToolImplementationAttestedV1> {
    const identity = await resolveToolImplementationIdentity(
      authorityReturning({
        ...installRecord(artifact, artifactDigest),
        form: 'interpreter+bundle',
        interpreter: { path: interpreter, digest: interpreterDigest, loadCommandsDigest: 'e'.repeat(64) },
      }),
      locator(artifact),
      ENV,
      rootOwnedProbe(),
    );
    expect(identity.kind).toBe('attested');
    return identity as ToolImplementationAttestedV1;
  }

  it('names the artifact when the artifact hashed differently under an unchanged tuple', async () => {
    const attested = await attestCompiled();
    expect(await reverifyToolImplementationIdentity(attested, ENV, bytesMovedProbe(artifact)))
      .toEqual({ reason: 'reverify_failed', subject: 'artifact' });
  });

  it('names the interpreter when only the interpreter hashed differently', async () => {
    const attested = await attestBundle();
    // The artifact is untouched, so the refusal must not be attributed to it:
    // `reverify_failed (artifact)` and `reverify_failed (interpreter)` send an
    // operator to two different files.
    expect(await reverifyToolImplementationIdentity(attested, ENV, bytesMovedProbe(interpreter)))
      .toEqual({ reason: 'reverify_failed', subject: 'interpreter' });
  });

  it('maps the same disagreement to install_record_mismatch at resolve and reverify_failed at the gate', async () => {
    // One rule, two layers: at resolve the digest under test is the HOST's
    // claim about a file nothing has verified yet, so a disagreement is the
    // record being wrong; at the gate it is this SDK's own prior measurement,
    // so a disagreement is a verification that decayed.
    const atResolve = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(artifact, artifactDigest)),
      locator(artifact),
      ENV,
      bytesMovedProbe(artifact),
    );
    expect(atResolve).toEqual({ kind: 'unavailable', reason: 'install_record_mismatch' });
    expect(await reverifyToolImplementationIdentity(await attestCompiled(), ENV, bytesMovedProbe(artifact)))
      .toEqual({ reason: 'reverify_failed', subject: 'artifact' });
  });

  it('refuses the spawn itself with the reason and the subject, for either half', async () => {
    const attested = await attestBundle();
    await expect(assertToolImplementationBeforeSpawn('probe', attested, ENV, bytesMovedProbe(artifact)))
      .rejects.toThrow(/reverify_failed \(artifact\)/u);
    await expect(assertToolImplementationBeforeSpawn('probe', attested, ENV, bytesMovedProbe(interpreter)))
      .rejects.toThrow(/reverify_failed \(interpreter\)/u);
  });
});

// ---------------------------------------------------------------------------
// The stat tuples are sealed measurements, never resolver inputs
// ---------------------------------------------------------------------------

describe('a record that supplies a sealed measurement is not an install record', () => {
  const TUPLE = Object.freeze({
    dev: 1, ino: 2, size: 3, mtimeMs: 4, mode: 0o100444, uid: 0, gid: 0,
  });

  it('refuses a record carrying installStat', async () => {
    const identity = await resolveToolImplementationIdentity(
      authorityReturning({ ...installRecord(artifact, artifactDigest), installStat: TUPLE }),
      locator(artifact),
      ENV,
      rootOwnedProbe(),
    );
    expect(identity).toEqual({ kind: 'unavailable', reason: 'implementation_identity_unattested' });
  });

  it('refuses a record carrying interpreterStat', async () => {
    const interpreter = path.join(dir, 'salesko-node');
    await fs.writeFile(interpreter, 'the attested interpreter\n');
    const identity = await resolveToolImplementationIdentity(
      authorityReturning({
        ...installRecord(artifact, artifactDigest),
        form: 'interpreter+bundle',
        interpreter: {
          path: interpreter,
          digest: await realToolImplementationFsProbe.digest(interpreter),
          loadCommandsDigest: 'e'.repeat(64),
        },
        interpreterStat: TUPLE,
      }),
      locator(artifact),
      ENV,
      rootOwnedProbe(),
    );
    expect(identity).toEqual({ kind: 'unavailable', reason: 'implementation_identity_unattested' });
  });

  it('refuses a compiled-executable record carrying interpreterStat alone', async () => {
    const identity = await resolveToolImplementationIdentity(
      authorityReturning({ ...installRecord(artifact, artifactDigest), interpreterStat: TUPLE }),
      locator(artifact),
      ENV,
      rootOwnedProbe(),
    );
    expect(identity).toEqual({ kind: 'unavailable', reason: 'implementation_identity_unattested' });
  });
});

// ---------------------------------------------------------------------------
// The names projection is an enumeration, and everything else fails closed
// ---------------------------------------------------------------------------

describe('the launch-env projection subtracts an enumerated set, never a prefix', () => {
  async function attest(): Promise<ToolImplementationAttestedV1> {
    const identity = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(artifact, artifactDigest)),
      locator(artifact),
      ENV,
      rootOwnedProbe(),
    );
    expect(identity.kind).toBe('attested');
    return identity as ToolImplementationAttestedV1;
  }

  it('projects away exactly the lifecycle names this SDK mints between resolve and spawn', () => {
    // Pinned as a list, not only as a loop: a name added here is a name the
    // gate stops seeing, so it must be a deliberate edit rather than a
    // side effect. Each of the three is minted into the per-server `env` block
    // `mcp/client.ts:244` layers onto a GATED child (`task-runner.ts:3353-3355`).
    expect([...TOOL_IMPLEMENTATION_LAUNCH_ENV_LIFECYCLE_NAMES]).toEqual([
      'BYOK_HOST_TOOLSET_CONTEXT',
      'BYOK_PRODUCT_ID',
      'BYOK_STORE_DIR',
    ]);
    const baseline = toolImplementationLaunchEnvNamesDigest(ENV);
    for (const name of TOOL_IMPLEMENTATION_LAUNCH_ENV_LIFECYCLE_NAMES) {
      expect(toolImplementationLaunchEnvNamesDigest({ ...ENV, [name]: 'x' })).toBe(baseline);
    }
  });

  it('projects away the credential surface the custody boundary strips', () => {
    const baseline = toolImplementationLaunchEnvNamesDigest(ENV);
    for (const name of PROVIDER_CREDENTIAL_ENV_DENY_NAMES) {
      expect(toolImplementationLaunchEnvNamesDigest({ ...ENV, [name]: 'sk-x' })).toBe(baseline);
    }
  });

  it('does NOT project away a BYOK_* name it does not mint: the prefix is not inert', () => {
    // `BYOK_MCP_ENV_KEY` and the `BYOK_*_BIN` overrides are real knobs this SDK
    // reads elsewhere, so "starts with BYOK_" cannot mean "harmless".
    const baseline = toolImplementationLaunchEnvNamesDigest(ENV);
    expect(toolImplementationLaunchEnvNamesDigest({ ...ENV, BYOK_LOADER_PATH: '/tmp/x' })).not.toBe(baseline);
    expect(unexpectedLaunchEnvControlNames({ ...ENV, BYOK_LOADER_PATH: '/tmp/x' })).toEqual(['BYOK_LOADER_PATH']);
    expect(unexpectedLaunchEnvControlNames(ENV)).toEqual([]);
    for (const name of TOOL_IMPLEMENTATION_LAUNCH_ENV_LIFECYCLE_NAMES) {
      expect(unexpectedLaunchEnvControlNames({ ...ENV, [name]: 'x' })).toEqual([]);
    }
  });

  it('refuses the spawn when an unaccountable control name is on the child environment', async () => {
    const attested = await attest();
    expect(await reverifyToolImplementationIdentity(
      attested,
      { ...ENV, BYOK_LOADER_PATH: '/tmp/x' },
      rootOwnedProbe(),
    )).toEqual({ reason: 'launch_env_unexpected_control_name', subject: 'launch-env' });
    await expect(assertToolImplementationBeforeSpawn(
      'probe',
      attested,
      { ...ENV, BYOK_LOADER_PATH: '/tmp/x' },
      rootOwnedProbe(),
    )).rejects.toThrow(/launch_env_unexpected_control_name \(launch-env\)/u);
  });

  it('refuses it even when the same name was present at resolve and the digests agree', async () => {
    // The digests cannot catch this one: the name was there both times. Fail
    // closed on the name itself, or an unaccountable control variable rides
    // along for the whole life of the identity.
    const withControl = { ...ENV, BYOK_LOADER_PATH: '/tmp/x' };
    const identity = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(artifact, artifactDigest)),
      locator(artifact),
      withControl,
      rootOwnedProbe(),
    ) as ToolImplementationAttestedV1;
    expect(identity.launchEnvNamesDigest).toBe(toolImplementationLaunchEnvNamesDigest(withControl));
    expect(await reverifyToolImplementationIdentity(identity, withControl, rootOwnedProbe()))
      .toEqual({ reason: 'launch_env_unexpected_control_name', subject: 'launch-env' });
  });

  it('refuses a renamed control variable, lifecycle name or not', async () => {
    const attested = await attest();
    expect(await reverifyToolImplementationIdentity(
      attested,
      { ...ENV, BYOK_PI_MCP_CONFIG_PATHH: '/tmp/c' },
      rootOwnedProbe(),
    )).toEqual({ reason: 'launch_env_unexpected_control_name', subject: 'launch-env' });
  });

  it('refuses a Pi control variable that reached a gated child anyway', async () => {
    // `BYOK_PI_*` is set on the Pi PROCESS (`adapters/pi/pi-adapter.ts:491-492`)
    // and the server pool strips the whole `/^BYOK_PI_/` shape back off
    // (`adapters/pi/mcp-server-pool.ts:42,271`) before it spawns a server; the
    // daemon's own admission probe spawns off `buildRuntimeEnv`'s output, which
    // hard-denies `BYOK_*` (`daemon/environment.ts:202`). So neither name ever
    // reaches a gated child, and one that does is control-plane authority from
    // somewhere this SDK does not mint — refused, not projected away.
    const attested = await attest();
    for (const name of ['BYOK_PI_MCP_CONFIG_PATH', 'BYOK_PI_PERMISSION_MODE']) {
      expect(unexpectedLaunchEnvControlNames({ ...ENV, [name]: 'x' })).toEqual([name]);
      expect(await reverifyToolImplementationIdentity(
        attested,
        { ...ENV, [name]: 'x' },
        rootOwnedProbe(),
      )).toEqual({ reason: 'launch_env_unexpected_control_name', subject: 'launch-env' });
    }
  });

  it('still admits the real host-toolset and credential transformations', async () => {
    const attested = await attest();
    // The per-server nonce block `mcp/client.ts` layers on and a
    // hosted-manifest credential strip are both this SDK's own doing between
    // resolve and spawn, and neither is a refusal.
    expect(await reverifyToolImplementationIdentity(attested, {
      ...ENV,
      BYOK_HOST_TOOLSET_CONTEXT: 'nonce',
      BYOK_STORE_DIR: '/var/byok',
      BYOK_PRODUCT_ID: 'salesko',
    }, rootOwnedProbe())).toBe('ok');
    expect(await reverifyToolImplementationIdentity(attested, { ...ENV }, rootOwnedProbe())).toBe('ok');
    expect(await reverifyToolImplementationIdentity(
      attested,
      { ...ENV, ANTHROPIC_API_KEY: 'sk-x' },
      rootOwnedProbe(),
    )).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// The projection never weakens the loader-values digest
// ---------------------------------------------------------------------------

/**
 * The invariant the whole projection rests on: a name it subtracts can never
 * be a name `daemon/environment.ts` denies for loader reasons. If the two sets
 * ever overlapped, a loader-affecting variable would be projected out of the
 * names digest AND out of the §27.2 values digest, and the gate would stop
 * seeing the one class of variable it exists to see.
 */
describe('the two projections are disjoint from the loader deny list', () => {
  function matchesPattern(name: string, pattern: string): boolean {
    return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
  }

  it('has no loader deny pattern matching a lifecycle name', () => {
    for (const pattern of LOADER_ENV_DENY_PATTERNS) {
      for (const name of TOOL_IMPLEMENTATION_LAUNCH_ENV_LIFECYCLE_NAMES) {
        expect(matchesPattern(name, pattern)).toBe(false);
      }
    }
  });

  it('has no loader deny pattern present in the credential-surface projection', () => {
    for (const pattern of LOADER_ENV_DENY_PATTERNS) {
      for (const name of PROVIDER_CREDENTIAL_ENV_DENY_NAMES) {
        expect(matchesPattern(name, pattern)).toBe(false);
      }
    }
  });

  it('keeps every loader-affecting name inside the values digest', () => {
    // The end-to-end statement of the two invariants above: a loader name
    // still moves the §27.2 values digest off the empty map.
    for (const injected of ['NODE_OPTIONS', 'BUN_INSPECT', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'BASH_ENV']) {
      expect(toolImplementationLoaderEnvValuesDigest({ ...ENV, [injected]: '/tmp/x' }))
        .not.toBe(EMPTY_MAP_DIGEST);
    }
  });
});

// ---------------------------------------------------------------------------
// Path identity: a symlink-free parent chain and a regular non-symlink leaf,
// bound to an INODE rather than to the name `realpath` happens to return
// ---------------------------------------------------------------------------

/**
 * The fact that forced this shape, recorded because it is not guessable from
 * the code: on Darwin under Bun 1.4.2, `fs.realpath` on a HARDLINKED regular
 * file returned a SIBLING link's name — same device, same inode, neither entry
 * a symlink — in 2 of 96 probed checks, while Node 24 and Linux returned the
 * queried name 96 times out of 96. (Independently probed by the Salesko team;
 * the mechanism is not asserted here, only the observed variance.)
 *
 * A release artifact that carries an in-release hardlink alias is therefore a
 * file whose own `realpath` is not a stable description of it, and the earlier
 * `realpath(leaf) === leaf` rule refused a good artifact on a Bun-compiled
 * daemon. The rule is now: the PARENT CHAIN must resolve to itself, the LEAF
 * must be a regular non-symlink file, and identity is the `(dev, ino)` behind
 * that name plus the stat tuple and the digest already bound.
 *
 * Nothing is weaker for it. Each of the four cases below is the check that
 * would have to fail for a substitution to get through.
 */
describe('path identity is the inode behind a symlink-free name', () => {
  /**
   * The observed Bun/Darwin answer, made deterministic through the existing
   * probe seam: `realpath` on the leaf returns the OTHER name for the same
   * inode, while `lstat` still reports a regular, non-symlink file.
   */
  function siblingRealpathProbe(leaf: string, sibling: string): ToolImplementationFsProbe {
    const base = rootOwnedProbe();
    return {
      lstat: (target) => base.lstat(target),
      digest: (target) => base.digest(target),
      realpath: async (target) => (target === leaf ? sibling : base.realpath(target)),
    };
  }

  it('accepts a leaf whose own realpath answers with a sibling name, at resolve and at the gate', async () => {
    const probe = siblingRealpathProbe(artifact, path.join(dir, 'salesko-agent-alias'));
    // Non-vacuous: this probe really does break the old `realpath === target`
    // rule, and `lstat` really does still call the leaf a regular file.
    expect(await probe.realpath(artifact)).not.toBe(artifact);
    expect((await probe.lstat(artifact)).isSymbolicLink).toBe(false);

    const identity = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(artifact, artifactDigest)),
      locator(artifact),
      ENV,
      probe,
    );
    expect(identity.kind).toBe('attested');
    const attested = identity as ToolImplementationAttestedV1;
    expect(attested.installStat.ino).toBe((await fs.stat(artifact)).ino);
    expect(await reverifyToolImplementationIdentity(attested, ENV, probe)).toBe('ok');
    await expect(assertToolImplementationBeforeSpawn('probe', attested, ENV, probe))
      .resolves.toBeUndefined();
  });

  it('accepts a real hardlink alias of the attested artifact as the same file', async () => {
    // Two names, one inode, on a real filesystem: the alias IS the artifact,
    // and refusing it would refuse a legitimate release layout.
    const alias = path.join(dir, 'salesko-agent-alias');
    await fs.link(artifact, alias);
    const [aliasStat, originalStat] = [await fs.lstat(alias), await fs.lstat(artifact)];
    expect(aliasStat.ino).toBe(originalStat.ino);
    expect(aliasStat.dev).toBe(originalStat.dev);
    expect(aliasStat.isSymbolicLink()).toBe(false);

    const identity = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(alias, artifactDigest)),
      locator(alias),
      ENV,
      rootOwnedProbe(),
    );
    expect(identity.kind).toBe('attested');
    const attested = identity as ToolImplementationAttestedV1;
    expect(attested.installStat.ino).toBe(originalStat.ino);
    expect(await reverifyToolImplementationIdentity(attested, ENV, rootOwnedProbe())).toBe('ok');
    await expect(assertToolImplementationBeforeSpawn('probe', attested, ENV, rootOwnedProbe()))
      .resolves.toBeUndefined();
  });

  it('still refuses a symlink leaf at the gate, not only at resolve', async () => {
    const link = path.join(dir, 'current');
    await fs.symlink(artifact, link);
    const attested = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(artifact, artifactDigest)),
      locator(artifact),
      ENV,
      rootOwnedProbe(),
    ) as ToolImplementationAttestedV1;
    // The same identity, asked about the link's name: a symlink is never the
    // attested file, even when it points at it.
    const throughLink = { ...attested, installPath: link };
    expect(await reverifyToolImplementationIdentity(throughLink, ENV, rootOwnedProbe()))
      .toEqual({ reason: 'install_record_mismatch', subject: 'artifact' });
    await expect(assertToolImplementationBeforeSpawn('probe', throughLink, ENV, rootOwnedProbe()))
      .rejects.toThrow(/install_record_mismatch \(artifact\)/u);
  });

  it('refuses a parent directory that resolves somewhere else', async () => {
    // Where a path substitution actually lives once the leaf itself cannot be
    // a link: swap a DIRECTORY component for one whoever owns the link picks.
    const real = path.join(dir, 'release-2026.9.1');
    await fs.mkdir(real);
    const target = path.join(real, 'salesko-agent');
    await fs.copyFile(artifact, target);
    const linkedParent = path.join(dir, 'current');
    await fs.symlink(real, linkedParent);
    const throughLinkedParent = path.join(linkedParent, 'salesko-agent');
    // Non-vacuous: the leaf itself is a perfectly ordinary regular file.
    expect((await fs.lstat(throughLinkedParent)).isSymbolicLink()).toBe(false);

    const identity = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(throughLinkedParent, artifactDigest)),
      locator(throughLinkedParent),
      ENV,
      rootOwnedProbe(),
    );
    expect(identity).toEqual({ kind: 'unavailable', reason: 'install_record_mismatch' });

    const attested = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(target, artifactDigest)),
      locator(target),
      ENV,
      rootOwnedProbe(),
    ) as ToolImplementationAttestedV1;
    expect(await reverifyToolImplementationIdentity(
      { ...attested, installPath: throughLinkedParent },
      ENV,
      rootOwnedProbe(),
    )).toEqual({ reason: 'install_record_mismatch', subject: 'artifact' });
  });

  it('refuses a non-normalized path whose directory chain does not resolve to itself', async () => {
    await fs.mkdir(path.join(dir, 'sibling'));
    // Built by concatenation: `path.join` would normalize the `..` away, and
    // the point is a record that arrives NOT normalized.
    const viaDotDot = `${dir}/sibling/../salesko-agent`;
    // Non-vacuous: the path names the artifact perfectly well.
    expect((await fs.lstat(viaDotDot)).ino).toBe((await fs.lstat(artifact)).ino);
    const identity = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(viaDotDot, artifactDigest)),
      locator(viaDotDot),
      ENV,
      rootOwnedProbe(),
    );
    expect(identity).toEqual({ kind: 'unavailable', reason: 'install_record_mismatch' });
  });

  it('refuses a DIFFERENT inode at the recorded name, hardlink alias or not', async () => {
    // The other half of "identity is the inode": a hardlink is accepted only
    // when it is a link to the attested file. A link to some other file, at
    // the attested name, is a replacement.
    const attested = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(artifact, artifactDigest)),
      locator(artifact),
      ENV,
      rootOwnedProbe(),
    ) as ToolImplementationAttestedV1;
    const other = path.join(dir, 'other-bytes');
    await fs.writeFile(other, 'the attested bytes\n');
    await fs.rm(artifact);
    await fs.link(other, artifact);
    // Non-vacuous: the bytes still hash to the attested digest, so only the
    // inode can be what refuses this.
    expect(await realToolImplementationFsProbe.digest(artifact)).toBe(attested.closureDigest);
    expect((await fs.lstat(artifact)).ino).not.toBe(attested.installStat.ino);
    expect(await reverifyToolImplementationIdentity(attested, ENV, rootOwnedProbe()))
      .toEqual({ reason: 'install_record_mismatch', subject: 'artifact' });
  });
});

/**
 * The sealed asset set (§80). These run against the `runtime` subject's
 * locator, because that is the subject whose contract requires them — but the
 * MEASUREMENT is the record's, not the subject's, so the suite exercises it
 * exactly where a host declares one.
 */
describe('the sealed asset set is measured like the artifact, per file', () => {
  let assetRoot: string;
  let theme: string;
  let wasm: string;
  let assets: readonly { path: string; digest: string }[];

  beforeEach(async () => {
    assetRoot = path.join(dir, 'release-assets');
    await fs.mkdir(path.join(assetRoot, 'dist', 'modes', 'interactive', 'theme'), { recursive: true });
    theme = path.join(assetRoot, 'dist', 'modes', 'interactive', 'theme', 'dark.json');
    wasm = path.join(assetRoot, 'photon_rs_bg.wasm');
    await fs.writeFile(theme, '{"name":"dark"}\n');
    await fs.writeFile(wasm, 'not really wasm\n');
    // Sorted, as the record contract requires.
    assets = Object.freeze([
      {
        path: path.join('dist', 'modes', 'interactive', 'theme', 'dark.json'),
        digest: await realToolImplementationFsProbe.digest(theme),
      },
      {
        path: 'photon_rs_bg.wasm',
        digest: await realToolImplementationFsProbe.digest(wasm),
      },
    ]);
  });

  function recordWithAssets(
    overrides: {
      readonly assetRoot?: string;
      readonly assets?: readonly { path: string; digest: string }[];
    } = {},
  ): ToolImplementationInstallRecordV1 {
    return {
      ...installRecord(artifact, artifactDigest),
      launchArgv: ['__byok_sdk_helper', 'pi-rpc'],
      assetRoot: overrides.assetRoot ?? assetRoot,
      assets: overrides.assets ?? assets,
    };
  }

  async function resolveWithAssets(
    record: ToolImplementationInstallRecordV1,
  ): Promise<ToolImplementationIdentityV1> {
    const declaration = await resolveRuntimeImplementation(
      authorityReturning(runtimeRecordFixture(record)),
      runtimeLocator(artifact),
      ENV,
      rootOwnedProbe(),
    );
    return declaration.kind === 'attested' ? declaration.identity : declaration;
  }

  it('seals one stat tuple per declared asset, in the record order', async () => {
    const identity = await resolveWithAssets(recordWithAssets());
    expect(identity.kind).toBe('attested');
    const attested = identity as ToolImplementationAttestedV1;
    expect(attested.assetRoot).toBe(assetRoot);
    expect(attested.assets).toEqual(assets);
    expect(attested.assetStats).toHaveLength(2);
    // SDK-measured, not resolver-supplied: the record carried no tuples.
    expect(attested.assetStats?.[0]?.ino).toBe((await fs.lstat(theme)).ino);
    expect(attested.assetStats?.[1]?.ino).toBe((await fs.lstat(wasm)).ino);
    expect(attested.assetStats?.[0]?.uid).toBe(0);
    expect(await reverifyToolImplementationIdentity(attested, ENV, rootOwnedProbe())).toBe('ok');
  });

  it('refuses a declared asset that is not on disk', async () => {
    await fs.rm(wasm);
    expect(await resolveWithAssets(recordWithAssets()))
      .toEqual({ kind: 'unavailable', reason: 'install_record_mismatch' });
  });

  it('refuses a declared asset whose bytes do not hash to the declared digest', async () => {
    await fs.writeFile(theme, '{"name":"dark!"}\n');
    expect(await resolveWithAssets(recordWithAssets()))
      .toEqual({ kind: 'unavailable', reason: 'install_record_mismatch' });
  });

  it('refuses an asset reached through a symlink leaf', async () => {
    const elsewhere = path.join(dir, 'planted-theme.json');
    await fs.writeFile(elsewhere, '{"name":"dark"}\n');
    await fs.rm(theme);
    await fs.symlink(elsewhere, theme);
    // Non-vacuous: the link's TARGET hashes to exactly the declared digest, so
    // only the leaf check can be what refuses this.
    expect(await realToolImplementationFsProbe.digest(theme)).toBe(assets[0]!.digest);
    expect(await resolveWithAssets(recordWithAssets()))
      .toEqual({ kind: 'unavailable', reason: 'install_record_mismatch' });
  });

  it('refuses an asset path that climbs out of the asset root', async () => {
    const outside = path.join(dir, 'outside.json');
    await fs.writeFile(outside, '{"name":"dark"}\n');
    const record = recordWithAssets({
      assets: [{ path: path.join('..', 'outside.json'), digest: await realToolImplementationFsProbe.digest(outside) }],
    });
    // Rejected as a RECORD, before anything is measured: the declared path is
    // not a normalized, climb-free relative path.
    expect(await resolveWithAssets(record))
      .toEqual({ kind: 'unavailable', reason: 'implementation_identity_unattested' });
  });

  it('refuses an asset root that is not itself, symlinked in its own parent chain', async () => {
    const linkedRoot = path.join(dir, 'linked-assets');
    await fs.symlink(assetRoot, linkedRoot);
    expect(await resolveWithAssets(recordWithAssets({ assetRoot: linkedRoot })))
      .toEqual({ kind: 'unavailable', reason: 'install_record_mismatch' });
  });

  it('refuses an asset list that is unsorted or carries a duplicate', async () => {
    expect(await resolveWithAssets(recordWithAssets({ assets: [assets[1]!, assets[0]!] })))
      .toEqual({ kind: 'unavailable', reason: 'implementation_identity_unattested' });
    expect(await resolveWithAssets(recordWithAssets({ assets: [assets[0]!, assets[0]!] })))
      .toEqual({ kind: 'unavailable', reason: 'implementation_identity_unattested' });
  });

  it('refuses an asset root with no assets, and assets with no root', async () => {
    const { assets: _assets, ...rootOnly } = recordWithAssets();
    expect(await resolveWithAssets(rootOnly as ToolImplementationInstallRecordV1))
      .toEqual({ kind: 'unavailable', reason: 'implementation_identity_unattested' });
    const { assetRoot: _root, ...assetsOnly } = recordWithAssets();
    expect(await resolveWithAssets(assetsOnly as ToolImplementationInstallRecordV1))
      .toEqual({ kind: 'unavailable', reason: 'implementation_identity_unattested' });
  });

  it('re-measures every asset before a spawn, not only at resolve', async () => {
    const attested = await resolveWithAssets(recordWithAssets()) as ToolImplementationAttestedV1;
    // A byte change under an UNCHANGED stat tuple, so only the digest can be
    // what refuses this — the same seam the artifact's own byte-flip case uses.
    const bytesMoved: ToolImplementationFsProbe = {
      ...rootOwnedProbe(),
      digest: async (target) => (target === wasm
        ? createHash('sha256').update('hostile bytes, identical tuple\n').digest('hex')
        : realToolImplementationFsProbe.digest(target)),
    };
    expect(await reverifyToolImplementationIdentity(attested, ENV, bytesMoved))
      .toEqual({ reason: 'reverify_failed', subject: 'asset' });
    // And a change that DOES move the tuple is the other word, on the same file.
    await fs.writeFile(wasm, 'hostile bytes, different length!\n');
    expect(await reverifyToolImplementationIdentity(attested, ENV, rootOwnedProbe()))
      .toEqual({ reason: 'install_record_mismatch', subject: 'asset' });
  });

  it('refuses at spawn an asset replaced by a different inode with identical bytes', async () => {
    const attested = await resolveWithAssets(recordWithAssets()) as ToolImplementationAttestedV1;
    const replacement = path.join(dir, 'replacement-theme.json');
    await fs.writeFile(replacement, '{"name":"dark"}\n');
    await fs.rm(theme);
    await fs.rename(replacement, theme);
    // Non-vacuous: the bytes still hash to the declared digest.
    expect(await realToolImplementationFsProbe.digest(theme)).toBe(assets[0]!.digest);
    expect(await reverifyToolImplementationIdentity(attested, ENV, rootOwnedProbe()))
      .toEqual({ reason: 'install_record_mismatch', subject: 'asset' });
  });

  it('refuses at spawn an asset that stopped being readable', async () => {
    const attested = await resolveWithAssets(recordWithAssets()) as ToolImplementationAttestedV1;
    const unreadable: ToolImplementationFsProbe = {
      ...rootOwnedProbe(),
      digest: async (target) => {
        if (target === wasm) throw new Error('EACCES');
        return realToolImplementationFsProbe.digest(target);
      },
    };
    expect(await reverifyToolImplementationIdentity(attested, ENV, unreadable))
      .toEqual({ reason: 'reverify_failed', subject: 'asset' });
  });

  it('carries the sealed asset tuples through the task-scoped file, both directions', async () => {
    const attested = await resolveWithAssets(recordWithAssets()) as ToolImplementationAttestedV1;
    expect(parseToolImplementationIdentity(JSON.parse(JSON.stringify(attested)))).toEqual(attested);
    // A record that declares assets but arrives with no tuples could only be
    // reverified by digest.
    const { assetStats: _stats, ...withoutStats } = JSON.parse(JSON.stringify(attested)) as Record<string, unknown>;
    expect(parseToolImplementationIdentity(withoutStats)).toBeUndefined();
    // And tuples for assets nobody declared are measurements from nowhere.
    const { assetRoot: _r, assets: _a, ...withoutAssets } = JSON.parse(JSON.stringify(attested)) as Record<string, unknown>;
    expect(parseToolImplementationIdentity(withoutAssets)).toBeUndefined();
  });

  it('leaves an MCP record with no asset set untouched', async () => {
    const identity = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(artifact, artifactDigest)),
      locator(artifact),
      ENV,
      rootOwnedProbe(),
    );
    const attested = identity as ToolImplementationAttestedV1;
    expect(attested.assetRoot).toBeUndefined();
    expect(attested.assets).toBeUndefined();
    expect(attested.assetStats).toBeUndefined();
    expect(await reverifyToolImplementationIdentity(attested, ENV, rootOwnedProbe())).toBe('ok');
  });
});
