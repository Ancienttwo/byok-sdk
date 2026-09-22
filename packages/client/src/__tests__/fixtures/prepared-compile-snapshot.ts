import type { CompilePreparedInputRequest } from '../../adapters/pi/input-preparation';
import type { InputPreparationCompiledSnapshotV1 } from '../../input-preparation';

/**
 * The full 0.86 prompt surface, deliberately non-empty in every field the
 * rebase added or changed.
 *
 * `toolGuidelines`, `skills` and a host-canonical prefix are stated here rather
 * than in a separate case because they are what the rebase moved: an empty
 * fixture would compile the same bytes the 0.85 line did and prove nothing
 * about the renderer that now produces them. `constrainedSampling` is likewise
 * carried on the tools exactly as an 0.86 built-in declares it, so the request
 * this fixture counts is the one the runtime would actually send.
 *
 * It lives in `fixtures/` because two tests compile it: the in-process contract
 * suite (`pi-input-preparation.test.ts`) and the isolated purity gate
 * (`pi-compile-purity.test.ts`), which compares the body its child process
 * produced against the body this exact request produces here. Two copies of the
 * prompt surface would make that comparison a comparison of two fixtures.
 */
export function preparedCompileSnapshot(): InputPreparationCompiledSnapshotV1 {
  return {
    prompt: {
      cwd: '/workspace/project',
      selectedTools: ['read', 'bash'],
      toolSnippets: { read: 'read snippet', bash: 'bash snippet' },
      toolGuidelines: { read: ['read before you write'], bash: ['quote every path'] },
      promptGuidelines: ['prefer small diffs'],
      contextFiles: [{ path: 'AGENTS.md', content: '# agents\nbe precise\n' }],
      skills: [
        {
          name: 'review',
          description: 'review a diff before it is proposed',
          filePath: '/workspace/project/.skills/review/SKILL.md',
          disableModelInvocation: false,
        },
      ],
      docsPaths: { readmePath: 'README.md', docsPath: 'docs', examplesPath: 'examples' },
    },
    messages: [
      // A host-canonical prefix: the host asserts this text was already said,
      // and it carries no provenance. The context still ends on a user turn,
      // which the native compile boundary requires.
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
