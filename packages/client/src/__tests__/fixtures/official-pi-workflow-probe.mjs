/** Offline behavioral probe: real workflow Worker and vendored arbiter, loopback SSE only. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { ModelRuntime, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createTaskMutationArbiter } from '../../../vendor/pi-subagents/0.60.0/src/runs/shared/llm-intent-arbiter.ts';
import { runWorkflowScript } from '../../../vendor/pi-subagents/0.60.0/src/workflows/scripted-workflow.ts';
import { createWorkflowChildPermit, claimWorkflowChildPermit, consumeWorkflowChildPermit, validateWorkflowChildPermitRoot } from '../../../vendor/pi-subagents/0.60.0/src/shared/workflow-child-permit.ts';

const codingRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))));
const codingParent = pathToFileURL(path.join(codingRoot, 'package.json')).href;
const instances = Object.fromEntries(['pi-ai', 'pi-agent-core'].map(name => {
  const spec = `@earendil-works/${name}`;
  const roots = [...new Set([import.meta.url, codingParent].map(parent => realpathSync(path.dirname(path.dirname(fileURLToPath(import.meta.resolve(spec, parent)))))))];
  for (const root of roots) assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version, '0.87.1');
  if (process.argv.includes('--expect-nested')) assert.equal(roots.length, 2, `${name} must exercise both npm instances`);
  return [name, roots];
}));
const input = { issuerPackage: '@byok-sdk/client', workflowRunId: 'root-a', childKey: 'child', agent: 'worker', launchContractDigest: 'digest-a', context: 'fresh' };
const launch = { ...input, runner: 'pi' };
for (const change of [{ workflowRunId: 'root-b' }, { childKey: 'other' }, { agent: 'other' }, { launchContractDigest: 'other' }, { context: 'fork' }]) {
  const permit = createWorkflowChildPermit(input);
  assert.equal(claimWorkflowChildPermit(permit, input.workflowRunId, input.childKey), undefined);
  assert.equal(typeof consumeWorkflowChildPermit(permit, { ...launch, ...change }), 'string');
}
assert.equal(typeof validateWorkflowChildPermitRoot(createWorkflowChildPermit(input), 'root-b'), 'string');
assert.equal(typeof consumeWorkflowChildPermit(createWorkflowChildPermit(input), launch), 'string');
assert.equal(typeof claimWorkflowChildPermit(JSON.parse('{}'), input.workflowRunId, input.childKey), 'string');
const permit = createWorkflowChildPermit(input);
let sends = 0;
const server = createServer(async (req, res) => {
  assert.equal(req.url, '/v1/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer offline-placeholder');
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  sends++;
  assert.ok(sends <= 2, 'no unexpected additional provider request');
  assert.equal(body.tools[0].function.name, 'task_mutation_decision');
  const first = sends === 1;
  const delta = first ? { role: 'assistant', tool_calls: [{ index: 0, id: 'decision-1', type: 'function', function: { name: 'task_mutation_decision', arguments: JSON.stringify({ classification: 'read_only', confidence: 'high', reason: 'fixture' }) } }] } : { role: 'assistant', content: 'done' };
  const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(frame({ id: 'offline', object: 'chat.completion.chunk', model: 'model', choices: [{ index: 0, delta, finish_reason: null }] }) + frame({ id: 'offline', object: 'chat.completion.chunk', model: 'model', choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }) + 'data: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerProvider('offline-workflow', {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'offline-placeholder',
    models: [{ id: 'model', name: 'model', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
  });
  const registry = new ModelRegistry(runtime);
  const arbiter = createTaskMutationArbiter({ model: runtime.getModel('offline-workflow', 'model'), modelRegistry: registry });
  assert.ok(arbiter);
  let launched = 0;
  const result = await runWorkflowScript({
    script: 'const a = await runs.run("child", {agent:"worker", task:"Review only"}); const b = await runs.run("child", {agent:"worker", task:"Review only"}); emit({verdict:b.output}); return a.output;',
    oneUsePermit: { claim: key => claimWorkflowChildPermit(permit, input.workflowRunId, key) },
    async launch(key) {
      assert.equal(consumeWorkflowChildPermit(permit, launch), undefined);
      launched++;
      const verdict = await arbiter('Review only');
      assert.equal(verdict, 'read-only');
      return { key, ok: true, output: verdict, artifactPaths: [] };
    },
    async status() { throw new Error('unused status'); },
  });
  assert.equal(result.value, 'read-only');
  assert.deepEqual(result.emits, [{ verdict: 'read-only' }]);
  assert.equal(result.children.length, 1);
  assert.ok(result.trace.some(entry => entry.state === 'reused'));
  assert.equal(launched, 1);
  assert.equal(sends, 2);
  assert.equal(typeof consumeWorkflowChildPermit(permit, launch), 'string');
  let forbiddenLaunches = 0;
  await assert.rejects(runWorkflowScript({ script: 'return runs.run("other", {agent:"worker", task:"No"});',
    oneUsePermit: { claim: key => claimWorkflowChildPermit(permit, input.workflowRunId, key) },
    async launch(key) { forbiddenLaunches++; return { key, ok: true, output: '', artifactPaths: [] }; },
    async status() { throw new Error('unused'); },
  }), /already consumed/);
  assert.equal(forbiddenLaunches, 0);
  console.log(JSON.stringify({ status: 'passed', instances, workflowLaunches: launched, loopbackRequests: sends, providerRequests: 0, permitNegativeCases: 9 }));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(() => resolve()));
}
