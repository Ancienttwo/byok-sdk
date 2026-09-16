import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseImplementationSpawnBinding, type ImplementationSpawnBindingV1 } from './spawn-binding';
import {
  DESCENDANT_PER_LAUNCH_ENV_NAMES, RUNTIME_DESCENDANT_EDGES, RUNTIME_ENTRIES,
  toolImplementationLaunchEnvNamesDigest, toolImplementationLoaderEnvValuesDigest,
  unexpectedLaunchEnvControlNames, parseRuntimeDescendantPolicy, type RuntimeDescendantPolicyV1, type RuntimeDescendantEdgeV1, type RuntimeEntryV1,
} from './identity';
import { CONTROLLED_PI_DIRECTORY_ENV_NAMES, PROVIDER_CREDENTIAL_ENV_DENY_NAMES, loaderEnvInjections } from './environment';

export interface DescendantLimitsV1 {
  readonly maxDepth: number; readonly fanout: number; readonly parallel: number; readonly sessionCap: number;
}
export interface DescendantContextV1 {
  readonly format: 'byok.runtime-descendant-context'; readonly version: 1;
  readonly templateKind: RuntimeEntryV1;
  readonly edge: { readonly parent: RuntimeEntryV1; readonly child: RuntimeEntryV1 };
  readonly rootTaskId: string; readonly parentInstancePath: readonly number[]; readonly instancePath: readonly number[];
  readonly depth: number; readonly remainingDepth: number; readonly effectiveLimits: DescendantLimitsV1;
  readonly task: string; readonly modelCandidates: readonly { readonly provider: string; readonly model: string }[]; readonly attempt: number;
  readonly session: { readonly cwd: string; readonly root: string; readonly file: string | null };
  /** Metadata retains its owning MCP parser; this layer validates the envelope and env, not MCP semantics. */
  readonly mcp: { readonly env: Readonly<Record<string, string>>; readonly metadata: Readonly<Record<string, unknown>> };
  readonly exactNames: readonly string[]; readonly envValues: Readonly<Record<string, string | null>>;
  readonly controlledDirValues: Readonly<Record<string, string>>;
}
export interface DescendantLaunchV1 {
  readonly format: 'byok.descendant-launch'; readonly version: 1;
  readonly template: ImplementationSpawnBindingV1; readonly templateDigest: string;
  readonly policy: RuntimeDescendantPolicyV1; readonly perLaunch: DescendantContextV1;
}
/** Independently selected from the verified parent, never reconstructed from the submitted child config. */
export interface DescendantSpawnExpectationV1 {
  readonly template: ImplementationSpawnBindingV1; readonly policy: RuntimeDescendantPolicyV1;
  readonly edges: readonly RuntimeDescendantEdgeV1[];
  readonly parent: { readonly kind: RuntimeEntryV1; readonly rootTaskId: string; readonly instancePath: readonly number[];
    readonly depth: number; readonly effectiveLimits: DescendantLimitsV1 };
  readonly inheritedCredentialNames: readonly string[];
}
export interface DescendantSpawnActualV1 {
  readonly command: string; readonly entry?: string; readonly fixedArgv: readonly string[];
  readonly cwd: string; readonly env: Readonly<Record<string, string>>;
}
export class DescendantLaunchError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'DescendantLaunchError'; }
}
function fail(reason: string): never { throw new DescendantLaunchError(reason); }
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> => object(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const uint = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && !Object.is(v, -0);
const absolute = (v: unknown): v is string => typeof v === 'string' && path.isAbsolute(v) && path.normalize(v) === v && !/[\u0000\r\n]/u.test(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && !v.includes('\0');
const pathArray = (v: unknown): v is readonly number[] => Array.isArray(v) && Array.from(v).every(uint);
const names = (v: unknown): v is readonly string[] => Array.isArray(v) && Array.from(v).every((n, i) => nonempty(n) && (i === 0 || v[i - 1] < n));
const stringMap = (v: unknown): v is Record<string, string> => object(v) && Object.values(v).every(x => typeof x === 'string' && !x.includes('\0'));
const kind = (v: unknown): v is RuntimeEntryV1 => typeof v === 'string' && (RUNTIME_ENTRIES as readonly string[]).includes(v);
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function sameMap(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): boolean {
  const keys = Object.keys(a).sort(); return equal(keys, Object.keys(b).sort()) && keys.every(k => equal(a[k], b[k]));
}
function limits(v: unknown): v is DescendantLimitsV1 {
  return exact(v, ['maxDepth','fanout','parallel','sessionCap']) && uint(v.maxDepth)
    && [v.fanout,v.parallel,v.sessionCap].every(x => uint(x) && x > 0);
}
/** Hash original JSON member order, before the V1 parser projects its output. */
export function descendantTemplateDigest(template: ImplementationSpawnBindingV1): string {
  return createHash('sha256').update(JSON.stringify(template), 'utf8').digest('hex');
}
function jsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if ((!Array.isArray(value) && !object(value)) || seen.has(value)) return false;
  seen.add(value);
  const valid = (Array.isArray(value) ? Array.from(value) : Object.values(value)).every(v => jsonValue(v, seen));
  seen.delete(value);
  return valid;
}
function frozenJson<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const v of Object.values(value)) frozenJson(v); Object.freeze(value); }
  return value;
}
/** Strict owned shape only. Independent parent and final-env comparisons are mandatory in assertDescendantSpawn. */
export function parseDescendantLaunch(value: unknown): DescendantLaunchV1 {
  if (!exact(value, ['format','version','template','templateDigest','policy','perLaunch']) || value.format !== 'byok.descendant-launch' || value.version !== 1) fail('descendant_invalid_shape');
  const template = parseImplementationSpawnBinding(value.template);
  if (!template || template.identity.kind !== 'attested') fail('descendant_invalid_template');
  if (typeof value.templateDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(value.templateDigest)
    || descendantTemplateDigest(value.template as ImplementationSpawnBindingV1) !== value.templateDigest) fail('descendant_template_digest_mismatch');
  if (!parseRuntimeDescendantPolicy(value.policy)) fail('descendant_policy_field_required');
  const c = value.perLaunch;
  const contextKeys = ['format','version','templateKind','edge','rootTaskId','parentInstancePath','instancePath','depth','remainingDepth','effectiveLimits','task','modelCandidates','attempt','session','mcp','exactNames','envValues','controlledDirValues'];
  if (object(c) && Object.keys(c).some(k => !contextKeys.includes(k))) fail('descendant_context_unknown_key');
  if (!exact(c, contextKeys)
    || c.format !== 'byok.runtime-descendant-context' || c.version !== 1 || !kind(c.templateKind)
    || !exact(c.edge,['parent','child']) || !kind(c.edge.parent) || !kind(c.edge.child) || c.edge.child !== c.templateKind
    || template.fixedArgv.at(-1) !== c.templateKind || !nonempty(c.rootTaskId)
    || !pathArray(c.parentInstancePath) || !pathArray(c.instancePath) || c.instancePath.length === 0
    || !uint(c.depth) || !uint(c.remainingDepth) || !limits(c.effectiveLimits) || typeof c.task !== 'string'
    || !Array.isArray(c.modelCandidates) || c.modelCandidates.length === 0
    || !Array.from(c.modelCandidates).every(m => exact(m,['provider','model']) && nonempty(m.provider) && nonempty(m.model))
    || !uint(c.attempt)
    || !exact(c.session,['cwd','root','file']) || !absolute(c.session.cwd) || !absolute(c.session.root)
    || !(c.session.file === null || absolute(c.session.file))
    || !exact(c.mcp,['env','metadata']) || !stringMap(c.mcp.env) || !object(c.mcp.metadata) || !jsonValue(c.mcp.metadata)
    || !names(c.exactNames) || !object(c.envValues) || !stringMap(c.controlledDirValues)) fail('descendant_invalid_context');
  if (c.attempt >= c.modelCandidates.length) fail('descendant_model_attempt_invalid');
  for (const [name,value] of Object.entries(c.envValues)) {
    if ((PROVIDER_CREDENTIAL_ENV_DENY_NAMES as readonly string[]).includes(name.toUpperCase())) fail('descendant_credential_in_config');
    if (!(DESCENDANT_PER_LAUNCH_ENV_NAMES as readonly string[]).includes(name)) fail('descendant_env_name_unknown');
    if (!(value === null || (typeof value === 'string' && !value.includes('\0')))) fail('descendant_invalid_context');
  }
  if (Object.entries(c.controlledDirValues).some(([n,v]) => !(CONTROLLED_PI_DIRECTORY_ENV_NAMES as readonly string[]).includes(n) || !absolute(v))) fail('descendant_controlled_directory_mismatch');
  if (Object.keys(c.mcp.env).some(n => (PROVIDER_CREDENTIAL_ENV_DENY_NAMES as readonly string[]).includes(n.toUpperCase()))) fail('mcp_credential_env_forbidden');
  if (Object.keys(c.mcp.env).some(n => (CONTROLLED_PI_DIRECTORY_ENV_NAMES as readonly string[]).includes(n.toUpperCase())) || loaderEnvInjections(c.mcp.env).length > 0) fail('descendant_mcp_env_forbidden');
  // Keep original template key order: parsing must not silently change its checksum preimage.
  return frozenJson(JSON.parse(JSON.stringify(value)) as DescendantLaunchV1);
}

/** Necessary launch consistency, not an atomic budget claim or permission to enable recursive execution. */
export function validateDescendantSpawn(
  input: unknown, expected: DescendantSpawnExpectationV1, actual: DescendantSpawnActualV1,
): DescendantLaunchV1 {
  if (loaderEnvInjections(actual.env).length > 0 || unexpectedLaunchEnvControlNames(actual.env).length > 0) fail('descendant_loader_env_forbidden');
  const launch = parseDescendantLaunch(input), c = launch.perLaunch, t = launch.template;
  if (!equal(launch.policy, expected.policy)) fail('descendant_policy_changed');
  if (descendantTemplateDigest(expected.template) !== launch.templateDigest || !equal(t, expected.template)) fail('descendant_template_changed');
  if (!sameMap(c.controlledDirValues, t.envCommitments)
    || CONTROLLED_PI_DIRECTORY_ENV_NAMES.some(n => actual.env[n] !== t.envCommitments[n])) fail('descendant_controlled_directory_mismatch');
  for (const key of ['maxDepth','fanout','parallel','sessionCap'] as const) {
    if (c.effectiveLimits[key] > launch.policy[key]) fail('descendant_limit_exceeded');
    if (c.effectiveLimits[key] > expected.parent.effectiveLimits[key]) fail('descendant_parent_limit_exceeded');
  }
  const edge = expected.edges.find(e => e.parent === c.edge.parent && e.child === c.edge.child && e.inheritsCredential === true);
  if (!edge || !RUNTIME_DESCENDANT_EDGES.some(e => e.parent === edge.parent && e.child === edge.child)
    || c.edge.parent !== expected.parent.kind || c.rootTaskId !== expected.parent.rootTaskId
    || !equal(c.parentInstancePath, expected.parent.instancePath)) fail('descendant_parent_transition_mismatch');
  const bootstrap = c.edge.parent === 'pi-subagent-runner' && c.edge.child === 'pi-subagent-print';
  // Check the independently verified parent's remaining charge before judging
  // the candidate declaration. The zero-charge runner bootstrap is legal at cap.
  if (!bootstrap && expected.parent.depth >= c.effectiveLimits.maxDepth) fail('descendant_depth_exhausted');
  if (c.depth > launch.policy.maxDepth || c.depth > c.effectiveLimits.maxDepth) fail('descendant_depth_exceeded');
  const expectedDepth = expected.parent.depth + (bootstrap ? 0 : 1);
  if (!Number.isSafeInteger(expectedDepth) || c.depth !== expectedDepth
    || (bootstrap ? !equal(c.instancePath, expected.parent.instancePath)
      : c.instancePath.length !== expected.parent.instancePath.length + 1 || !expected.parent.instancePath.every((v,i) => c.instancePath[i] === v))) fail('descendant_parent_transition_mismatch');
  if (c.remainingDepth !== c.effectiveLimits.maxDepth - c.depth) fail('descendant_depth_mismatch');
  for (const [name,value] of [['PI_SUBAGENT_DEPTH',c.depth],['PI_SUBAGENT_MAX_DEPTH',c.effectiveLimits.maxDepth]] as const) {
    const supplied = c.envValues[name];
    if (supplied !== undefined && supplied !== null && supplied !== String(value)) fail('descendant_depth_projection_mismatch');
  }
  if (c.session.root !== t.envCommitments.PI_CODING_AGENT_SESSION_DIR) fail('descendant_session_root_mismatch');
  if (c.session.file !== null) {
    const relative = path.relative(c.session.root, c.session.file);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('descendant_session_path_outside_root');
  }
  if (c.exactNames.some(n => !launch.policy.envNameAllowlist.includes(n))) fail('descendant_env_name_not_allowed');
  if (toolImplementationLaunchEnvNamesDigest(Object.fromEntries(c.exactNames.map(n => [n,'']))) !== toolImplementationLaunchEnvNamesDigest(actual.env)) fail('descendant_exact_env_names_mismatch');
  for (const [name,value] of Object.entries(c.envValues)) {
    if ((value === null ? undefined : value) !== actual.env[name]) fail('descendant_per_launch_env_mismatch');
  }
  for (const name of DESCENDANT_PER_LAUNCH_ENV_NAMES) {
    if (actual.env[name] !== undefined && !Object.hasOwn(c.envValues, name)) fail('descendant_per_launch_env_mismatch');
  }
  const credentials = Object.keys(actual.env).filter(n => (PROVIDER_CREDENTIAL_ENV_DENY_NAMES as readonly string[]).includes(n.toUpperCase())).sort();
  if (!equal(credentials, [...expected.inheritedCredentialNames].sort())) fail('descendant_credential_custody_mismatch');
  if (t.identity.kind !== 'attested' || toolImplementationLoaderEnvValuesDigest(actual.env) !== t.identity.loaderEnvValuesDigest) fail('descendant_loader_env_drift');
  if (actual.command !== t.command || actual.entry !== t.entry || actual.cwd !== t.cwd || !equal(actual.fixedArgv,t.fixedArgv)) fail('descendant_invocation_mismatch');
  return launch;
}
