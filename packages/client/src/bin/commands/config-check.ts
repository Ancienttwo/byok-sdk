import { checkDaemonConfig, type DaemonConfigCheck } from '../../daemon/config-schema/check';
import type { DaemonEffectiveConfig } from '../../daemon/config-schema/effective';
import { formatConfigIssue, readConfigFile } from '../config';
import { OFFICIAL_LOCAL_AGENT_RELEASE } from '../official-release';

export interface ConfigCheckOptions {
  /** Fail on warnings (unknown fields) too, for CI. */
  readonly strict: boolean;
  readonly json: boolean;
}

export interface ConfigCheckDeps {
  log?: (line: string) => void;
}

/**
 * `byok-agent config check` (#1094): validates a config file with the shared
 * validator, as `start` would load it, and prints the effective values the
 * daemon would run with. Returns the exit code: 1 on any error, and with
 * `--strict` on any warning; otherwise 0.
 */
export function runConfigCheckCommand(configPath: string, options: ConfigCheckOptions, deps: ConfigCheckDeps = {}): number {
  const log = deps.log ?? ((line: string) => console.log(line));
  const { $schema: _schema, ...input } = readConfigFile(configPath);
  const check = checkDaemonConfig(input, { source: 'cli', localAgentRelease: OFFICIAL_LOCAL_AGENT_RELEASE });
  const ok = check.ok && !(options.strict && check.issues.length > 0);
  if (options.json) {
    log(JSON.stringify({ ok, strict: options.strict, config: configPath, issues: check.issues, ...(check.effective === undefined ? {} : { effective: check.effective }) }, null, 2));
  } else {
    for (const line of formatConfigCheck(configPath, check, options.strict, ok)) log(line);
  }
  return ok ? 0 : 1;
}

export function formatConfigCheck(configPath: string, check: DaemonConfigCheck, strict: boolean, ok: boolean): string[] {
  const lines = [`config: ${configPath}`];
  for (const issue of check.issues) lines.push(`  ${issue.severity.padEnd(7)} ${issue.path === '' ? '(root)' : issue.path}: ${formatConfigIssue(issue)}`);
  const errors = check.issues.filter((issue) => issue.severity === 'error').length;
  const warnings = check.issues.length - errors;
  const counts = `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`;
  lines.push(`result: ${ok ? 'ok' : 'invalid'} (${counts}${strict ? '; --strict fails on warnings' : ''})`);
  if (check.effective !== undefined) lines.push(...formatEffectiveConfig(check.effective));
  return lines;
}

function formatEffectiveConfig(effective: DaemonEffectiveConfig): string[] {
  const { directories, memory, toolAuthorization } = effective;
  const scratch = directories.scratchRoot;
  const budget = scratch.socketPathMaximumBytes === undefined
    ? `${scratch.socketPathBytes} bytes, no socket path limit`
    : `${scratch.socketPathBytes} of at most ${scratch.socketPathMaximumBytes} bytes for runtime sockets`;
  const helper = memory.helper.state === 'resolved' ? `resolved ${memory.helper.path}`
    : memory.helper.state === 'missing' ? `missing: ${memory.helper.reason}` : memory.helper.state;
  const lines = [
    `effective values (schema v${effective.schemaVersion}):`,
    `  storeDir:          ${directories.storeDir.path} (${directories.storeDir.source})`,
    `  hostStorageRoot:   ${directories.hostStorageRoot ?? '(no agentHome)'}`,
    ...(directories.agentHomes === undefined ? [] : [`  Agent homes:       ${directories.agentHomes}`]),
    `  scratch root:      ${scratch.path} (${scratch.source}; ${budget})`,
    `  memory MCP:        ${memory.mcp} (helper: ${helper})`,
    '  MCP servers:',
    ...effective.mcpServers.map((server) => `    ${server.name} [${server.kind}] ${server.mount}: ${server.detail}`),
    '  runtimes:',
    ...effective.runtimes.map((runtime) => {
      const isolation = runtime.isolation === undefined ? '' : ` ${Object.entries(runtime.isolation).map(([key, value]) => `${key}=${value}`).join(' ')}`;
      return `    ${runtime.id} [${runtime.source}] auto ${runtime.toolAuthorizationAuto ? 'supported' : 'unsupported'}${isolation}`;
    }),
    `  tool authorization: ${toolAuthorization.mode} (local tool approval: ${toolAuthorization.localToolApproval})`,
  ];
  return lines;
}
