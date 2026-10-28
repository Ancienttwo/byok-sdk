import { homedir } from 'node:os';
import { isAbsolute, matchesGlob, relative, resolve, sep } from 'node:path';
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

/** Local facts the Host decides on; never sourced from the wire offer or the model. */
export interface ToolAuthorizationTask {
  readonly taskId: string;
  readonly runtimeId: string;
  readonly agentRef?: AgentRef;
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

export interface ToolAuthorizationPolicy {
  readonly mode: ToolAuthorizationMode;
  readonly rules?: ToolAuthorizationRules;
}

export type ToolAuthorizationResolver = (task: ToolAuthorizationTask) => ToolAuthorizationMode | ToolAuthorizationPolicy;

/**
 * A tool-authorization policy that a config file can express (#1094):
 * `byRuntime` sets the mode of a runtime by its id, and `default` applies to
 * every other runtime.
 */
export interface StaticToolAuthorization {
  readonly default: ToolAuthorizationMode;
  readonly byRuntime?: Readonly<Record<string, ToolAuthorizationMode>>;
}

/** The mode `policy` gives `runtimeId`: its own `byRuntime` entry, else `default`. */
export function staticToolAuthorizationMode(policy: StaticToolAuthorization, runtimeId: string): ToolAuthorizationMode {
  const { byRuntime } = policy;
  return byRuntime !== undefined && Object.hasOwn(byRuntime, runtimeId) ? byRuntime[runtimeId]! : policy.default;
}

/** The resolver of a static policy, over a copy taken now so later edits to `policy` cannot change it. */
export function staticToolAuthorizationResolver(policy: StaticToolAuthorization): ToolAuthorizationResolver {
  const snapshot: StaticToolAuthorization = Object.freeze({
    default: policy.default,
    ...(policy.byRuntime === undefined ? {} : { byRuntime: Object.freeze({ ...policy.byRuntime }) }),
  });
  return (task) => staticToolAuthorizationMode(snapshot, task.runtimeId);
}

export function parseToolAuthorizationMode(value: unknown): ToolAuthorizationMode {
  if (value !== 'auto' && value !== 'all') throw new TypeError('tool authorization mode must be auto or all');
  return value;
}

const MAX_TOOL_RULES = 128;
const MAX_RULE_ID_CHARS = 128;
const MAX_RULE_TEXT_CHARS = 4_096;
const MATCH_KEYS = ['toolName', 'commandGlob', 'pathGlob', 'mcpServer', 'mcpTool'] as const;

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

/** The admission boundary: one copied, frozen policy for either public input form. */
export function parseToolAuthorizationPolicy(value: unknown): ToolAuthorizationPolicy {
  if (typeof value === 'string') return Object.freeze({ mode: parseToolAuthorizationMode(value) });
  const raw = policyRecord(value, ['mode', 'rules'], 'policy');
  const mode = parseToolAuthorizationMode(raw.mode);
  if (!Object.hasOwn(raw, 'rules')) return Object.freeze({ mode });
  const rawRules = policyRecord(raw.rules, ['alwaysAsk', 'allowWithoutAsking'], 'rules');
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
        // Node owns the glob language; do not accept a pattern it cannot evaluate.
        if (key !== 'toolName') matchesGlob('', pattern);
        match[key] = pattern;
      }
      const description = Object.hasOwn(rule, 'description')
        ? ruleText(rule.description, 'rule description', MAX_RULE_TEXT_CHARS, true) : undefined;
      copied.push(Object.freeze({ id, ...(description === undefined ? {} : { description }), match: Object.freeze(match) }));
    }
    rules[list] = Object.freeze(copied);
  }
  return Object.freeze({ mode, rules: Object.freeze(rules) });
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
  | 'sensitive-path' | 'write-outside-workspace' | 'custom-rule';
export interface ToolAuthorizationReason {
  readonly source: 'rule' | 'built-in' | 'floor';
  readonly ruleIds: readonly string[];
}
export type ToolRisk =
  | { readonly level: 'normal'; readonly authorization: ToolAuthorizationReason }
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

/**
 * The single high-risk classifier for both modes. Paths resolve lexically
 * (`~` expands to `home`); symlinks are not followed. `workspace` is the task
 * cwd the daemon granted, not the runtime-reported cwd.
 */
export function classifyToolCall(
  call: Pick<ToolCall, 'toolName' | 'input' | 'cwd' | 'mcp'>, workspace: string, home: string = homedir(),
  rules?: ToolAuthorizationRules,
): ToolRisk {
  const reasons = new Set<ToolRiskReason>();
  const command = commandText(call.input);
  if (command !== undefined) {
    for (const [reason, pattern] of COMMAND_RULES) if (pattern.test(command)) reasons.add(reason);
    const homeForms = ['~/', '$HOME/', '${HOME}/', `${home}/`];
    if (SENSITIVE_HOME_PATHS.some(path => homeForms.some(prefix => command.includes(`${prefix}${path}`)))) reasons.add('sensitive-path');
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
  for (const { path: raw, mutating } of paths) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const expanded = raw === '~' ? home : raw.startsWith('~/') ? `${home}${raw.slice(1)}` : raw;
    const target = resolve(call.cwd, expanded);
    targets.push(target);
    if (SENSITIVE_HOME_PATHS.some(path => within(resolve(home, path), target))) reasons.add('sensitive-path');
    if (mutating && !within(workspace, target)) reasons.add('write-outside-workspace');
  }

  const matchingIds = (entries: readonly ToolRule[] | undefined, allow: boolean): readonly string[] => {
    const ids: string[] = [];
    for (const { id, match } of entries ?? []) {
      if (match.toolName !== undefined && match.toolName !== call.toolName) continue;
      if (match.commandGlob !== undefined && (command === undefined || !matchesGlob(command, match.commandGlob))) continue;
      if (match.mcpServer !== undefined && (call.mcp === undefined || !matchesGlob(call.mcp.server, match.mcpServer))) continue;
      if (match.mcpTool !== undefined && (call.mcp === undefined || !matchesGlob(call.mcp.tool, match.mcpTool))) continue;
      if (match.pathGlob !== undefined) {
        const pattern = match.pathGlob;
        if (targets.length === 0 || !(allow
          ? targets.every(target => matchesGlob(target, pattern))
          : targets.some(target => matchesGlob(target, pattern)))) continue;
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
  if (allowIds.length > 0) return { level: 'normal', authorization: Object.freeze({ source: 'rule', ruleIds: allowIds }) };
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
  authorize(call: ToolCall): Promise<ToolAuthorizationVerdict>;
}

const MAX_SUMMARY_CHARS = 1_000;
export function describeHighRiskToolCall(
  call: Pick<ToolCall, 'toolName' | 'input'>, reasons: readonly ToolRiskReason[], authorization?: ToolAuthorizationReason,
): string {
  const subject = commandText(call.input)
    ?? PATH_KEYS.map(key => call.input[key]).find((value): value is string => typeof value === 'string')
    ?? '';
  const label = authorization?.source === 'rule' ? `Tool authorization rule (${authorization.ruleIds.join(', ')})`
    : authorization?.source === 'floor' ? 'Protected-path tool call' : 'High-risk tool call';
  const summary = `${label} (${reasons.join(', ')}): ${call.toolName}${subject ? ` ${subject}` : ''}`;
  return summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS - 1)}…` : summary;
}

export function createAutoToolAuthorizationGate(input: {
  readonly workspace: string;
  readonly home?: string;
  readonly timeoutMs: number;
  readonly rules?: ToolAuthorizationRules;
  readonly mcpIdentities?: ReadonlyMap<string, { readonly server: string; readonly tool: string }>;
  readonly onDecision?: (decision: { readonly call: ToolCall; readonly risk: ToolRisk; readonly verdict: ToolAuthorizationVerdict }) => void;
  /** Aborting `signal` must withdraw the request so a later decision cannot revive it. */
  readonly requestAuthorization: (summary: string, signal: AbortSignal) => Promise<{ approved: boolean; reason?: string }>;
}): ToolAuthorizationGate {
  return Object.freeze({
    timeoutMs: input.timeoutMs,
    async authorize(rawCall: ToolCall): Promise<ToolAuthorizationVerdict> {
      let call = rawCall;
      const withdraw = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<'expired'>(resolve => { timer = setTimeout(() => resolve('expired'), input.timeoutMs); });
      let risk: ToolRisk | undefined;
      const finish = (verdict: ToolAuthorizationVerdict): ToolAuthorizationVerdict => {
        const classifiedVerdict = risk === undefined ? verdict : { ...verdict, authorization: risk.authorization };
        if (risk !== undefined) {
          try { input.onDecision?.({ call, risk, verdict: classifiedVerdict }); } catch { /* Observers do not own authorization. */ }
        }
        return classifiedVerdict;
      };
      try {
        // A runtime label is not an MCP authority. Only an exact admitted mapping
        // may attach identity to a gate request, even if the request supplies one.
        const { mcp: _untrustedMcp, ...nativeCall } = rawCall;
        const mcp = input.mcpIdentities?.get(rawCall.toolName);
        call = { ...nativeCall, ...(mcp === undefined ? {} : { mcp }) };
        risk = classifyToolCall(call, input.workspace, input.home, input.rules);
        if (risk.level === 'normal') return finish({ decision: 'allow' });
        const summaryAuthorization = risk.authorization.source === 'rule' ? risk.authorization : undefined;
        const result = await Promise.race([input.requestAuthorization(describeHighRiskToolCall(call, risk.reasons, summaryAuthorization), withdraw.signal), expired]);
        if (result === 'expired') {
          withdraw.abort();
          return finish({ decision: 'deny', code: 'tool_authorization_unavailable', reason: `tool authorization timed out after ${input.timeoutMs}ms` });
        }
        if (result.approved === true) return finish({ decision: 'allow' });
        return finish({ decision: 'deny', code: 'tool_authorization_denied', reason: result.reason
          ?? (risk.authorization.source === 'rule' ? 'user did not authorize this tool call' : 'user did not authorize this high-risk tool call') });
      } catch {
        withdraw.abort();
        return finish({ decision: 'deny', code: 'tool_authorization_unavailable', reason: 'tool authorization is unavailable' });
      } finally {
        clearTimeout(timer);
      }
    },
  });
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
}
