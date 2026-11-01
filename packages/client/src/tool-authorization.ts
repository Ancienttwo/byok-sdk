import { homedir } from 'node:os';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AgentRef } from './agent-home';

/**
 * The only product tool-authorization modes, chosen by the local Host per task
 * and shared by every runtime:
 * - `all`: every tool runs; high-risk calls produce a reminder, never a denial.
 * - `auto`: every tool runs except high-risk calls, which wait for user
 *   authorization before execution.
 * Neither mode is an OS sandbox or a file-scope boundary.
 */
export type ToolAuthorizationMode = 'auto' | 'all';
export const TOOL_AUTHORIZATION_MODES: readonly ToolAuthorizationMode[] = Object.freeze(['auto', 'all']);

/** The access one file-scope root grants. `write` implies `read`. */
export type ToolFileAccess = 'read' | 'write';
export const TOOL_FILE_ACCESS: readonly ToolFileAccess[] = Object.freeze(['read', 'write']);

/**
 * One explicit additional workspace root of a file-scope policy. `id` is for
 * local audit/display only; `path` is a local, already-existing directory the
 * Host configures, never a model or wire value.
 */
export interface ToolFileScopeRoot {
  /** Unique, nonempty local label; never emitted on the wire. */
  readonly id: string;
  /** Absolute local path; canonicalized and identity-checked at admission, not here. */
  readonly path: string;
  /** `write` implies `read`. */
  readonly access: ToolFileAccess;
}

/**
 * The optional explicit file scope of a tool-authorization policy (#1061
 * slice 1, D15). Absent means `inherit`: the current behavior is unchanged.
 * `home` authorizes read+write of the canonical Agent home; `workspaces`
 * additionally authorizes the listed roots. Only legal when the offer's
 * effective mode is `auto`.
 */
export interface ToolFileScope {
  /** `home` always grants read+write of the canonical Agent home. */
  readonly mode: 'home' | 'workspaces';
  /** Only for `workspaces`; at least one unique-id, existing absolute root. */
  readonly roots?: readonly ToolFileScopeRoot[];
}

/** The lane an offer runs in; file-scope support is per lane, not per runtime. */
export type ToolAuthorizationLane = 'rpc' | 'prepared' | 'durable';
/** A writer owns the canonical Agent home; memory-reader offers have a different cwd authority. */
export type ToolAuthorizationHomeAccess = 'writer' | 'memory-reader';

/** Local facts the Host decides on; never sourced from the wire offer or the model. */
export interface ToolAuthorizationTask {
  readonly taskId: string;
  readonly runtimeId: string;
  readonly agentRef?: AgentRef;
  /** Additive: the resolved lane, so a Host resolver can select a per-lane file scope. */
  readonly lane?: ToolAuthorizationLane;
  /** Additive: the resolved home access of this offer. */
  readonly homeAccess?: ToolAuthorizationHomeAccess;
}
export interface ToolRule {
  readonly id: string;
  /** Host display text, never interpreted as executable policy. */
  readonly description?: string;
  readonly match: {
    /** Exact, case-sensitive native tool name. */
    readonly toolName?: string;
    readonly commandGlob?: string;
    readonly pathGlob?: string;
    readonly mcpServer?: string;
    readonly mcpTool?: string;
  };
}

export interface ToolAuthorizationRules {
  readonly alwaysAsk?: readonly ToolRule[];
  readonly allowWithoutAsking?: readonly ToolRule[];
}

/**
 * The one tool-authorization policy `DaemonConfig.toolAuthorization` accepts,
 * whether it comes from a config file or an embedded Host. It is copied,
 * validated and frozen by {@link parseToolAuthorizationPolicy} at admission.
 */
export interface ToolAuthorizationPolicy {
  /** Mode for every runtime without a `byRuntime` entry. */
  readonly default: ToolAuthorizationMode;
  /** Per-runtime override, keyed by runtime id. */
  readonly byRuntime?: Readonly<Record<string, ToolAuthorizationMode>>;
  /** User-defined rules that move single calls across the ask boundary. */
  readonly rules?: ToolAuthorizationRules;
  /**
   * Optional explicit file scope (#1061, D15). Absent means `inherit` and
   * preserves the existing behavior exactly. Only legal when the offer's
   * effective mode is `auto`; an `all` runtime with a scope is rejected
   * before claim. An unsupported lane/adapter/platform is declined as
   * `file_scope_unsupported` before claim; on the admitted POSIX path every
   * root is revalidated after claim, before runtime start, and again before
   * the Pi session exists, and an unresolvable root fails the claimed task as
   * `file_scope_unavailable`. A configured scope is never silently dropped.
   * SDK-owned scoped read/write/edit/find/grep/ls tools enforce the admitted
   * roots and shadow the native Pi tools of the same name. Every other tool
   * (shell, MCP servers, SDK and user extension tools) is outside the boundary
   * and asks on every call, regardless of the built-in risk level; only an
   * explicit allowWithoutAsking rule can opt one out. It is not an OS sandbox.
   */
  readonly fileScope?: ToolFileScope;
}

/** Internal per-offer derivation; never part of the public config surface. */
export type ToolAuthorizationResolver = (task: ToolAuthorizationTask) => ToolAuthorizationPolicy;

/** The mode `policy` gives `runtimeId`: its own `byRuntime` entry, else `default`. */
export function toolAuthorizationMode(
  policy: Pick<ToolAuthorizationPolicy, 'default' | 'byRuntime'>, runtimeId: string,
): ToolAuthorizationMode {
  const { byRuntime } = policy;
  return byRuntime !== undefined && Object.hasOwn(byRuntime, runtimeId) ? byRuntime[runtimeId]! : policy.default;
}

/**
 * Derive the daemon's internal resolver from one policy. The snapshot is
 * taken now, so later edits to `policy` cannot change a decision; rules apply
 * unchanged to every runtime.
 */
export function toolAuthorizationResolver(policy: ToolAuthorizationPolicy): ToolAuthorizationResolver {
  const snapshot: ToolAuthorizationPolicy = Object.freeze({
    default: policy.default,
    ...(policy.byRuntime === undefined ? {} : { byRuntime: Object.freeze({ ...policy.byRuntime }) }),
    ...(policy.rules === undefined ? {} : { rules: policy.rules }),
    ...(policy.fileScope === undefined ? {} : { fileScope: policy.fileScope }),
  });
  return (task) => Object.freeze({
    default: toolAuthorizationMode(snapshot, task.runtimeId),
    ...(snapshot.rules === undefined ? {} : { rules: snapshot.rules }),
    ...(snapshot.fileScope === undefined ? {} : { fileScope: snapshot.fileScope }),
  });
}

export function parseToolAuthorizationMode(value: unknown): ToolAuthorizationMode {
  if (value !== 'auto' && value !== 'all') throw new TypeError('tool authorization mode must be auto or all');
  return value;
}

const MAX_TOOL_RULES = 128;
const MAX_RULE_ID_CHARS = 128;
const MAX_RULE_TEXT_CHARS = 4_096;
const MATCH_KEYS = ['toolName', 'commandGlob', 'pathGlob', 'mcpServer', 'mcpTool'] as const;
const PARSED_RULES = new WeakSet<ToolAuthorizationRules>();
const MAX_COMMAND_BYTES = 65_536;

function validateGlob(pattern: string, path: boolean): void {
  if (pattern.includes('{') || pattern.includes('[') || /[@!+*?]\(/.test(pattern)
    || [...pattern].filter(char => char === '*').length > 16) {
    throw new TypeError('tool authorization glob supports only literals, *, ** and ? with at most 16 stars');
  }
  if (!path) return;
  // One separator, checked before absoluteness so the message is the same on
  // every platform: a backslash pattern is split only on '/', so a "..\\"
  // segment would slip past the traversal check and the rule would fail open.
  if (pattern.includes('\\')) throw new TypeError('tool authorization pathGlob must use "/" separators');
  if (!isAbsolute(pattern)) throw new TypeError('tool authorization pathGlob must be absolute');
  // A resolved target never contains a traversal segment, an empty segment or
  // a trailing separator, so such a pattern could not match. Reject it at
  // admission instead of letting an alwaysAsk rule fail open.
  if (pattern.includes('//') || (pattern.length > 1 && pattern.endsWith('/'))
    || pattern.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new TypeError('tool authorization pathGlob must not contain ".", "..", "//" or a trailing separator');
  }
}

/** A bounded-state wildcard automaton: one forward scan, no expansion or backtracking. */
function matchGlob(value: string, pattern: string, path: boolean): boolean {
  const patternChars = [...pattern];
  if (!pattern.includes('*')) {
    const valueChars = [...value];
    if (valueChars.length !== patternChars.length) return false;
    for (let index = 0; index < patternChars.length; index++) {
      if (patternChars[index] === '?' ? path && valueChars[index] === '/' : patternChars[index] !== valueChars[index]) return false;
    }
    return true;
  }
  const literals = new Map<string, bigint>();
  let stars = 0n;
  let crossSegmentStars = 0n;
  let questions = 0n;
  let count = 0;
  let minimum = 0;
  for (let index = 0; index < patternChars.length; index++, count++) {
    const bit = 1n << BigInt(count);
    const char = patternChars[index]!;
    if (char === '*') {
      const begin = index;
      while (patternChars[index + 1] === '*') index++;
      stars |= bit;
      if (!path || index > begin) crossSegmentStars |= bit;
    } else {
      minimum++;
      if (char === '?') questions |= bit;
      else literals.set(char, (literals.get(char) ?? 0n) | bit);
    }
  }
  if (value.length < minimum) return false;
  // Consecutive stars have been collapsed, so each epsilon closure is one shift.
  const close = (states: bigint) => states | ((states & stars) << 1n);
  let states = close(1n);
  for (const char of value) {
    const separator = path && char === '/';
    states = close(((states & ((literals.get(char) ?? 0n) | (separator ? 0n : questions))) << 1n)
      | (states & (separator ? crossSegmentStars : stars)));
    if (states === 0n) return false;
  }
  return (states & (1n << BigInt(count))) !== 0n;
}

function policyRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))) {
    throw new TypeError(`invalid tool authorization ${label}`);
  }
  return value as Record<string, unknown>;
}

function ruleText(value: unknown, label: string, maxChars: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)
    || value.length > maxChars || value.includes('\0')) {
    throw new TypeError(`tool authorization ${label} must be ${allowEmpty ? 'a' : 'a nonempty'} string of at most ${maxChars} characters without NUL`);
  }
  return value;
}

function parseByRuntime(value: unknown): Readonly<Record<string, ToolAuthorizationMode>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError('invalid tool authorization byRuntime');
  }
  const modes: [string, ToolAuthorizationMode][] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || key.length === 0) throw new TypeError('invalid tool authorization byRuntime key');
    modes.push([key, parseToolAuthorizationMode((value as Record<string, unknown>)[key])]);
  }
  // Object.fromEntries defines own data properties, so a "__proto__" runtime
  // id cannot mutate the map's prototype.
  return Object.freeze(Object.fromEntries(modes));
}

const MAX_FILE_SCOPE_ROOTS = 32;
const MAX_FILE_SCOPE_ID_CHARS = 128;
const MAX_FILE_SCOPE_PATH_CHARS = 4_096;

/**
 * A syntactically invalid file-scope policy. It is a `TypeError` like the
 * rest of admission, and its `code` lets `checkDaemonConfig` report the
 * typed `invalid_file_scope` issue instead of a generic value error.
 */
export class FileScopePolicyError extends TypeError {
  readonly code = 'invalid_file_scope' as const;

  constructor(message: string) {
    super(message);
    this.name = 'FileScopePolicyError';
  }
}

function fileScopeRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  try {
    return policyRecord(value, keys, label);
  } catch (error) {
    throw new FileScopePolicyError(error instanceof Error ? error.message : `invalid tool authorization ${label}`);
  }
}

function fileScopeRootPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FILE_SCOPE_PATH_CHARS
    || value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new FileScopePolicyError(
      `tool authorization fileScope root path must be a nonempty single-line string of at most ${MAX_FILE_SCOPE_PATH_CHARS} characters without NUL`,
    );
  }
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    throw new FileScopePolicyError('tool authorization fileScope root path must not start with "~"; write the absolute path');
  }
  if (!isAbsolute(value)) {
    throw new FileScopePolicyError('tool authorization fileScope root path must be absolute');
  }
  if (value.split(/[\\/]/).some(segment => segment === '.' || segment === '..')) {
    throw new FileScopePolicyError('tool authorization fileScope root path must not contain "." or ".." segments');
  }
  // Pure lexical normalization; existence and identity are admission checks
  // that read the filesystem, which this parser must never do.
  return resolve(value);
}

function parseFileScope(value: unknown): ToolFileScope {
  const raw = fileScopeRecord(value, ['mode', 'roots'], 'fileScope');
  if (raw.mode !== 'home' && raw.mode !== 'workspaces') {
    throw new FileScopePolicyError('tool authorization fileScope mode must be "home" or "workspaces"');
  }
  if (raw.mode === 'home') {
    if (Object.hasOwn(raw, 'roots')) {
      throw new FileScopePolicyError('tool authorization fileScope.roots is only valid with mode "workspaces"');
    }
    return Object.freeze({ mode: 'home' });
  }
  if (!Object.hasOwn(raw, 'roots')) {
    throw new FileScopePolicyError('tool authorization fileScope with mode "workspaces" requires roots');
  }
  const entries = raw.roots;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new FileScopePolicyError('tool authorization fileScope roots must be a nonempty array');
  }
  if (entries.length > MAX_FILE_SCOPE_ROOTS) {
    throw new FileScopePolicyError(`tool authorization fileScope must contain at most ${MAX_FILE_SCOPE_ROOTS} roots`);
  }
  const ids = new Set<string>();
  // A repeated absolute path is one root, not two; write wins because it is
  // the union of the configured access and never widens beyond the file.
  const byPath = new Map<string, ToolFileScopeRoot>();
  for (const entry of entries) {
    const root = fileScopeRecord(entry, ['id', 'path', 'access'], 'fileScope root');
    let id: string;
    try {
      id = ruleText(root.id, 'fileScope root id', MAX_FILE_SCOPE_ID_CHARS);
    } catch (error) {
      throw new FileScopePolicyError(error instanceof Error ? error.message : 'invalid tool authorization fileScope root id');
    }
    if (ids.has(id)) throw new FileScopePolicyError(`duplicate tool authorization fileScope root id: ${id}`);
    ids.add(id);
    const path = fileScopeRootPath(root.path);
    if (root.access !== 'read' && root.access !== 'write') {
      throw new FileScopePolicyError('tool authorization fileScope root access must be "read" or "write"');
    }
    const existing = byPath.get(path);
    if (existing === undefined) {
      byPath.set(path, Object.freeze({ id, path, access: root.access }));
    } else if (existing.access === 'read' && root.access === 'write') {
      byPath.set(path, Object.freeze({ id: existing.id, path, access: 'write' }));
    }
  }
  return Object.freeze({ mode: 'workspaces', roots: Object.freeze([...byPath.values()]) });
}

/** The admission boundary: one copied, frozen policy for every source. */
export function parseToolAuthorizationPolicy(value: unknown): ToolAuthorizationPolicy {
  const raw = policyRecord(value, ['default', 'byRuntime', 'rules', 'fileScope'], 'policy');
  const defaultMode = parseToolAuthorizationMode(raw.default);
  const byRuntime = Object.hasOwn(raw, 'byRuntime') ? parseByRuntime(raw.byRuntime) : undefined;
  const fileScope = Object.hasOwn(raw, 'fileScope') ? parseFileScope(raw.fileScope) : undefined;
  const base = {
    default: defaultMode,
    ...(byRuntime === undefined ? {} : { byRuntime }),
    ...(fileScope === undefined ? {} : { fileScope }),
  };
  if (!Object.hasOwn(raw, 'rules')) return Object.freeze(base);
  const rawRules = policyRecord(raw.rules, ['alwaysAsk', 'allowWithoutAsking'], 'rules');
  if (PARSED_RULES.has(rawRules)) return Object.freeze({ ...base, rules: rawRules });
  const ids = new Set<string>();
  let count = 0;
  const rules: { alwaysAsk?: readonly ToolRule[]; allowWithoutAsking?: readonly ToolRule[] } = {};
  for (const list of ['alwaysAsk', 'allowWithoutAsking'] as const) {
    if (!Object.hasOwn(rawRules, list)) continue;
    const entries = rawRules[list];
    if (!Array.isArray(entries) || (count += entries.length) > MAX_TOOL_RULES) {
      throw new TypeError(`tool authorization rules must contain at most ${MAX_TOOL_RULES} rules in arrays`);
    }
    const copied: ToolRule[] = [];
    for (const entry of entries) {
      const rule = policyRecord(entry, ['id', 'description', 'match'], 'rule');
      const id = ruleText(rule.id, 'rule id', MAX_RULE_ID_CHARS);
      if (ids.has(id)) throw new TypeError(`duplicate tool authorization rule id: ${id}`);
      ids.add(id);
      const rawMatch = policyRecord(rule.match, MATCH_KEYS, 'rule match');
      if (Object.keys(rawMatch).length === 0) throw new TypeError('tool authorization rule match requires at least one selector');
      const match: { -readonly [K in keyof ToolRule['match']]: ToolRule['match'][K] } = {};
      for (const key of MATCH_KEYS) {
        if (!Object.hasOwn(rawMatch, key)) continue;
        const pattern = ruleText(rawMatch[key], key, MAX_RULE_TEXT_CHARS);
        if (key !== 'toolName') validateGlob(pattern, key === 'pathGlob');
        match[key] = pattern;
      }
      const description = Object.hasOwn(rule, 'description')
        ? ruleText(rule.description, 'rule description', MAX_RULE_TEXT_CHARS, true) : undefined;
      copied.push(Object.freeze({ id, ...(description === undefined ? {} : { description }), match: Object.freeze(match) }));
    }
    rules[list] = Object.freeze(copied);
  }
  Object.freeze(rules);
  PARSED_RULES.add(rules);
  return Object.freeze({ ...base, rules });
}

/** One native tool call, before execution. `input` is the runtime's own argument object. */
export interface ToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  /** The runtime's working directory for this call; relative paths resolve against it. */
  readonly cwd: string;
  readonly nativeAgentId?: string;
  readonly parentToolCallId?: string;
  /** Trusted admitted identity; not inferred from a native tool's spelling. */
  readonly mcp?: { readonly server: string; readonly tool: string };
}

export type ToolRiskReason =
  | 'privilege-escalation' | 'recursive-delete' | 'system-modification' | 'destructive-git'
  | 'publish-or-deploy' | 'remote-script-execution' | 'permission-broadening'
  | 'sensitive-path' | 'write-outside-workspace' | 'custom-rule' | 'outside-file-scope';
export interface ToolAuthorizationReason {
  readonly source: 'rule' | 'built-in' | 'floor';
  readonly ruleIds: readonly string[];
}
export type ToolRisk =
  | { readonly level: 'normal'; readonly authorization: ToolAuthorizationReason; readonly suppressedReasons?: readonly ToolRiskReason[] }
  | { readonly level: 'high'; readonly reasons: readonly ToolRiskReason[]; readonly authorization: ToolAuthorizationReason };

const BUILT_IN_AUTHORIZATION: ToolAuthorizationReason = Object.freeze({ source: 'built-in', ruleIds: Object.freeze([]) });
const FLOOR_AUTHORIZATION: ToolAuthorizationReason = Object.freeze({ source: 'floor', ruleIds: Object.freeze([]) });

// Lexical patterns over the command text. Indirect forms (scripts, eval,
// encoded payloads, aliases) are not recognized; this is a tool gate, not a sandbox.
const START = String.raw`(?:^|[\s;&|(\x60])`;
const COMMAND_RULES: readonly (readonly [ToolRiskReason, RegExp])[] = [
  ['privilege-escalation', new RegExp(`${START}(?:sudo|doas|su)(?:\\s|$)`)],
  ['recursive-delete', new RegExp(`${START}rm\\s+(?:[^;&|\\n]*\\s)?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\\b|\\bfind\\b[^;&|\\n]*\\s-delete\\b|${START}shred\\s`)],
  ['system-modification', new RegExp(`${START}(?:mkfs(?:\\.\\w+)?|diskutil|fdisk|parted|shutdown|reboot|halt|launchctl|systemctl|crontab)(?:\\s|$)|${START}dd\\s[^;&|\\n]*\\bof=`)],
  ['destructive-git', /\bgit\b[^;&|\n]*\s(?:push|reset\s+--hard|clean\s+-\w*f\w*|branch\s+-D|filter-branch|filter-repo)\b/],
  ['publish-or-deploy', /\b(?:npm|pnpm|yarn|bun|cargo|gem|poetry)\s+publish\b|\btwine\s+upload\b|\bgh\s+(?:release\s+create|pr\s+merge|repo\s+delete)\b|\bdocker\s+push\b|\bkubectl\s+(?:apply|delete)\b|\bterraform\s+(?:apply|destroy)\b/],
  ['remote-script-execution', /\b(?:curl|wget)\b[^;\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python3?|node)\b/],
  ['permission-broadening', /\bchmod\s+(?:-R\b|(?:\S+\s+)?[0-7]?777\b)|\bchown\s+-R\b/],
];

/** Home-relative credential stores and login persistence points. */
export const SENSITIVE_HOME_PATHS: readonly string[] = Object.freeze([
  '.ssh', '.aws', '.gnupg', '.kube', '.docker/config.json', '.config/gh', '.netrc', '.git-credentials', '.npmrc',
  '.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile', 'Library/Keychains', 'Library/LaunchAgents', '.config/autostart',
]);
const MUTATING_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit', 'apply_patch']);
const MUTATING_FILE_CHANGE_KINDS = new Set(['add', 'update', 'delete']);
const PATH_KEYS = ['path', 'file_path', 'filePath', 'notebook_path'] as const;

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
function commandText(input: Readonly<Record<string, unknown>>): string | undefined {
  const value = input.command ?? input.cmd;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(part => typeof part === 'string')) return value.join(' ');
  return undefined;
}

function normalizedPath(value: string, platform: NodeJS.Platform): string {
  let normalized = value;
  if (platform === 'win32') normalized = normalized.replaceAll('\\', '/');
  if (platform === 'darwin' || platform === 'win32') normalized = normalized.toLowerCase();
  if (platform === 'darwin' && (normalized === '/system/volumes/data' || normalized.startsWith('/system/volumes/data/'))) {
    normalized = normalized.slice('/system/volumes/data'.length) || '/';
  }
  return normalized;
}

function withinNormalized(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/** Missing leaf components may be new writes; other resolution failures remain unknown. */
function nearestRealPath(target: string): string | undefined {
  let ancestor = target;
  const missing: string[] = [];
  while (true) {
    try { return join(realpathSync(ancestor), ...missing.reverse()); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
      // A dangling symlink is an existing but unresolved authority, not a new leaf.
      try { lstatSync(ancestor); return undefined; } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) return undefined;
      missing.push(basename(ancestor));
      ancestor = parent;
    }
  }
}

/**
 * The single classifier for both modes. Protected-path identity also follows
 * the nearest existing ancestor; uncertainty cannot activate an allow rule.
 * `workspace` is the daemon's grant, not the runtime-reported cwd.
 */
export function classifyToolCall(
  call: Pick<ToolCall, 'toolName' | 'input' | 'cwd' | 'mcp'>, workspace: string, home: string = homedir(),
  rules?: ToolAuthorizationRules,
  context: { readonly platform?: NodeJS.Platform } = {},
): ToolRisk {
  const policy = parseToolAuthorizationPolicy({ default: 'auto', ...(rules === undefined ? {} : { rules }) });
  rules = policy.rules;
  const platform = context.platform ?? process.platform;
  const reasons = new Set<ToolRiskReason>();
  const command = commandText(call.input);
  const oversizedCommand = command !== undefined && Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES;
  const simpleCommand = command === undefined || (!oversizedCommand && !/[;&|<>\n\r`]|\$[({]/.test(command));
  let floorCertain = true;
  const lexicalHome = resolve(home);
  let physicalHome: string | undefined;
  try { physicalHome = realpathSync(lexicalHome); } catch { /* Unknown home identity cannot grant allow. */ }
  if (physicalHome === undefined) floorCertain = false;
  const homes = [...new Set([lexicalHome, physicalHome].filter((value): value is string => value !== undefined))];
  const protectedRoots = homes.flatMap(base => SENSITIVE_HOME_PATHS.flatMap(path => {
    const lexical = resolve(base, path);
    const physical = nearestRealPath(lexical);
    if (physical === undefined) floorCertain = false;
    return [normalizedPath(lexical, platform), ...(physical === undefined ? [] : [normalizedPath(physical, platform)])];
  }));
  const isProtected = (target: string) => protectedRoots.some(root => withinNormalized(root, normalizedPath(target, platform)));
  if (command !== undefined) {
    for (const [reason, pattern] of COMMAND_RULES) if (pattern.test(command)) reasons.add(reason);
    const homeForms = ['~/', '$HOME/', '${HOME}/', ...homes.map(base => `${base}/`)];
    const foldedCommand = normalizedPath(command, platform);
    if (SENSITIVE_HOME_PATHS.some(path => homeForms.some(prefix => foldedCommand.includes(normalizedPath(`${prefix}${path}`, platform))))) reasons.add('sensitive-path');
  }
  // Codex projects one native file operation as a batch, including move destinations.
  // Normalize here so auto decisions and all-mode reminders share the same path checks.
  const paths = PATH_KEYS.map(key => ({ path: call.input[key], mutating: MUTATING_TOOLS.has(call.toolName.toLowerCase()) }));
  if (call.toolName === 'file_change' && Array.isArray(call.input.changes)) {
    for (const change of call.input.changes) {
      if (change === null || typeof change !== 'object' || Array.isArray(change)) continue;
      const mutating = MUTATING_FILE_CHANGE_KINDS.has(change.kind);
      paths.push({ path: change.path, mutating }, { path: change.movePath, mutating });
    }
  }
  const targets: string[] = [];
  const physicalTargets: string[] = [];
  for (const { path: raw, mutating } of paths) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const expanded = raw === '~' ? home : raw.startsWith('~/') ? `${home}${raw.slice(1)}` : raw;
    const target = resolve(call.cwd, expanded);
    targets.push(target);
    const physicalTarget = nearestRealPath(target);
    if (physicalTarget !== undefined) physicalTargets.push(physicalTarget);
    if (physicalTarget === undefined) floorCertain = false;
    if (isProtected(target) || (physicalTarget !== undefined && isProtected(physicalTarget))) reasons.add('sensitive-path');
    if (mutating && !within(workspace, target)) reasons.add('write-outside-workspace');
  }

  const matchingIds = (entries: readonly ToolRule[] | undefined, allow: boolean): readonly string[] => {
    const ids: string[] = [];
    for (const { id, match } of entries ?? []) {
      if (!MATCH_KEYS.some(key => match[key] !== undefined)) continue;
      if (allow && (!simpleCommand || !floorCertain)) continue;
      if (match.toolName !== undefined && match.toolName !== call.toolName) continue;
      if (match.commandGlob !== undefined && (command === undefined || (!oversizedCommand && !matchGlob(command, match.commandGlob, false)))) continue;
      if (match.mcpServer !== undefined && (call.mcp === undefined || !matchGlob(call.mcp.server, match.mcpServer, false))) continue;
      if (match.mcpTool !== undefined && (call.mcp === undefined || !matchGlob(call.mcp.tool, match.mcpTool, false))) continue;
      if (match.pathGlob !== undefined) {
        const pattern = normalizedPath(match.pathGlob, platform);
        const matches = (target: string) => matchGlob(normalizedPath(target, platform), pattern, true);
        // An ask also matches the real path (`/tmp` vs `/private/tmp`, a
        // symlink into a protected directory), which can only add asks. An
        // allow stays lexical: a resolved alias never widens what it grants.
        if (targets.length === 0 || !(allow
          ? targets.every(matches)
          : targets.some(matches) || physicalTargets.some(matches))) continue;
      }
      ids.push(id);
    }
    return Object.freeze(ids);
  };
  const askIds = matchingIds(rules?.alwaysAsk, false);
  if (askIds.length > 0) {
    reasons.add('custom-rule');
    return { level: 'high', reasons: Object.freeze([...reasons]),
      authorization: Object.freeze({ source: 'rule', ruleIds: askIds }) };
  }
  if (reasons.has('sensitive-path')) {
    return { level: 'high', reasons: Object.freeze([...reasons]), authorization: FLOOR_AUTHORIZATION };
  }
  const allowIds = matchingIds(rules?.allowWithoutAsking, true);
  if (allowIds.length > 0) return { level: 'normal', authorization: Object.freeze({ source: 'rule', ruleIds: allowIds }),
    ...(reasons.size === 0 ? {} : { suppressedReasons: Object.freeze([...reasons]) }) };
  return reasons.size === 0 ? { level: 'normal', authorization: BUILT_IN_AUTHORIZATION }
    : { level: 'high', reasons: Object.freeze([...reasons]), authorization: BUILT_IN_AUTHORIZATION };
}

export type ToolAuthorizationDenialCode = 'tool_authorization_denied' | 'tool_authorization_unavailable';
export type ToolAuthorizationVerdict =
  | { readonly decision: 'allow'; readonly authorization?: ToolAuthorizationReason }
  | { readonly decision: 'deny'; readonly code: ToolAuthorizationDenialCode; readonly reason: string; readonly authorization?: ToolAuthorizationReason };

/** Local audit projection; raw tool arguments and rule descriptions stay private. */
export interface ToolAuthorizationDecision {
  readonly taskId: string;
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly decision: 'allow' | 'deny';
  readonly authorization: ToolAuthorizationReason;
  readonly reasons: readonly ToolRiskReason[];
  readonly suppressedReasons?: readonly ToolRiskReason[];
  readonly code?: ToolAuthorizationDenialCode;
}

/**
 * The `auto` gate a daemon hands to an adapter that declares
 * `toolAuthorizationAuto`. The adapter calls it for every native tool call
 * before execution; it never throws.
 */
export interface ToolAuthorizationGate {
  /**
   * Wall-clock bound on one decision, measured from the `authorize` call and
   * covering any wait behind earlier approvals. An adapter's native hook
   * deadline must exceed it.
   */
  readonly timeoutMs: number;
  /** The adapter may supply its trusted runtime observation, never identity from tool arguments. */
  authorize(call: ToolCall, resolveMcpIdentity?: () => Promise<{ readonly server: string; readonly tool: string } | undefined>): Promise<ToolAuthorizationVerdict>;
}

/**
 * Internal brand of a gate whose task has an admitted file scope. The binding
 * module (`file-scope-gate-binding`) writes the three in-scope SDK tool names
 * onto this gate's `authorize` function under the same global symbol. A brand
 * rather than an import keeps this module dependency-free: its classifier runs
 * in an isolated-process probe that only resolves extensionless imports
 * through a bundler, and the brand carries the one list both sides need.
 */
const FILE_SCOPE_GATE_MARKER = Symbol.for('byok.tool-authorization.file-scope-tools');

function scopedFileToolNames(gate: ToolAuthorizationGate): readonly string[] | undefined {
  const value = (gate.authorize as unknown as Record<symbol, unknown>)[FILE_SCOPE_GATE_MARKER];
  return Array.isArray(value) ? value as readonly string[] : undefined;
}

const MAX_SUMMARY_CHARS = 1_000;
export function describeHighRiskToolCall(
  call: Pick<ToolCall, 'toolName' | 'input' | 'mcp'>, reasons: readonly ToolRiskReason[], authorization?: ToolAuthorizationReason,
): string {
  const subject = commandText(call.input)
    ?? PATH_KEYS.map(key => call.input[key]).find((value): value is string => typeof value === 'string')
    ?? '';
  // A human decides on this card, so it names the concrete identity: the
  // shell command/path when the call has one, and the trusted MCP server/tool
  // when the runtime label is an MCP tool.
  const identity = call.mcp === undefined ? '' : ` [mcp ${call.mcp.server}/${call.mcp.tool}]`;
  const label = reasons.includes('outside-file-scope') ? 'Tool call outside the file scope'
    : authorization?.source === 'rule' ? `Tool authorization rule (${authorization.ruleIds.join(', ')})`
      : authorization?.source === 'floor' ? 'Protected-path tool call' : 'High-risk tool call';
  const summary = `${label} (${reasons.join(', ')}): ${call.toolName}${identity}${subject ? ` ${subject}` : ''}`;
  return summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS - 1)}…` : summary;
}

export function createAutoToolAuthorizationGate(input: {
  readonly workspace: string;
  readonly home?: string;
  readonly platform?: NodeJS.Platform;
  readonly timeoutMs: number;
  readonly rules?: ToolAuthorizationRules;
  readonly mcpIdentities?: ReadonlyMap<string, { readonly server: string; readonly tool: string }>;
  /** Called for every classified decision and for a denial that happened before classification. */
  readonly onDecision?: (decision: { readonly call: ToolCall; readonly risk?: ToolRisk; readonly verdict: ToolAuthorizationVerdict }) => void;
  /** Aborting `signal` must withdraw the request so a later decision cannot revive it. */
  readonly requestAuthorization: (summary: string, signal: AbortSignal) => Promise<{ approved: boolean; reason?: string }>;
}): ToolAuthorizationGate {
  const rules = parseToolAuthorizationPolicy({ default: 'auto', ...(input.rules === undefined ? {} : { rules: input.rules }) }).rules;
  const needsMcpIdentity = [...(rules?.alwaysAsk ?? []), ...(rules?.allowWithoutAsking ?? [])]
    .some(rule => rule.match.mcpServer !== undefined || rule.match.mcpTool !== undefined);
  // The reference is only used inside `authorize`, after the daemon has bound
  // (or not bound) this attempt's file-scope grant; it is never called before
  // the object exists.
  const gate: ToolAuthorizationGate = {
    timeoutMs: input.timeoutMs,
    async authorize(rawCall: ToolCall, resolveMcpIdentity?: () => Promise<{ readonly server: string; readonly tool: string } | undefined>): Promise<ToolAuthorizationVerdict> {
      let call = rawCall;
      const withdraw = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<'expired'>(resolve => { timer = setTimeout(() => resolve('expired'), input.timeoutMs); });
      let risk: ToolRisk | undefined;
      const finish = (verdict: ToolAuthorizationVerdict): ToolAuthorizationVerdict => {
        const classifiedVerdict = risk === undefined ? verdict : { ...verdict, authorization: risk.authorization };
        // A denial before classification (missing/timed-out MCP identity, gate
        // exception) still gets an audit record; it has no risk to project.
        if (risk !== undefined || verdict.decision === 'deny') {
          try {
            input.onDecision?.({ call, ...(risk === undefined ? {} : { risk }), verdict: classifiedVerdict });
          } catch { /* Observers do not own authorization. */ }
        }
        return classifiedVerdict;
      };
      try {
        // A runtime label is not an MCP authority. Only an exact admitted mapping
        // may attach identity to a gate request, even if the request supplies one.
        const { mcp: _untrustedMcp, ...nativeCall } = rawCall;
        const mcp = resolveMcpIdentity === undefined ? input.mcpIdentities?.get(rawCall.toolName)
          : await Promise.race([resolveMcpIdentity(), expired]);
        if (mcp === 'expired') {
          withdraw.abort();
          return finish({ decision: 'deny', code: 'tool_authorization_unavailable', reason: `tool authorization timed out after ${input.timeoutMs}ms` });
        }
        if (needsMcpIdentity && rawCall.toolName.startsWith('mcp__') && mcp === undefined) {
          return finish({ decision: 'deny', code: 'tool_authorization_unavailable', reason: 'trusted MCP tool identity is unavailable' });
        }
        call = { ...nativeCall, ...(mcp === undefined ? {} : { mcp }) };
        risk = classifyToolCall(call, input.workspace, input.home, rules, { platform: input.platform });
        // #1061: in a file-scoped session every tool outside the SDK file
        // boundary asks on every call. Risk heuristics cannot auto-allow it;
        // only an explicit allowWithoutAsking rule can, because that is the
        // Host deliberately naming the tool/command it trusts. The six SDK
        // file tools are inside the boundary and are guarded by the scoped
        // tool itself.
        const scopedTools = scopedFileToolNames(gate);
        if (scopedTools !== undefined && risk.level === 'normal'
          && risk.authorization.source !== 'rule' && !scopedTools.includes(call.toolName)) {
          risk = { level: 'high', reasons: Object.freeze(['outside-file-scope']), authorization: FLOOR_AUTHORIZATION };
        }
        if (risk.level === 'normal') return finish({ decision: 'allow' });
        const result = await Promise.race([input.requestAuthorization(describeHighRiskToolCall(call, risk.reasons, risk.authorization), withdraw.signal), expired]);
        if (result === 'expired') {
          withdraw.abort();
          return finish({ decision: 'deny', code: 'tool_authorization_unavailable', reason: `tool authorization timed out after ${input.timeoutMs}ms` });
        }
        if (result.approved === true) return finish({ decision: 'allow' });
        return finish({ decision: 'deny', code: 'tool_authorization_denied', reason: result.reason
          ?? (risk.reasons.includes('outside-file-scope') ? 'user did not authorize this tool call outside the file scope'
            : risk.authorization.source === 'rule' ? 'user did not authorize this tool call'
              : 'user did not authorize this high-risk tool call') });
      } catch {
        withdraw.abort();
        return finish({ decision: 'deny', code: 'tool_authorization_unavailable', reason: 'tool authorization is unavailable' });
      } finally {
        clearTimeout(timer);
      }
    },
  };
  return Object.freeze(gate);
}

export function formatToolAuthorizationDenial(verdict: Extract<ToolAuthorizationVerdict, { decision: 'deny' }>): string {
  return `${verdict.code}: ${verdict.reason}`;
}

/** An `all`-mode notice for one high-risk call the runtime reported; the call was not blocked. */
export interface ToolReminder {
  readonly taskId: string;
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly reasons: readonly ToolRiskReason[];
  readonly summary: string;
  readonly authorization: ToolAuthorizationReason;
  readonly suppressedReasons?: readonly ToolRiskReason[];
}
