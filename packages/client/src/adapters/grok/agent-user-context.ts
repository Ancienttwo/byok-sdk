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
 * into the SDK home would be lost at cleanup. Windows refuses.
 */
export async function createGrokAgentHome(env: Readonly<Record<string, string | undefined>>, dir: string, agentHome: string | undefined, platform: NodeJS.Platform = process.platform): Promise<string> {
  // Until #2241 settles how a Windows account without symlink privilege links the login, refuse before any link is tried.
  if (platform === 'win32') throw refuse('the SDK-owned GROK_HOME is not supported on Windows');
  return await createOwnedRuntimeHome({
    refusalPrefix: PREFIX,
    name: 'grok-home',
    userHome: () => userGrokHome(env),
    userHomeLabel: 'GROK_HOME',
    linked: LINKED,
    required: env.XAI_API_KEY ? [] : [{ entry: 'auth.json', reason: 'the user GROK_HOME has no auth.json and XAI_API_KEY is not set' }],
    agentStore: { agentHome, root: path.join('.byok', 'grok'), entries: ['sessions'], label: 'session store' },
  }, dir, platform);
}

/**
 * Why `grok inspect --json` output, run with the SDK-owned home, still lists a
 * user instruction file, or `undefined` when it lists none. `projectInstructions`
 * reports discovery: a `global` entry may load. Each entry is judged by its own
 * marks, never by its directory: only a Claude or Cursor compatibility file that
 * inspect marks `disabled: true` and `compatibilityStatus: 'disabled'` is allowed.
 * An `[paths] extra_rule_dirs` file, even inside `~/.claude`, carries no vendor;
 * partial or contradictory marks count as loaded. Output it cannot read refuses.
 */
export async function grokUserInstructionsRefusal(output: string): Promise<string | undefined> {
  let parsed: Record<string, unknown> | undefined;
  try { parsed = record(JSON.parse(output)); } catch { parsed = undefined; }
  if (!parsed || !Array.isArray(parsed.projectInstructions)) return GROK_USER_CONTEXT_INSPECT_FAILED;
  let found = 0;
  for (const entry of parsed.projectInstructions) {
    const instruction = record(entry);
    if (typeof instruction?.path !== 'string' || typeof instruction.scope !== 'string') return GROK_USER_CONTEXT_INSPECT_FAILED;
    const { vendor, disabled, compatibilityStatus } = instruction;
    if ((vendor !== undefined && typeof vendor !== 'string') || (disabled !== undefined && typeof disabled !== 'boolean')
      || (compatibilityStatus !== undefined && typeof compatibilityStatus !== 'string')) return GROK_USER_CONTEXT_INSPECT_FAILED;
    const switchedOff = (vendor === 'claude' || vendor === 'cursor') && disabled === true && compatibilityStatus === 'disabled';
    if (instruction.scope === 'global' && !switchedOff) found++;
  }
  return found === 0 ? undefined : `${PREFIX}: Grok still loads ${found} user instruction file${found === 1 ? '' : 's'} outside the task, such as [paths] extra_rule_dirs`;
}
