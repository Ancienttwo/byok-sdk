import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
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
export type ToolAuthorizationResolver = (task: ToolAuthorizationTask) => ToolAuthorizationMode;

export function parseToolAuthorizationMode(value: unknown): ToolAuthorizationMode {
  if (value !== 'auto' && value !== 'all') throw new TypeError('tool authorization mode must be auto or all');
  return value;
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
}

export type ToolRiskReason =
  | 'privilege-escalation' | 'recursive-delete' | 'system-modification' | 'destructive-git'
  | 'publish-or-deploy' | 'remote-script-execution' | 'permission-broadening'
  | 'sensitive-path' | 'write-outside-workspace';
export type ToolRisk = { readonly level: 'normal' } | { readonly level: 'high'; readonly reasons: readonly ToolRiskReason[] };

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
  call: Pick<ToolCall, 'toolName' | 'input' | 'cwd'>, workspace: string, home: string = homedir(),
): ToolRisk {
  const reasons = new Set<ToolRiskReason>();
  const command = commandText(call.input);
  if (command !== undefined) {
    for (const [reason, pattern] of COMMAND_RULES) if (pattern.test(command)) reasons.add(reason);
    const homeForms = ['~/', '$HOME/', '${HOME}/', `${home}/`];
    if (SENSITIVE_HOME_PATHS.some(path => homeForms.some(prefix => command.includes(`${prefix}${path}`)))) reasons.add('sensitive-path');
  }
  for (const key of PATH_KEYS) {
    const raw = call.input[key];
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const expanded = raw === '~' ? home : raw.startsWith('~/') ? `${home}${raw.slice(1)}` : raw;
    const target = resolve(call.cwd, expanded);
    if (SENSITIVE_HOME_PATHS.some(path => within(resolve(home, path), target))) reasons.add('sensitive-path');
    if (MUTATING_TOOLS.has(call.toolName.toLowerCase()) && !within(workspace, target)) reasons.add('write-outside-workspace');
  }
  return reasons.size === 0 ? { level: 'normal' } : { level: 'high', reasons: Object.freeze([...reasons]) };
}

export type ToolAuthorizationDenialCode = 'tool_authorization_denied' | 'tool_authorization_unavailable';
export type ToolAuthorizationVerdict =
  | { readonly decision: 'allow' }
  | { readonly decision: 'deny'; readonly code: ToolAuthorizationDenialCode; readonly reason: string };

/**
 * The `auto` gate a daemon hands to an adapter that declares
 * `toolAuthorizationAuto`. The adapter calls it for every native tool call
 * before execution; it never throws.
 */
export interface ToolAuthorizationGate {
  /** Upper bound on one decision, user authorization included. */
  readonly timeoutMs: number;
  authorize(call: ToolCall): Promise<ToolAuthorizationVerdict>;
}

const MAX_SUMMARY_CHARS = 1_000;
export function describeHighRiskToolCall(call: Pick<ToolCall, 'toolName' | 'input'>, reasons: readonly ToolRiskReason[]): string {
  const subject = commandText(call.input)
    ?? PATH_KEYS.map(key => call.input[key]).find((value): value is string => typeof value === 'string')
    ?? '';
  const summary = `High-risk tool call (${reasons.join(', ')}): ${call.toolName}${subject ? ` ${subject}` : ''}`;
  return summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS - 1)}…` : summary;
}

export function createAutoToolAuthorizationGate(input: {
  readonly workspace: string;
  readonly timeoutMs: number;
  readonly requestAuthorization: (summary: string) => Promise<{ approved: boolean; reason?: string }>;
}): ToolAuthorizationGate {
  return Object.freeze({
    timeoutMs: input.timeoutMs,
    async authorize(call: ToolCall): Promise<ToolAuthorizationVerdict> {
      try {
        const risk = classifyToolCall(call, input.workspace);
        if (risk.level === 'normal') return { decision: 'allow' };
        const result = await input.requestAuthorization(describeHighRiskToolCall(call, risk.reasons));
        if (result.approved === true) return { decision: 'allow' };
        return { decision: 'deny', code: 'tool_authorization_denied', reason: result.reason ?? 'user did not authorize this high-risk tool call' };
      } catch {
        return { decision: 'deny', code: 'tool_authorization_unavailable', reason: 'tool authorization is unavailable' };
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
}
