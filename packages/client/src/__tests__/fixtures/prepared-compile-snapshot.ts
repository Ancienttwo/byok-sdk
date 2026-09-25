import type { CompilePreparedInputRequest } from '../../adapters/pi/input-preparation';
import type { InputPreparationCompiledSnapshotV1 } from '../../input-preparation';

/**
 * The Host-authored prepared input on official Pi (A1'/A2'), non-empty in
 * every field the official migration moved.
 *
 * The Host owns the WHOLE system message: `customPrompt` is it, verbatim, and
 * every renderer input (`toolSnippets`, `toolGuidelines`, `promptGuidelines`,
 * `contextFiles`, `skills`) is empty because a non-empty one is refused as
 * `prompt_render_input_unsupported`. The host-canonical prefix exercises the
 * A2' sentinel provenance, and `constrainedSampling` is carried on the tools
 * the one way the compile admits it (`{ json_schema, prefer }`).
 *
 * It lives in `fixtures/` because two tests compile it: the in-process contract
 * suite (`pi-input-preparation.test.ts`) and the isolated purity gate
 * (`pi-compile-purity.test.ts`), which compares the body its child process
 * produced against the body this exact request produces here. Two copies of the
 * input would make that comparison a comparison of two fixtures.
 */
export const PREPARED_COMPILE_SYSTEM_PROMPT = [
  'You are the BYOK coding agent.',
  '# agents',
  'be precise',
  'prefer small diffs',
  'read before you write',
  'review a diff before it is proposed',
].join('\n');

export function preparedCompileSnapshot(): InputPreparationCompiledSnapshotV1 {
  return {
    prompt: { systemPrompt: PREPARED_COMPILE_SYSTEM_PROMPT },
    messages: [
      // A host-canonical prefix: the host asserts this text was already said.
      // It enters T with the A2' sentinel provenance, which never reaches D.
      // The context still ends on a user turn, which the compile requires.
      { role: 'user', content: 'what does this repository do?', timestamp: 1_699_999_999_000 },
      { role: 'assistant', origin: 'host_canonical', content: 'It is a BYOK SDK.', timestamp: 1_699_999_999_500 },
      { role: 'user', content: 'summarise the repository', timestamp: 1_700_000_000_000 },
    ],
    tools: [
      {
        name: 'read',
        description: 'read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        constrainedSampling: { type: 'json_schema', strict: 'prefer' },
      },
      {
        name: 'bash',
        description: 'run a command',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
        constrainedSampling: { type: 'json_schema', strict: 'prefer' },
      },
    ],
  };
}

/** The whole compile request the snapshot above belongs to, model and options included. */
export function preparedCompileRequest(
  overrides: Partial<CompilePreparedInputRequest> = {},
): CompilePreparedInputRequest {
  return {
    snapshot: preparedCompileSnapshot(),
    model: {
      id: 'glm-4.6',
      name: 'GLM 4.6',
      api: 'openai-completions',
      provider: 'zai',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      reasoning: false,
      input: ['text'],
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    },
    options: { cacheRetention: 'none', maxTokens: 4_096, temperature: 0 },
    binding: {
      inputIdentity: 'rev-1:src-1',
      runtimeIdentity: 'runtime-1',
      policyIdentity: 'policy-1',
      profileRevision: 'profile-1',
    },
    toolExecutors: { read: 'exec:read@1', bash: 'exec:bash@1' },
    ...overrides,
  };
}
