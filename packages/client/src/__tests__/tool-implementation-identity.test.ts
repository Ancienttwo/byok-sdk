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
    launchEnvNamesDigest: EMPTY_MAP_DIGEST,
    loaderEnvValuesDigest: EMPTY_MAP_DIGEST,
  } as ToolImplementationInstallRecordV1;
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
    const identity = await resolveToolImplementationIdentity(undefined, locator(artifact));
    expect(identity).toEqual({ kind: 'unavailable', reason: 'resolver_unconfigured' });
  });

  it('never promotes an absolute path on its own into an attestation', async () => {
    // The record is well-formed and the path is absolute and real — only the
    // ownership is the ordinary one a test process can produce.
    const identity = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(artifact, artifactDigest)),
      locator(artifact),
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
      rootOwnedProbe(),
    );
    expect(identity).toEqual({ kind: 'unavailable', reason: 'install_record_mismatch' });
  });

  it('refuses a writable artifact even when every other fact holds', async () => {
    const identity = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(artifact, artifactDigest)),
      locator(artifact),
      rootOwnedProbe({ mode: 0o100644 }),
    );
    expect(identity).toEqual({ kind: 'unavailable', reason: 'install_record_mismatch' });
  });

  it('reports a resolver that throws as unattested rather than raising', async () => {
    const identity = await resolveToolImplementationIdentity(
      { resolve: async () => { throw new Error('install record unavailable'); } },
      locator(artifact),
      rootOwnedProbe(),
    );
    expect(identity).toEqual({ kind: 'unavailable', reason: 'implementation_identity_unattested' });
  });

  it('passes a resolver-declared unavailable reason through verbatim', async () => {
    const identity = await resolveToolImplementationIdentity(
      authorityReturning({ kind: 'unavailable', reason: 'unencapsulated_source' }),
      locator(artifact),
      rootOwnedProbe(),
    );
    expect(identity).toEqual({ kind: 'unavailable', reason: 'unencapsulated_source' });
  });

  it('refuses a resolver reason that is not one this SDK defines', async () => {
    const identity = await resolveToolImplementationIdentity(
      authorityReturning({ kind: 'unavailable', reason: 'trust_me' }),
      locator(artifact),
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
      rootOwnedProbe(),
    );
    expect(identity).toEqual({ kind: 'unavailable', reason: 'implementation_identity_unattested' });
  });

  it('rejects a record naming an authority this SDK does not recognise', async () => {
    const identity = await resolveToolImplementationIdentity(
      authorityReturning({ ...installRecord(artifact, artifactDigest), authority: 'self-declared' }),
      locator(artifact),
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
      rootOwnedProbe(),
    );
    expect(identity).toEqual({ kind: 'unavailable', reason: 'interpreter_form_unsupported' });
  });

  it('rejects an interpreter+bundle that names no interpreter', async () => {
    const identity = await resolveToolImplementationIdentity(
      authorityReturning({ ...installRecord(artifact, artifactDigest), form: 'interpreter+bundle' }),
      locator(artifact),
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
        rootOwnedProbe(),
      );
      expect(identity).toEqual({ kind: 'unavailable', reason: 'implementation_identity_unattested' });
    }
  });
});

describe('an attested identity is unconstructible from a parsed value it did not measure', () => {
  it('refuses a parsed record that carries no SDK-measured stat tuple', () => {
    expect(parseToolImplementationIdentity(installRecord(artifact, artifactDigest))).toBeUndefined();
  });

  it('refuses a parsed record with an unknown key', async () => {
    const attested = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(artifact, artifactDigest)),
      locator(artifact),
      rootOwnedProbe(),
    ) as ToolImplementationAttestedV1;
    expect(parseToolImplementationIdentity({ ...attested, trusted: true })).toBeUndefined();
  });

  it('round-trips an identity this SDK produced, through JSON, unchanged', async () => {
    const attested = await resolveToolImplementationIdentity(
      authorityReturning(installRecord(artifact, artifactDigest)),
      locator(artifact),
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
      rootOwnedProbe(),
    );
    expect(identity.kind).toBe('attested');
    return identity as ToolImplementationAttestedV1;
  }

  it('passes when nothing about the artifact changed', async () => {
    expect(await reverifyToolImplementationIdentity(await attest(), rootOwnedProbe())).toBe('ok');
  });

  it('fails when one byte of the artifact is rewritten between resolve and spawn', async () => {
    const attested = await attest();
    await fs.appendFile(artifact, '!');
    expect(await reverifyToolImplementationIdentity(attested, rootOwnedProbe()))
      .toEqual({ reason: 'install_record_mismatch' });
  });

  it('fails on an mtime-only change, with the bytes still identical', async () => {
    const attested = await attest();
    const moved = new Date(Date.now() + 120_000);
    await fs.utimes(artifact, moved, moved);
    expect(await realToolImplementationFsProbe.digest(artifact)).toBe(attested.closureDigest);
    expect(await reverifyToolImplementationIdentity(attested, rootOwnedProbe()))
      .toEqual({ reason: 'install_record_mismatch' });
  });

  it('fails when the artifact is replaced by a file with the same bytes', async () => {
    const attested = await attest();
    const replacement = path.join(dir, 'replacement');
    await fs.writeFile(replacement, 'the attested bytes\n');
    await fs.rename(replacement, artifact);
    expect(await realToolImplementationFsProbe.digest(artifact)).toBe(attested.closureDigest);
    expect(await reverifyToolImplementationIdentity(attested, rootOwnedProbe()))
      .toEqual({ reason: 'install_record_mismatch' });
  });

  it('fails when the artifact is gone', async () => {
    const attested = await attest();
    await fs.rm(artifact);
    expect(await reverifyToolImplementationIdentity(attested, rootOwnedProbe()))
      .toEqual({ reason: 'install_record_mismatch' });
  });

  it('refuses the spawn, non-retryably and with the reason, when reverification fails', async () => {
    const attested = await attest();
    await fs.appendFile(artifact, '!');
    await expect(assertToolImplementationBeforeSpawn('MCP toolset server "salesko"', attested, rootOwnedProbe()))
      .rejects.toThrow(ToolImplementationReverifyError);
    await expect(assertToolImplementationBeforeSpawn('MCP toolset server "salesko"', attested, rootOwnedProbe()))
      .rejects.toThrow(/install_record_mismatch/u);
  });

  it('lets an unavailable identity and an absent one through: neither carries a claim to break', async () => {
    await expect(assertToolImplementationBeforeSpawn('probe', undefined, rootOwnedProbe())).resolves.toBeUndefined();
    await expect(assertToolImplementationBeforeSpawn(
      'probe',
      { kind: 'unavailable', reason: 'resolver_unconfigured' },
      rootOwnedProbe(),
    )).resolves.toBeUndefined();
  });
});
