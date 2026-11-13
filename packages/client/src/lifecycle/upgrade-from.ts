import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * #1316: what a Host that skips releases must act on. The installed
 * `@byok-sdk/client` ships its current upgrade manifest and every released
 * one (`upgrade-history/<from>-<to>.json`, from 0.31.0); the check reads
 * them as they are and never derives entries from anything else.
 */

/** The nine public packages released together as one train; client stays first. */
const UPGRADE_TRAIN_PACKAGES = [
  '@byok-sdk/client', '@byok-sdk/bot-collaboration', '@byok-sdk/cloud', '@byok-sdk/cloud-dataplane', '@byok-sdk/core',
  '@byok-sdk/keys', '@byok-sdk/protocol', '@byok-sdk/server', '@byok-sdk/ui-runtime',
] as const;

/** The first release whose manifest is in the history. An older `from` has no manifest to read. */
const UPGRADE_HISTORY_START = '0.31.0';

export type UpgradeFromRefusalCode = 'upgrade_from_unsupported' | 'upgrade_history_unavailable' | 'upgrade_train_unresolved';

export interface UpgradeFromBreakingEntry {
  readonly id: string;
  /** The release that ships the change. */
  readonly release: string;
  /** `<repo doc>.md#<anchor>` or a byok-sdk issue/PR URL. */
  readonly migration: string;
}

export interface UpgradeTrainPackage {
  readonly name: string;
  /** The resolved package version, or `'absent'` when it does not resolve. */
  readonly version: string;
}

export interface UpgradeFromReport {
  readonly from: string;
  /** The resolved `@byok-sdk/client` version; `null` when it does not resolve. */
  readonly to: string | null;
  /** Every breaking entry released after `from`, up to and including `to`. */
  readonly breaking: readonly UpgradeFromBreakingEntry[];
  readonly additiveCount: number;
  readonly train: { readonly version: string | null; readonly packages: readonly UpgradeTrainPackage[] };
  /** `pass`: no breaking entry in the range and every resolved package is on the client's version. */
  readonly verdict: 'pass' | 'refused';
  /** Set when the range could not be checked at all. */
  readonly refusal?: { readonly code: UpgradeFromRefusalCode; readonly message: string };
}

interface ManifestFile {
  readonly from: { readonly version: string };
  readonly to: { readonly version: string };
  readonly entries: readonly { readonly id: string; readonly impact: 'additive' | 'breaking'; readonly migration: string }[];
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function compareVersions(a: string, b: string): number {
  const left = VERSION.exec(a)!;
  const right = VERSION.exec(b)!;
  for (let index = 1; index <= 3; index += 1) {
    const delta = Number(left[index]) - Number(right[index]);
    if (delta !== 0) return delta;
  }
  if (left[4] === right[4]) return 0;
  if (left[4] === undefined) return 1;
  if (right[4] === undefined) return -1;
  const x = left[4].split('.');
  const y = right[4].split('.');
  for (let index = 0; index < Math.min(x.length, y.length); index += 1) {
    if (x[index] === y[index]) continue;
    const numeric = /^\d+$/.test(x[index]!) && /^\d+$/.test(y[index]!);
    return numeric ? Number(x[index]) - Number(y[index]) : x[index]! < y[index]! ? -1 : 1;
  }
  return x.length - y.length;
}

function resolvePackageJson(require: NodeJS.Require, name: string): string | undefined {
  try {
    return require.resolve(`${name}/package.json`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return undefined;
    throw error;
  }
}

/**
 * Lists the breaking upgrade-manifest entries released after `fromVersion`
 * up to the `@byok-sdk/client` that resolves from `options.resolveFrom`
 * (default: the working directory), and checks that every public
 * `@byok-sdk/*` package resolving from there is on that client's version.
 *
 * Throws when `fromVersion` is not a version or is newer than the client.
 */
export function checkUpgradeFrom(fromVersion: string, options: { readonly resolveFrom?: string } = {}): UpgradeFromReport {
  if (!VERSION.test(fromVersion)) throw new Error(`upgrade check --from: ${JSON.stringify(fromVersion)} is not a version`);
  const require = createRequire(path.join(path.resolve(options.resolveFrom ?? process.cwd()), 'noop.js'));
  const resolved = UPGRADE_TRAIN_PACKAGES.map((name) => {
    const file = resolvePackageJson(require, name);
    return { name, file, version: file === undefined ? 'absent' : (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version };
  });
  const client = resolved[0]!;
  const packages = resolved.map(({ name, version }) => ({ name, version }));
  const refused = (to: string | null, code: UpgradeFromRefusalCode, message: string): UpgradeFromReport => ({
    from: fromVersion, to, breaking: [], additiveCount: 0, train: { version: to, packages }, verdict: 'refused', refusal: { code, message },
  });
  if (client.file === undefined) {
    return refused(null, 'upgrade_train_unresolved', `@byok-sdk/client does not resolve from ${options.resolveFrom ?? process.cwd()}`);
  }
  const current = client.version;
  if (compareVersions(fromVersion, current) > 0) throw new Error(`upgrade check --from: ${fromVersion} is newer than @byok-sdk/client ${current}`);
  if (compareVersions(fromVersion, UPGRADE_HISTORY_START) < 0) {
    return refused(current, 'upgrade_from_unsupported',
      `the upgrade manifest history starts at ${UPGRADE_HISTORY_START}; read docs/releases/host-upgrade-${current}.md to upgrade from ${fromVersion}`);
  }
  const clientDir = path.dirname(client.file);
  const historyDir = path.join(clientDir, 'upgrade-history');
  const manifestFile = path.join(clientDir, 'upgrade-manifest.json');
  if (!existsSync(historyDir) || !existsSync(manifestFile)) {
    return refused(current, 'upgrade_history_unavailable', `@byok-sdk/client at ${clientDir} has no upgrade-history/ or upgrade-manifest.json`);
  }
  const files = [...readdirSync(historyDir).filter((name) => name.endsWith('.json')).map((name) => path.join(historyDir, name)), manifestFile];
  const breaking: UpgradeFromBreakingEntry[] = [];
  let additiveCount = 0;
  for (const file of files) {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as ManifestFile;
    // A released manifest (`from < to`) ships its entries in `to`; the
    // in-development one (`from == to`) in the client's own version.
    const release = manifest.from.version === manifest.to.version ? current : manifest.to.version;
    if (compareVersions(release, fromVersion) <= 0 || compareVersions(release, current) > 0) continue;
    for (const entry of manifest.entries) {
      if (entry.impact === 'breaking') breaking.push({ id: entry.id, release, migration: entry.migration });
      else additiveCount += 1;
    }
  }
  breaking.sort((a, b) => compareVersions(a.release, b.release));
  const trainConsistent = packages.every((pkg) => pkg.version === 'absent' || pkg.version === current);
  return {
    from: fromVersion, to: current, breaking, additiveCount, train: { version: current, packages },
    verdict: breaking.length === 0 && trainConsistent ? 'pass' : 'refused',
  };
}
