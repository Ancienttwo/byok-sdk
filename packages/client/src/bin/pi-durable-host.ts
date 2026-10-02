import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import type { Model, ProviderStreams, TSchema } from '@earendil-works/pi-ai';
import { type ToolRegistration } from '@earendil-works/pi-durable';
import { extractPiConfigDigest, readPiHostConfig, requirePiHostBinding, verifyPiHostBinding } from '../adapters/pi/runtime-host-binding';
import { PROVIDER_CREDENTIAL_ENV_DENY_NAMES } from '../adapters/provider-credential-environment';
import { admitReplica, type DurableReplicaBinding } from '../adapters/pi-durable/replica';
import { openDurableEngine } from '../adapters/pi-durable/engine';
import { projectDurableEvent } from '../adapters/pi-durable/events';
import { parseTaskScopedMcpConfig, McpServerPool } from '../adapters/pi/mcp-server-pool';
import { createPiMcpTools } from '../adapters/pi/mcp-tools';
import { projectMcpTools, type McpToolProjection } from '../mcp/projection';
import { isReservedMcpServerName } from '../sdk-reserved-mcp';
import { RPC_MAX_FRAME_BYTES } from '../util/rpc-frame';

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('durable config requires an object');
  return value as Record<string, unknown>;
};
const string = (value: unknown): string => { if (typeof value !== 'string' || !value || /[\0\r\n]/u.test(value)) throw new Error('durable config requires a single-line string'); return value; };
function projection(expectedProvider: string, expectedModel: string) {
  const bytes = readFileSync(path.join(string(process.env.PI_CODING_AGENT_DIR), 'models.json'));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const parsed = object(JSON.parse(bytes.toString('utf8')));
  const providers = object(parsed.providers);
  if (Object.keys(parsed).length !== 1 || Object.keys(providers).length !== 1 || !Object.hasOwn(providers, expectedProvider)) throw new Error('durable provider projection differs from sealed selection');
  const provider = object(providers[expectedProvider]);
  if (Object.keys(provider).some(key => !['baseUrl','api','apiKey','authHeader','models'].includes(key)) || (provider.apiKey !== undefined && provider.apiKey !== '$PI_PROVIDER_API_KEY') || (provider.authHeader !== undefined && provider.authHeader !== true)) throw new Error('invalid durable provider projection');
  if (!Array.isArray(provider.models) || provider.models.length !== 1) throw new Error('durable requires one projected model');
  const entry = object(provider.models[0]);
  if (entry.id !== expectedModel || (provider.api !== 'openai-completions' && provider.api !== 'anthropic-messages')) throw new Error('durable projected model or API differs');
  const key = process.env.PI_PROVIDER_API_KEY;
  if (provider.apiKey !== undefined && !key) throw new Error('durable launcher credential missing');
  // Key lives in this model closure only. Neither shell, MCP nor replica receives it.
  for (const name of PROVIDER_CREDENTIAL_ENV_DENY_NAMES) delete process.env[name];
  delete process.env.PI_PROVIDER_API_KEY;
  return { provider, entry, key, digest };
}

export async function runPiDurableHost(argv: readonly string[]): Promise<void> {
  const { args, digest } = extractPiConfigDigest(argv);
  if (args.length !== 2 || args[0] !== '--config' || !path.isAbsolute(args[1]!)) throw new Error('durable accepts only --config <absolute path>');
  const config = object(readPiHostConfig(args[1]!, digest));
  if (config.format !== 'byok.pi.durable-launch' || config.version !== 1) throw new Error('unsupported durable launch config');
  const binding = requirePiHostBinding(config.binding);
  await verifyPiHostBinding(binding, 'pi-durable');
  const replica = object(config.replica);
  const agent = object(replica.agentRef);
  const authority: DurableReplicaBinding = { agentRef: { tenantId: string(agent.tenantId), agentId: string(agent.agentId), profileRevision: string(agent.profileRevision) }, taskId: string(replica.taskId), leaseId: string(replica.leaseId), canonicalHome: string(replica.canonicalHome) };
  const root = string(config.replicaRoot);
  const file = await admitReplica(root, authority);
  const expectedProvider = string(config.provider), expectedModel = string(config.model);
  const { provider, entry, key, digest: projectionDigest } = projection(expectedProvider, expectedModel);
  const api = provider.api as 'openai-completions' | 'anthropic-messages';
  const streams: ProviderStreams = api === 'openai-completions'
    ? await import('@earendil-works/pi-ai/api/openai-completions')
    : await import('@earendil-works/pi-ai/api/anthropic-messages');
  const model = { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...entry, api, provider: expectedProvider, baseUrl: string(provider.baseUrl) } as unknown as Model<typeof api>;
  const models = createModels(); models.setProvider(createProvider({ id: expectedProvider, models: [model], api: streams, auth: { apiKey: { name: 'BYOK launcher', resolve: async () => ({ auth: key ? { apiKey: key } : {} }) } } }));
  const fail = (message: string): never => { throw new Error(message); };
  const mcp = parseTaskScopedMcpConfig(config.mcp, fail);
  const pool = new McpServerPool(mcp, fail);
  const tools: ToolRegistration[] = [];
  const projected = projectMcpTools(mcp.observation);
  const reserved: McpToolProjection[] = [];
  for (const server of Object.keys(mcp.mcpServers).filter(isReservedMcpServerName).sort()) {
    for (const tool of await pool.observe(server)) reserved.push({ toolsetId: server, serverName: server, toolName: tool.name, description: tool.description, inputSchema: tool.inputSchema });
  }
  for (const [rows, naming] of [[projected, 'qualified'], [reserved, 'bare']] as const) {
    for (const tool of createPiMcpTools(rows, pool, naming)) tools.push({ name: tool.name, description: tool.description, parameters: tool.parameters as TSchema, replay: 'unsafe', execute: async (parameters, toolApi, ctx) => {
      const result = await tool.execute(toolApi.callId, parameters, ctx.abortSignal);
      return { content: result.content, details: { ...result.details }, isError: result.details.isError };
    } });
  }
  const write = (frame: unknown) => process.stdout.write(`${JSON.stringify(frame)}\n`);
  const admitted = new Set<string>();
  const toolIds = new Map<string, string>();
  const pending = new Map<string, { resolve(): void; reject(error: Error): void }>();
  let engine: Awaited<ReturnType<typeof openDurableEngine>> | undefined;
  let started = false;
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const rejectPending = () => { for (const promise of pending.values()) promise.reject(new Error('durable transport closed')); pending.clear(); };
  const cleanup = async () => { rejectPending(); if (engine) await engine.close(); await pool.close(); };
  lines.on('line', raw => {
    void (async () => {
      if (Buffer.byteLength(raw) > RPC_MAX_FRAME_BYTES) throw new Error('durable RPC frame exceeds limit');
      const command = object(JSON.parse(raw));
      const id = string(command.id), type = string(command.type);
      if (type === 'tool_ack') {
        const callId = string(command.toolCallId); const waiter = pending.get(callId);
        if (!waiter) throw new Error('unknown durable tool acknowledgement');
        pending.delete(callId); admitted.add(callId); waiter.resolve(); write({ type: 'response', id, success: true }); return;
      }
      if (type === 'abort') { if (engine) await engine.abort(); write({ type: 'response', id, success: true }); return; }
      if (type === 'close') { await cleanup(); write({ type: 'response', id, success: true }); lines.close(); return; }
      if (type !== 'start' || started || (command.resume !== false && command.resume !== true)) throw new Error('invalid durable start');
      if (command.resume === true && command.projectionDigest !== projectionDigest) throw new Error('durable provider projection drift on recovery');
      started = true;
      engine = await openDurableEngine({ file, replicaRoot: root, binding: authority, models, model: { provider: expectedProvider, modelId: expectedModel }, instruction: string(config.instruction), resume: command.resume, ambient: process.env, tools,
        beforeTool: (nativeId, toolCallId, call) => new Promise<void>((resolve, reject) => {
          toolIds.set(nativeId, toolCallId);
          pending.set(toolCallId, { resolve, reject }); write({ type: 'tool_intent', toolCallId });
          write({ type: 'agent_event', event: { type: 'tool_use', tool: call.name, toolCallId, input: call.arguments } });
        }),
        events: async events => { for (const event of events) {
          if (event.type === 'tool_execution_start') continue; // Hook supplies the durable task identity.
          const toolCallId = event.type === 'tool_execution_end' && event.toolCallId ? toolIds.get(event.toolCallId) : undefined;
          if (event.type === 'tool_execution_end' && event.entry !== undefined && toolCallId !== undefined && admitted.delete(toolCallId)) write({ type: 'tool_committed', toolCallId });
          for (const projectedEvent of projectDurableEvent(event)) {
            const normalized = projectedEvent.type === 'tool_result' && toolCallId ? { ...projectedEvent, toolCallId } : projectedEvent;
            write({ type: 'agent_event', event: normalized, ...(event.type === 'message_end' ? { usageId: String(event.entry.id) } : {}) });
          }
        } },
        result: async document => { write({ type: 'durable_result', document }); write({ type: 'durable_complete' }); },
      });
      write({ type: 'response', id, success: true, projectionDigest });
      void engine.run().catch(() => { write({ type: 'durable_failed' }); });
    })().catch(() => { write({ type: 'durable_failed' }); process.exitCode = 1; lines.close(); void cleanup(); });
  });
  await new Promise<void>(resolve => lines.once('close', resolve));
  await cleanup();
}
