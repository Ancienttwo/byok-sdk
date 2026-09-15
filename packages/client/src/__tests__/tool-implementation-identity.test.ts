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
  reverifyToolImplementationIdentity,
  toolImplementationLaunchEnvNamesDigest,
  toolImplementationLoaderEnvValuesDigest,
  ToolImplementationReverifyError,
  type ToolImplementationAttestedV1,
  type ToolImplementationAuthority,
  type ToolImplementationFsProbe,
  type ToolImplementationInstallRecordV1,
  type ToolImplementationLocatorV1,
} from '../daemon/tool-implementation-identity';

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

function locator(command: string): ToolImplementationLocatorV1 {
  return { toolsetId: 'salesko', serverName: 'salesko', command, args: [], launch: LAUNCH };
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
    // `withoutProviderCredentials` at a subscription boundary and the two Pi
    // control variables are the SDK's own doing, so an identity resolved
    // before them still matches the environment that reaches the child.
    const baseline = toolImplementationLaunchEnvNamesDigest(ENV);
    expect(toolImplementationLaunchEnvNamesDigest({ ...ENV, ANTHROPIC_API_KEY: 'sk-x' })).toBe(baseline);
    expect(toolImplementationLaunchEnvNamesDigest({ ...ENV, BYOK_PI_MCP_CONFIG_PATH: '/tmp/c' })).toBe(baseline);
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
