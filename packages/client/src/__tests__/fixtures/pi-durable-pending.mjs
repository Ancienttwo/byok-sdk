// Real Pi 1.0 request checkpoint, deliberately held until this process is killed.
import { appendFileSync } from 'node:fs';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { Harness, createRegistry, defineExtension, hook, ToolTask } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { dirname } from 'node:path';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
const [file, receipt] = process.argv.slice(2);
const model = { id: 'test', name: 'test', api: 'openai-completions', provider: 'probe', baseUrl: 'http://127.0.0.1:9', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 64 };
const stream = () => {
  appendFileSync(receipt, 'old-model-call\n');
  const out = createAssistantMessageEventStream();
  const message = { role: 'assistant', content: [{ type: 'toolCall', id: 'old-call', name: 'bash', arguments: { command: 'printf OLD > old-effect' } }], api: model.api, provider: 'probe', model: 'test', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: Date.now() };
  queueMicrotask(() => { out.push({ type: 'done', reason: 'toolUse', message }); out.end(message); }); return out;
};
const held = defineExtension({ name: 'old-tools', tools: CodingTools.tools, hooks: [hook(ToolTask, { beforeTool: async () => { process.stdout.write('checkpoint-ready\n'); await new Promise(() => {}); } })] });
const registry = createRegistry(); registry.install(held);
setInterval(() => {}, 1000); // Only the test's confirmed KILL/close releases the fixture.

const models = createModels(); models.setProvider(createProvider({ id: 'probe', auth: { apiKey: { name: 'synthetic', resolve: async () => ({ auth: { apiKey: 'synthetic' } }) } }, models: [model], api: { stream, streamSimple: stream } }));
const harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry, env: () => new NodeExecutionEnv({ cwd: dirname(file) }), settings: { retry: { enabled: false, maxRetries: 0 }, compaction: { enabled: false } } }, BACKGROUND_CONTEXT);
const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: 'probe', modelId: 'test' }, extensions: [held], tools: CodingTools.tools } });
await root.submit({ type: 'input', content: 'Stale Host execution must never resume', requestId: 'terminal-old-task' }, BACKGROUND_CONTEXT);
