import { fileURLToPath } from 'node:url';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import type { Session } from '../types';
import { startPreparedOperation } from './fixtures/prepared-operation';

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
// Captured from the pre-OAR claude adapter (events.ts) before the stream-json session replaced it.
const GOLDEN_PATH = fileURLToPath(new URL('./fixtures/claude-agent-events.golden.json', import.meta.url));

interface ParityCase { readonly env: Readonly<Record<string, string>>; readonly turns: number }
const CASES: Readonly<Record<string, ParityCase>> = {
  default: { env: {}, turns: 2 },
  deny: { env: { FAKE_CLAUDE_DENY: '1' }, turns: 1 },
  artifact: { env: { FAKE_CLAUDE_ARTIFACT_PATH: 'out/hello.md' }, turns: 1 },
  outsideArtifact: { env: { FAKE_CLAUDE_ARTIFACT_PATH: '/tmp/byok-claude-parity-outside.md' }, turns: 1 },
  unknownFrames: { env: { FAKE_CLAUDE_UNKNOWN_TOP_LEVEL: '1', FAKE_CLAUDE_UNKNOWN_SYSTEM_SUBTYPE: '1', FAKE_CLAUDE_UNKNOWN_ASSISTANT_BLOCK: '1' }, turns: 1 },
  splitClosingText: { env: { FAKE_CLAUDE_SPLIT_CLOSING_TEXT: '1' }, turns: 1 },
  repeatClosingText: { env: { FAKE_CLAUDE_REPEAT_CLOSING_TEXT: '1', FAKE_CLAUDE_ROOT_FRAMES: '1' }, turns: 1 },
  subagentModels: { env: { FAKE_CLAUDE_ROOT_FRAMES: '1', FAKE_CLAUDE_EXTRA_ASSISTANT: JSON.stringify([{ model: 'claude-haiku-4-5', parent_tool_use_id: 'toolu_task' }, { model: 'claude-sonnet-4-5', parent_tool_use_id: null }]) }, turns: 1 },
  partialMessages: { env: { FAKE_CLAUDE_PARTIAL_MESSAGES: '1', FAKE_CLAUDE_ROOT_FRAMES: '1' }, turns: 2 },
  failures: { env: { FAKE_CLAUDE_FAILURES: JSON.stringify([{ error: 'rate_limit', status: 429 }, { error: 'authentication_failed', status: 401 }, { exit: true }]) }, turns: 3 },
  malformedResult: { env: { FAKE_CLAUDE_RESULT_MALFORMED: '1' }, turns: 1 },
};

type Observed = Record<string, unknown>;

async function turn(session: Session, workspaceDir: string): Promise<Observed[]> {
  const out: Observed[] = [];
  const scrub = (value: unknown) => JSON.parse(JSON.stringify(value ?? null).split(workspaceDir).join('<ws>')) as Observed;
  try {
    for await (const event of session.events) {
      out.push(scrub(event.type === 'progress' ? { ...event, startsMessage: session.progressStartsMessage!(event) } : event));
      if (event.type === 'turn_end') break;
    }
    out.push({ ended: true });
  } catch (error) {
    const failure = error as { reason?: unknown; failure?: unknown };
    out.push(scrub({ thrown: failure.reason ?? String(error), failure: failure.failure }));
  }
  return out;
}

async function observe(parity: ParityCase): Promise<Observed[][]> {
  const workspaceDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-claude-parity-')));
  const saved = { ...process.env };
  Object.assign(process.env, parity.env);
  let session: Session | undefined;
  try {
    const adapter = new ClaudeAdapter({ resolveBin: () => ({ command: FIXTURE_PATH, source: 'path' }), runtimeEnvironment: { base: 'allowlist', allow: ['FAKE_CLAUDE_*'] } });
    session = await startPreparedOperation(adapter, { instruction: 'say hi' }, { workspaceDir, env: process.env });
    const turns = [await turn(session, workspaceDir)];
    for (let index = 1; index < parity.turns; index += 1) {
      await session.followUp({ instruction: `turn ${index + 1}` });
      turns.push(await turn(session, workspaceDir));
    }
    return turns;
  } finally {
    process.env = saved;
    await session?.close();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
}

describe('claude AgentEvent parity with the captured golden', () => {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, Observed[][]>;
  for (const [name, parity] of Object.entries(CASES)) {
    it(name, async () => { expect(await observe(parity)).toEqual(golden[name]); }, 20_000);
  }
});
