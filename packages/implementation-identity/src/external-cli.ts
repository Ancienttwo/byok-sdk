import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  measureOfficialExternalCliRecord, parseToolImplementationIdentity,
  type ToolImplementationAuthority, type ToolImplementationAttestedV1,
  type ToolImplementationInstallRecordV1, type ToolImplementationFsProbe,
} from './identity';

export const OFFICIAL_EXTERNAL_CLI_ADAPTERS = Object.freeze([
  'claude-code', 'claude-code-writer', 'codex-exec', 'codex-exec-writer',
  'cursor-agent', 'cursor-agent-writer',
] as const);
export type OfficialExternalCliAdapter = typeof OFFICIAL_EXTERNAL_CLI_ADAPTERS[number];
export function isOfficialExternalCliAdapter(value: unknown): value is OfficialExternalCliAdapter {
  return typeof value === 'string' && (OFFICIAL_EXTERNAL_CLI_ADAPTERS as readonly string[]).includes(value);
}
/** Host verifies official release provenance and the sealed effective config scope.
 * References contain no auth-store contents. A task can never submit this declaration. */
export interface OfficialExternalCliInstallV2 {
  readonly format: 'byok.official-cli-install'; readonly version: 2;
  readonly adapter: OfficialExternalCliAdapter;
  readonly sourceProofRef: string;
  readonly configProofRef: string;
  readonly restriction: 'codex-chatgpt-terminal-v1' | 'claude-subscription-terminal-v1';
  readonly homeDir: string; readonly configDir: string;
  readonly record: ToolImplementationInstallRecordV1;
}
export interface AttestedOfficialExternalCliV2 extends Omit<OfficialExternalCliInstallV2, 'record'> {
  readonly identity: ToolImplementationAttestedV1;
  readonly directoryStats: { readonly home: ExternalCliDirectoryStat; readonly config: ExternalCliDirectoryStat };
}
export interface ExternalCliDirectoryStat { readonly dev: number; readonly ino: number; readonly mode: number; readonly uid: number; readonly gid: number }
async function directoryStat(dir: string): Promise<ExternalCliDirectoryStat | undefined> {
  try {
    if (await fs.realpath(dir) !== dir) return undefined;
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    return {dev:stat.dev,ino:stat.ino,mode:stat.mode,uid:stat.uid,gid:stat.gid};
  } catch { return undefined; }
}
export async function reverifyOfficialExternalCliDirectories(install: AttestedOfficialExternalCliV2): Promise<boolean> {
  const home = await directoryStat(install.homeDir), config = await directoryStat(install.configDir);
  return !!home && !!config && externalCliCommitment({home,config}) === externalCliCommitment(install.directoryStats);
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> => object(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const absolute = (v: unknown): v is string => typeof v === 'string' && path.isAbsolute(v)
  && path.normalize(v) === v && !/[\0\r\n]/u.test(v);
const reference = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9:/.@_-]{0,255}$/u.test(v);
function frozenJson<T>(v: T): T {
  if (v !== null && typeof v === 'object') { for (const child of Object.values(v)) frozenJson(child); Object.freeze(v); }
  return v;
}
function scope(v: Record<string, unknown>): boolean {
  return isOfficialExternalCliAdapter(v.adapter) && reference(v.sourceProofRef) && reference(v.configProofRef)
    && absolute(v.homeDir) && absolute(v.configDir)
    && (v.adapter.startsWith('codex-') ? v.restriction === 'codex-chatgpt-terminal-v1'
      : v.adapter.startsWith('claude-') && v.restriction === 'claude-subscription-terminal-v1');
}
export function externalCliCommitment(value: unknown): string {
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted)
    : object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k,sorted(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
}
export function parseAttestedOfficialExternalCli(value: unknown): AttestedOfficialExternalCliV2 | undefined {
  if (!exact(value, ['format','version','adapter','sourceProofRef','configProofRef','restriction','homeDir','configDir','identity','directoryStats'])
    || value.format !== 'byok.official-cli-install' || value.version !== 2 || !scope(value)) return undefined;
  const identity = parseToolImplementationIdentity(value.identity);
  if (!identity || identity.kind !== 'attested' || identity.launchArgv.length !== 0 || identity.entry !== undefined
    || !absolute(identity.installPath) || (identity.interpreter && (!absolute(identity.interpreter.path)
      || identity.interpreter.loadCommandsDigest !== createHash('sha256').update('[]').digest('hex')))) return undefined;
  if (!exact(value.directoryStats,['home','config']) || ![value.directoryStats.home,value.directoryStats.config].every(stat =>
    exact(stat,['dev','ino','mode','uid','gid']) && Object.values(stat).every(v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0))) return undefined;
  // An interpreted CLI requires an explicit sealed resource closure, not an npm/PATH wrapper.
  if (identity.form === 'interpreter+bundle' && (!identity.assetRoot || !identity.assets)) return undefined;
  return frozenJson(JSON.parse(JSON.stringify(value)) as AttestedOfficialExternalCliV2);
}
export async function resolveOfficialExternalCliInstall(
  authority: ToolImplementationAuthority | undefined, adapter: OfficialExternalCliAdapter,
  probe?: ToolImplementationFsProbe,
): Promise<AttestedOfficialExternalCliV2 | undefined> {
  // Windows supervision currently needs unbudgeted taskkill helpers. Keep the
  // lane closed until an owned native process-tree proof is implemented.
  if (process.platform === 'win32') return undefined;
  if (!authority) return undefined;
  let value: unknown;
  try { value = await authority.resolve({ subject: { kind: 'official-external-cli', adapter } }); }
  catch { return undefined; }
  if (!exact(value, ['format','version','adapter','sourceProofRef','configProofRef','restriction','homeDir','configDir','record'])
    || value.format !== 'byok.official-cli-install' || value.version !== 2 || value.adapter !== adapter || !scope(value)) return undefined;
  const identity = await measureOfficialExternalCliRecord(value.record, {}, probe);
  if (identity.kind !== 'attested') return undefined;
  const home = await directoryStat(value.homeDir as string), config = await directoryStat(value.configDir as string);
  if (!home || !config) return undefined;
  const { record: _record, ...declaration } = value;
  return parseAttestedOfficialExternalCli({ ...declaration, identity, directoryStats: {home,config} });
}
/** V2 terminal branch. Five Pi helper records use the same cohort version. */
export interface ExternalCliDescendantLaunchV2 {
  readonly format: 'byok.descendant-launch'; readonly version: 2;
  readonly target: 'official-external-cli';
  readonly edge: { readonly parent: 'pi-subagent-runner'; readonly child: 'official-external-cli'; readonly inheritsCredential: false };
  readonly installation: AttestedOfficialExternalCliV2;
  readonly rootTaskId: string; readonly parentRecordDigest: string; readonly policyDigest: string;
  readonly operation: string; readonly attempt: number; readonly stepIndex: number; readonly depth: number;
  readonly launchId: string; readonly invocationDigest: string;
  readonly launchEnvNamesDigest: string; readonly loaderEnvValuesDigest: string;
}
export function parseExternalCliDescendantLaunch(value: unknown): ExternalCliDescendantLaunchV2 | undefined {
  if (!exact(value, ['format','version','target','edge','installation','rootTaskId','parentRecordDigest','policyDigest','operation','attempt','stepIndex','depth','launchId','invocationDigest','launchEnvNamesDigest','loaderEnvValuesDigest'])
    || value.format !== 'byok.descendant-launch' || value.version !== 2 || value.target !== 'official-external-cli'
    || !exact(value.edge, ['parent','child','inheritsCredential']) || value.edge.parent !== 'pi-subagent-runner'
    || value.edge.child !== 'official-external-cli' || value.edge.inheritsCredential !== false
    || !parseAttestedOfficialExternalCli(value.installation)
    || ![value.rootTaskId,value.operation,value.launchId].every(v => typeof v === 'string' && v.length > 0 && !v.includes('\0'))
    || ![value.attempt,value.stepIndex,value.depth].every(v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)
    || ![value.parentRecordDigest,value.policyDigest,value.invocationDigest,value.launchEnvNamesDigest,value.loaderEnvValuesDigest].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v))) return undefined;
  return frozenJson(JSON.parse(JSON.stringify(value)) as ExternalCliDescendantLaunchV2);
}
