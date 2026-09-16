import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decideRuntimeLaunch,
  deriveRuntimeLaunchDescription,
  parseToolImplementationIdentity,
  resolveToolImplementationIdentity,
  RUNTIME_LAUNCH_ENV_COMMITMENT_NAMES,
  runtimeLaunchDescriptionDigest,
  toolImplementationUnavailable,
  type RuntimeLaunchInputV1,
  type ToolImplementationAttestedV1,
  type ToolImplementationAuthority,
  type ToolImplementationLocatorV1,
} from '../daemon/tool-implementation-identity';
import {
  piRuntimeIdentityFromAttestedRecord,
  SUPPORTED_PREPARED_COMPILER_VERSION,
} from '../adapters/pi/input-preparation';
import { resolvePiRuntimeIdentity } from '../adapters/pi/resolve-bin';
import { BYOK_SDK_HELPER_SUBCOMMAND } from '../sdk-reserved-helper-host';

/**
 * Nothing in this file touches the filesystem. Derivation is pure by contract:
 * the measurement already happened in `resolveToolImplementationIdentity` and
 * happens again in `reverifyToolImplementationIdentity`, and a derivation that
 * read the disk would be a third moment nobody re-checks.
 *
 * The identities below are therefore built through
 * `parseToolImplementationIdentity` — the same strict validator the daemon's
 * task-scoped file goes through — from fixed, synthetic values, so the golden
 * digest below is a function of the description's content alone and of nothing
 * about the machine the suite runs on.
 */

const PIN = resolvePiRuntimeIdentity();

// Deliberately not spelled like the pin: the description carries no version,
// so the golden below must not move when the pin does.
const RELEASE = '/opt/byok/releases/pi-release-1';
const ASSET_ROOT = `${RELEASE}/assets`;
const SEALED_CWD = '/var/byok/sealed/launch';
const SESSION_CWD = '/var/byok/agents/agent-1';

const STAT = Object.freeze({
  dev: 16777232,
  ino: 4242,
  size: 1024,
  mtimeMs: 1789000000000,
  mode: 0o100555,
  uid: 0,
  gid: 0,
});

const NATIVE_PROVENANCE = Object.freeze({
  packageName: PIN.name,
  packageVersion: PIN.version,
  upstreamBase: '0.85.0',
  upstreamCommit: 'c'.repeat(40),
  forkBuild: 1002,
  compilerVersion: SUPPORTED_PREPARED_COMPILER_VERSION,
});

const ASSETS = Object.freeze([
  { path: 'dist/modes/interactive/theme/dark.json', digest: '1'.repeat(64) },
  { path: 'dist/modes/interactive/theme/light.json', digest: '2'.repeat(64) },
  { path: 'photon_rs_bg.wasm', digest: '3'.repeat(64) },
]);

/** Build one attested identity through the strict validator, never by hand. */
function attested(overrides: Record<string, unknown> = {}): ToolImplementationAttestedV1 {
  const value: Record<string, unknown> = {
    kind: 'attested',
    authority: 'host-install-record',
    manifestRevision: 'salesko@2026.9.16',
    form: 'interpreter+bundle',
    installPath: `${RELEASE}/pi-bundle.js`,
    closureDigest: 'a'.repeat(64),
    closureKind: 'artifact',
    interpreter: {
      path: `${RELEASE}/bun`,
      digest: 'b'.repeat(64),
      loadCommandsDigest: 'e'.repeat(64),
    },
    launchArgv: ['__byok_sdk_helper', 'pi-rpc'],
    launchCwd: SEALED_CWD,
    assetRoot: ASSET_ROOT,
    assets: ASSETS.map((asset) => ({ ...asset })),
    nativeProvenance: { ...NATIVE_PROVENANCE },
    installStat: { ...STAT },
    interpreterStat: { ...STAT, ino: 4343 },
    assetStats: ASSETS.map((_asset, index) => ({ ...STAT, ino: 5000 + index })),
    launchEnvNamesDigest: 'd'.repeat(64),
    loaderEnvValuesDigest: 'f'.repeat(64),
    ...overrides,
  };
  for (const [key, entry] of Object.entries(overrides)) {
    if (entry === undefined) delete value[key];
  }
  const identity = parseToolImplementationIdentity(value);
  if (identity === undefined || identity.kind !== 'attested') {
    throw new Error(`fixture is not a valid attested identity: ${JSON.stringify(value)}`);
  }
  return identity;
}

const INPUT: RuntimeLaunchInputV1 = Object.freeze({
  runtimeId: 'pi',
  kind: 'pi-rpc',
  sessionCwd: SESSION_CWD,
  pin: PIN,
});

describe('a runtime launch description is derived from the record, never discovered', () => {
  it('takes the interpreter and the sealed bundle from the attested identity itself', () => {
    const description = deriveRuntimeLaunchDescription(attested(), INPUT);
    expect(description).toEqual({
      runtimeId: 'pi',
      kind: 'pi-rpc',
      command: `${RELEASE}/bun`,
      entry: `${RELEASE}/pi-bundle.js`,
      fixedArgv: ['__byok_sdk_helper', 'pi-rpc'],
      processCwd: SEALED_CWD,
      sessionCwd: SESSION_CWD,
      assetRoot: ASSET_ROOT,
      envCommitments: ['PI_PACKAGE_DIR'],
      credentialSource: 'pi-auth-store',
      directoryValues: { PI_PACKAGE_DIR: ASSET_ROOT },
    });
  });

  it('names the compiled artifact itself, with no entry, for a compiled-executable release', () => {
    const description = deriveRuntimeLaunchDescription(
      attested({ form: 'compiled-executable', interpreter: undefined, interpreterStat: undefined }),
      INPUT,
    );
    expect(description).toMatchObject({ command: `${RELEASE}/pi-bundle.js` });
    expect(description).not.toHaveProperty('entry');
  });

  it('binds the fixed argv prefix per kind, and nothing else', () => {
    expect(deriveRuntimeLaunchDescription(attested(), INPUT))
      .toMatchObject({ fixedArgv: ['__byok_sdk_helper', 'pi-rpc'] });
    expect(deriveRuntimeLaunchDescription(
      attested({ launchArgv: ['__byok_sdk_helper', 'pi-prepared'] }),
      { ...INPUT, kind: 'pi-prepared' },
    )).toMatchObject({ fixedArgv: ['__byok_sdk_helper', 'pi-prepared'] });
  });

  it('spells the reserved-helper dispatch token the helper host actually reads', () => {
    // The identity module cannot import `sdk-reserved-helper-host.ts`: that
    // module pulls in every reserved helper runner, and the identity authority
    // is reachable from the SDK root. The token is therefore written out there
    // and its agreement with the one spelling that matters is asserted here,
    // so the duplication cannot drift silently.
    const description = deriveRuntimeLaunchDescription(attested(), INPUT);
    expect((description as Exclude<typeof description, string>).fixedArgv[0])
      .toBe(BYOK_SDK_HELPER_SUBCOMMAND);
  });

  it('commits exactly the env names the description is the authority for', () => {
    expect(RUNTIME_LAUNCH_ENV_COMMITMENT_NAMES).toEqual(['PI_PACKAGE_DIR']);
    expect(deriveRuntimeLaunchDescription(attested(), INPUT))
      .toMatchObject({ envCommitments: RUNTIME_LAUNCH_ENV_COMMITMENT_NAMES, assetRoot: ASSET_ROOT });
  });

  it('refuses a record whose declared argv is not the fixed prefix for the kind', () => {
    // The host does not get to point an attested interpreter at another entry
    // of the same attested bundle.
    expect(deriveRuntimeLaunchDescription(attested({ launchArgv: ['__byok_sdk_helper', 'pi-prepared'] }), INPUT))
      .toBe('install_record_mismatch');
    expect(deriveRuntimeLaunchDescription(
      attested({ launchArgv: ['__byok_sdk_helper', 'pi-rpc', '--session', '/tmp/s'] }),
      INPUT,
    )).toBe('install_record_mismatch');
    expect(deriveRuntimeLaunchDescription(attested({ launchArgv: [] }), INPUT))
      .toBe('install_record_mismatch');
  });

  it('refuses a sealed launch cwd that is the Agent home', () => {
    // The defect the whole contract exists to close: a writable process cwd
    // executes `bunfig.toml` preload and `.env` before any check inside the
    // entry can run.
    expect(deriveRuntimeLaunchDescription(attested(), { ...INPUT, sessionCwd: SEALED_CWD }))
      .toBe('install_record_mismatch');
  });

  it('refuses a session cwd that is relative or not normalized', () => {
    expect(deriveRuntimeLaunchDescription(attested(), { ...INPUT, sessionCwd: 'agents/agent-1' }))
      .toBe('install_record_mismatch');
    expect(deriveRuntimeLaunchDescription(attested(), { ...INPUT, sessionCwd: '/var/byok/agents/../agents/agent-1' }))
      .toBe('install_record_mismatch');
  });

  it('refuses a record that names a second entry authority', () => {
    expect(deriveRuntimeLaunchDescription(attested({ entry: `${RELEASE}/other-entry.js` }), INPUT))
      .toBe('install_record_mismatch');
  });

  it('refuses a record with no sealed asset set', () => {
    expect(deriveRuntimeLaunchDescription(
      attested({ assetRoot: undefined, assets: undefined, assetStats: undefined }),
      INPUT,
    )).toBe('install_record_mismatch');
  });

  it('refuses a record with no native provenance, and one that is not the pin', () => {
    expect(deriveRuntimeLaunchDescription(attested({ nativeProvenance: undefined }), INPUT))
      .toBe('install_record_mismatch');
    expect(deriveRuntimeLaunchDescription(
      attested({ nativeProvenance: { ...NATIVE_PROVENANCE, packageVersion: '0.85.9999' } }),
      INPUT,
    )).toBe('install_record_mismatch');
    expect(deriveRuntimeLaunchDescription(
      attested({ nativeProvenance: { ...NATIVE_PROVENANCE, packageName: '@somebody/pi' } }),
      INPUT,
    )).toBe('install_record_mismatch');
  });
});

describe('the description digest is a function of the description alone', () => {
  /**
   * A GOLDEN. It changes only when the description's content or its canonical
   * spelling changes, and either of those is a launch contract change that a
   * consumer carrying the digest from decision to spawn must see.
   */
  const RPC_GOLDEN = 'd45a6968b61d73490461e289007754d313c84116e42639e732b4860be70a2ca2';

  /** The exact bytes the golden hashes, written out so it is not a magic value. */
  const RPC_CANONICAL = '{"assetRoot":"/opt/byok/releases/pi-release-1/assets",'
    + '"command":"/opt/byok/releases/pi-release-1/bun",'
    + '"credentialSource":"pi-auth-store",'
    + '"directoryValues":{"PI_PACKAGE_DIR":"/opt/byok/releases/pi-release-1/assets"},'
    + '"entry":"/opt/byok/releases/pi-release-1/pi-bundle.js",'
    + '"envCommitments":["PI_PACKAGE_DIR"],'
    + '"fixedArgv":["__byok_sdk_helper","pi-rpc"],'
    + '"kind":"pi-rpc",'
    + '"processCwd":"/var/byok/sealed/launch",'
    + '"runtimeId":"pi",'
    + '"sessionCwd":"/var/byok/agents/agent-1"}';

  it('digests the pi-rpc description to its golden value', () => {
    const description = deriveRuntimeLaunchDescription(attested(), INPUT);
    expect(typeof description).not.toBe('string');
    expect(createHash('sha256').update(RPC_CANONICAL, 'utf8').digest('hex')).toBe(RPC_GOLDEN);
    expect(runtimeLaunchDescriptionDigest(description as Exclude<typeof description, string>))
      .toBe(RPC_GOLDEN);
  });

  it('is stable across two derivations of the same inputs', () => {
    const first = deriveRuntimeLaunchDescription(attested(), INPUT) as Exclude<
      ReturnType<typeof deriveRuntimeLaunchDescription>,
      string
    >;
    const second = deriveRuntimeLaunchDescription(attested(), INPUT) as typeof first;
    expect(runtimeLaunchDescriptionDigest(first)).toBe(runtimeLaunchDescriptionDigest(second));
  });

  it('moves when the session cwd moves, which the attested identity cannot carry', () => {
    const base = deriveRuntimeLaunchDescription(attested(), INPUT) as Exclude<
      ReturnType<typeof deriveRuntimeLaunchDescription>,
      string
    >;
    const other = deriveRuntimeLaunchDescription(
      attested(),
      { ...INPUT, sessionCwd: '/var/byok/agents/agent-2' },
    ) as typeof base;
    expect(runtimeLaunchDescriptionDigest(other)).not.toBe(runtimeLaunchDescriptionDigest(base));
  });

  it('moves when the kind moves', () => {
    const rpc = deriveRuntimeLaunchDescription(attested(), INPUT) as Exclude<
      ReturnType<typeof deriveRuntimeLaunchDescription>,
      string
    >;
    const prepared = deriveRuntimeLaunchDescription(
      attested({ launchArgv: ['__byok_sdk_helper', 'pi-prepared'] }),
      { ...INPUT, kind: 'pi-prepared' },
    ) as typeof rpc;
    expect(runtimeLaunchDescriptionDigest(prepared)).not.toBe(runtimeLaunchDescriptionDigest(rpc));
  });
});

describe('a runtime subject decides between three cases that cannot be confused', () => {
  it('attests a launch when the identity measured and the record describes one', () => {
    const identity = attested();
    expect(decideRuntimeLaunch(identity, INPUT)).toEqual({
      kind: 'attested',
      description: deriveRuntimeLaunchDescription(identity, INPUT),
      identity,
    });
  });

  it('keeps the dev path when no authority is wired in', () => {
    // `resolver_unconfigured` is NOT a decline: this SDK ships no resolver, so
    // declining it would decline every development run.
    expect(decideRuntimeLaunch(toolImplementationUnavailable('resolver_unconfigured'), INPUT))
      .toEqual({ kind: 'unconfigured', reason: 'resolver_unconfigured' });
  });

  it('declines every other unavailable reason, which is stricter than the MCP subject', () => {
    for (const reason of [
      'implementation_identity_unattested',
      'unencapsulated_source',
      'interpreter_not_encapsulated',
      'interpreter_form_unsupported',
      'install_record_mismatch',
      'reverify_failed',
    ] as const) {
      expect(decideRuntimeLaunch(toolImplementationUnavailable(reason), INPUT))
        .toEqual({ kind: 'declined', reason });
    }
  });

  it('declines an attested identity whose record cannot be launched', () => {
    expect(decideRuntimeLaunch(attested({ nativeProvenance: undefined }), INPUT))
      .toEqual({ kind: 'declined', reason: 'install_record_mismatch' });
  });
});

describe('the attestation subject is explicit, and the two are not interchangeable', () => {
  function capturingAuthority(): {
    readonly authority: ToolImplementationAuthority;
    readonly seen: ToolImplementationLocatorV1[];
  } {
    const seen: ToolImplementationLocatorV1[] = [];
    return {
      seen,
      authority: {
        resolve: async (input) => {
          seen.push(input);
          return toolImplementationUnavailable('unencapsulated_source');
        },
      },
    };
  }

  const LAUNCH = Object.freeze({ launchCwd: '/', launcher: null });
  const ENV = Object.freeze({ PATH: '/usr/bin:/bin' });

  it('hands the resolver the runtime subject verbatim', async () => {
    const { authority, seen } = capturingAuthority();
    await resolveToolImplementationIdentity(
      authority,
      { subject: { kind: 'runtime', runtimeId: 'pi' }, runtimeEntry: 'pi-rpc' },
      ENV,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.subject).toEqual({ kind: 'runtime', runtimeId: 'pi' });
  });

  it('hands the resolver the mcp-server subject verbatim', async () => {
    const { authority, seen } = capturingAuthority();
    await resolveToolImplementationIdentity(
      authority,
      {
        subject: { kind: 'mcp-server', toolsetId: 'salesko', serverName: 'salesko' },
        command: '/opt/salesko/agent',
        args: ['mcp', 'serve'],
        launch: LAUNCH,
      },
      ENV,
    );
    expect(seen[0]?.subject).toEqual({ kind: 'mcp-server', toolsetId: 'salesko', serverName: 'salesko' });
  });
});

describe('native provenance for the encapsulated form comes from the record and fails closed', () => {
  it('derives the runtime identity from the attested record, not from a manifest on disk', () => {
    expect(piRuntimeIdentityFromAttestedRecord(attested())).toEqual({
      packageName: PIN.name,
      packageVersion: PIN.version,
      upstreamBase: '0.85.0',
      upstreamCommit: 'c'.repeat(40),
      forkBuild: 1002,
      envelopeFormat: 'pi.session.prepared-input',
      requestFormat: 'pi.openai-completions.prepared',
      compilerVersion: SUPPORTED_PREPARED_COMPILER_VERSION,
    });
  });

  it('refuses a record that declares no nativeProvenance', () => {
    expect(() => piRuntimeIdentityFromAttestedRecord(attested({ nativeProvenance: undefined })))
      .toThrow(/declares no nativeProvenance/u);
  });

  it('refuses a record whose package identity is not the exact pin', () => {
    expect(() => piRuntimeIdentityFromAttestedRecord(
      attested({ nativeProvenance: { ...NATIVE_PROVENANCE, packageVersion: '0.85.9999' } }),
    )).toThrow(/but @byok-sdk\/client pins/u);
  });

  it('refuses a record built against another compiler contract revision', () => {
    expect(() => piRuntimeIdentityFromAttestedRecord(
      attested({ nativeProvenance: { ...NATIVE_PROVENANCE, compilerVersion: SUPPORTED_PREPARED_COMPILER_VERSION + 1 } }),
    )).toThrow(new RegExp(`prepares input against version ${String(SUPPORTED_PREPARED_COMPILER_VERSION)}$`, 'u'));
  });
});
