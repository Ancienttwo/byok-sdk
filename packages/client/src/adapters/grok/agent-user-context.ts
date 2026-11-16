import { promises as fs } from 'node:fs';
import path from 'node:path';
import { RuntimeExecutionFailure } from '../../runtime-failure.js';
import { createOwnedRuntimeHome } from '../owned-runtime-home.js';
import { objectRecord as record } from '../shared-rules.js';

const PREFIX = 'grok Agent user context exclusion refused';
const refuse = (reason: string) => new RuntimeExecutionFailure({ phase: 'start', retry: 'non-retryable', reason: `${PREFIX}: ${reason}` });
/** The refusal when inspect fails or prints output this check cannot read. */
export const GROK_USER_CONTEXT_INSPECT_FAILED = `${PREFIX}: grok inspect failed`;

/**
 * The user `GROK_HOME` entries an SDK-owned home links (#2239): the login, the
 * configuration (models and providers), folder trust, so project files load as
 * under `inherit`, and the user's hooks, which travel with the user as the
 * Codex guardrails do. Everything else stays out: `AGENTS.md`, `rules/`,
 * `skills/`, memory, plugins and the user's sessions.
 */
const LINKED = Object.freeze(['auth.json', 'config.toml', 'trusted_folders.toml', 'hooks']);

/** Grok's own resolution: a set `GROK_HOME`, else `.grok` in the home directory. */
function userGrokHome(env: Readonly<Record<string, string | undefined>>): string {
  if (env.GROK_HOME !== undefined && env.GROK_HOME !== '') return env.GROK_HOME;
  if (env.HOME === undefined || env.HOME === '') throw refuse('the runtime environment names no HOME for the user GROK_HOME');
  return path.join(env.HOME, '.grok');
}

/**
 * Builds the SDK-owned `GROK_HOME` of one Agent task in `dir` and returns it.
 * The session store links to the Agent's own store, `<agentHome>/.byok/grok/sessions`,
 * so a later task of the same Agent resumes its session. Without an API key in
 * the environment, a user home without `auth.json` refuses: a login written
 * into the SDK home would be lost at cleanup.
 */
export function createGrokAgentHome(env: Readonly<Record<string, string | undefined>>, dir: string, agentHome: string | undefined): Promise<string> {
  return createOwnedRuntimeHome({
    refusalPrefix: PREFIX,
    name: 'grok-home',
    userHome: () => userGrokHome(env),
    userHomeLabel: 'GROK_HOME',
    linked: LINKED,
    required: env.XAI_API_KEY ? [] : [{ entry: 'auth.json', reason: 'the user GROK_HOME has no auth.json and XAI_API_KEY is not set' }],
    agentStore: { agentHome, root: path.join('.byok', 'grok'), entries: ['sessions'], label: 'session store' },
  }, dir);
}

/**
 * Why `grok inspect --json` output, run with the SDK-owned home, still lists a
 * user instruction file, or `undefined` when it lists none. `projectInstructions`
 * reports discovery: a `global` entry may load. The SDK home has no `AGENTS.md`
 * or `rules/`, so a `global` entry is an `extra_rule_dirs` file, an unknown
 * source, or a Claude or Cursor file. Only the last is allowed, and only when
 * inspect reports its `agents` or `rules` cell disabled: Grok 1.0.77 lists those
 * files even with the cell off. Output it cannot read refuses too.
 */
export async function grokUserInstructionsRefusal(output: string, home: string, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  let parsed: Record<string, unknown> | undefined;
  try { parsed = record(JSON.parse(output)); } catch { parsed = undefined; }
  const cells = record(parsed?.externalCompat)?.cells;
  if (!parsed || !Array.isArray(parsed.projectInstructions) || !Array.isArray(cells)) return GROK_USER_CONTEXT_INSPECT_FAILED;
  const disabled = new Set<string>();
  for (const entry of cells) {
    const cell = record(entry);
    if (typeof cell?.vendor !== 'string' || typeof cell.surface !== 'string' || typeof cell.enabled !== 'boolean') return GROK_USER_CONTEXT_INSPECT_FAILED;
    if (!cell.enabled) disabled.add(`${cell.vendor}/${cell.surface}`);
  }
  // Grok prints names in its own letter case (`Claude.md`); darwin's case-insensitive volume compares folded.
  const fold = (value: string) => platform === 'darwin' ? value.toLowerCase() : value;
  const homes = [...new Set([home, await fs.realpath(home).catch(() => home)])].map(fold);
  const allowed = (file: string): boolean => homes.some(root => ['claude', 'cursor'].some(vendor => {
    const base = path.join(root, `.${vendor}`);
    return (disabled.has(`${vendor}/agents`) && path.dirname(file) === base)
      || (disabled.has(`${vendor}/rules`) && file.startsWith(`${path.join(base, 'rules')}${path.sep}`));
  }));
  let found = 0;
  for (const entry of parsed.projectInstructions) {
    const instruction = record(entry);
    if (typeof instruction?.path !== 'string' || typeof instruction.scope !== 'string') return GROK_USER_CONTEXT_INSPECT_FAILED;
    if (instruction.scope === 'global' && !allowed(fold(instruction.path))) found++;
  }
  return found === 0 ? undefined : `${PREFIX}: Grok still loads ${found} user instruction file${found === 1 ? '' : 's'} outside the task, such as [paths] extra_rule_dirs`;
}
