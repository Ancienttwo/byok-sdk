import { QUALIFIED_AGY_VERSION, agyVersionToken } from '../adapters/antigravity/agy-version.js';
import { QUALIFIED_CLAUDE_VERSION, claudeVersionToken } from '../adapters/claude/claude-version.js';
import { QUALIFIED_CODEX_VERSION, codexVersionToken } from '../adapters/codex/codex-version.js';
import { QUALIFIED_DSH_VERSION, dshVersionToken } from '../adapters/dsh/dsh-version.js';
import { QUALIFIED_GROK_VERSION, grokVersionToken } from '../adapters/grok/grok-version.js';
import { QUALIFIED_OPENCODE_VERSION, opencodeVersionToken } from '../adapters/opencode/opencode-version.js';
import { compareRuntimeSemver } from './compare-runtime-semver.js';
import { projectRuntimeObservation, type RuntimeObservation } from '../runtime-detection.js';
import type { RuntimeAdapterDescriptor, RuntimeDetectResult } from '../types.js';

export {
  SUGGESTED_RUNTIME_VERSIONS_URL,
  suggestedRuntimeVersions,
  parseSuggestedRuntimeVersions,
  checkSuggestedRuntimeVersion,
  type SuggestedRuntimeVersionEntry,
  type SuggestedRuntimeVersionsManifest,
  type SuggestedRuntimeVersionAdvice,
} from './oar-suggested-versions.js';

interface RuntimeRelease {
  readonly qualifiedVersion: string;
  readonly token: (output: string) => string | undefined;
}

function managed(packageName: string, qualifiedVersion: string, token: RuntimeRelease['token']): RuntimeRelease & {
  readonly kind: 'managed'; readonly package: string;
} {
  return { kind: 'managed', package: packageName, qualifiedVersion, token };
}

const RUNTIME_RELEASES = {
  claude: managed('@anthropic-ai/claude-code', QUALIFIED_CLAUDE_VERSION, claudeVersionToken),
  codex: managed('@openai/codex', QUALIFIED_CODEX_VERSION, codexVersionToken),
  dsh: managed('@deepseek-ai/dsh', QUALIFIED_DSH_VERSION, dshVersionToken),
  opencode: managed('@opencode/cli', QUALIFIED_OPENCODE_VERSION, opencodeVersionToken),
  agy: { kind: 'vendor', qualifiedVersion: QUALIFIED_AGY_VERSION, token: agyVersionToken, command: 'agy update', reason: 'Use the Antigravity vendor installer to update the standalone CLI.' },
  grok: { kind: 'vendor', qualifiedVersion: QUALIFIED_GROK_VERSION, token: grokVersionToken, command: 'npm install -g @xai-official/grok', reason: 'The Grok installer writes to the user’s global Grok directory.' },
} as const;

export type UpgradeableRuntimeId = keyof typeof RUNTIME_RELEASES;

export function runtimeRelease(id: string): (typeof RUNTIME_RELEASES)[UpgradeableRuntimeId] | undefined {
  return Object.hasOwn(RUNTIME_RELEASES, id) ? RUNTIME_RELEASES[id as UpgradeableRuntimeId] : undefined;
}

export interface RuntimeUpgradeAdvice {
  readonly state: 'required' | 'available';
  readonly installedVersion?: string;
  readonly qualifiedVersion: string;
  readonly minimumVersion?: string;
  /** A Host SDK call for managed runtimes or the vendor's command. */
  readonly command: string;
}

/** Project local upgrade advice for the installation that detection observed. */
export function projectRuntimeObservationWithUpgrade(descriptor: RuntimeAdapterDescriptor, detected: RuntimeDetectResult): RuntimeObservation {
  const observation = projectRuntimeObservation(descriptor, detected);
  const unsupported = observation.unsupportedVersion;
  const version = detected.kind === 'available' && observation.versionVerdict?.state !== 'block' ? detected.version : unsupported?.installedVersion;
  const upgrade = runtimeUpgradeAdvice(descriptor.id, version, unsupported?.requiredVersion);
  return upgrade === undefined ? observation : { ...observation, upgrade };
}

/** Compare version direction independently of the Host version policy's verdict. */
export function runtimeUpgradeAdvice(id: string, output: string | undefined, minimumVersion?: string): RuntimeUpgradeAdvice | undefined {
  const release = runtimeRelease(id);
  if (release === undefined) return undefined;
  const installedVersion = output === undefined ? undefined : release.token(output);
  const command = release.kind === 'vendor' ? release.command : `upgradeRuntime({ installRoot, runtimeId: '${id}' })`;
  if (minimumVersion !== undefined) {
    return { state: 'required', ...(installedVersion === undefined ? {} : { installedVersion }),
      qualifiedVersion: release.qualifiedVersion, minimumVersion, command };
  }
  if (installedVersion === undefined || (compareRuntimeSemver(installedVersion, release.qualifiedVersion) ?? 0) >= 0) return undefined;
  return { state: 'available', installedVersion, qualifiedVersion: release.qualifiedVersion, command };
}
