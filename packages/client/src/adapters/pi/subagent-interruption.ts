import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { CreateAgentSessionResult, ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent';

const PREFIX = 'subagents:rpc:v1:';
const refusal = (): Error => new Error('pi_subagent_interrupt_unverified: native subagent termination could not be verified');
const replySchema = z.discriminatedUnion('success', [
  z.object({ version: z.literal(1), requestId: z.string(), success: z.literal(true), data: z.unknown() }),
  z.object({ version: z.literal(1), requestId: z.string(), success: z.literal(false), error: z.object({ code: z.string() }) }),
]);
const snapshotSchema = z.object({ asyncSnapshot: z.object({
  kind: z.literal('pi-subagents.async-status-snapshot'), version: z.literal(1),
  omitted: z.object({ runs: z.literal(0), byteLimitExceeded: z.literal(false) }),
  runs: z.array(z.object({ id: z.string().min(1),
    state: z.enum(['queued', 'running', 'complete', 'failed', 'partial', 'paused', 'stopped', 'rejected']),
    kind: z.enum(['subagent', 'workflow']) })),
}) });
const processProofSchema = z.object({
  version: z.literal(1), runId: z.string().min(1), runnerProcessInstanceId: z.string().min(1),
  state: z.enum(['pending', 'not-started', 'observed', 'unknown']),
  observedAt: z.number().optional(),
  instances: z.array(z.object({ kind: z.enum(['runner', 'pi-writer']), processInstanceId: z.string().min(1) })).optional(),
}).refine(proof => proof.state !== 'observed' || (proof.observedAt !== undefined
  && proof.instances?.some(instance => instance.kind === 'runner' && instance.processInstanceId === proof.runnerProcessInstanceId)));
const stopSchema = z.object({ runId: z.string().min(1), state: z.literal('stopping') });
const statusSchema = z.object({ details: z.object({
  lifecycleStatus: z.object({ processTerminal: processProofSchema }).optional(),
  workflowTerminalProof: z.object({
    version: z.literal(1), kind: z.literal('workflow'), runId: z.string().min(1),
    state: z.enum(['pending', 'observed', 'unknown']), dispatchClosed: z.boolean(),
    children: z.array(processProofSchema).optional(),
  }).optional(),
}) });
function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw refusal();
  return result.data;
}

/** A session-local owner of the documented pi-subagents control RPC, including packaged copies. */
export function createPiSubagentAbortBoundary(): {
  factory: ExtensionFactory;
  bind(session: CreateAgentSessionResult['session']): void;
} {
  let events: ExtensionAPI['events'];
  let ready = false, launchEpoch = 0;
  const launching = new Set<string>();
  const pending = new Set<(error: Error) => void>();
  const factory: ExtensionFactory = pi => {
    events = pi.events;
    const unsubscribe = events.on(`${PREFIX}ready`, () => { ready = true; });
    const unsubscribeStarted = events.on('subagent:async-started', () => { launchEpoch += 1; });
    pi.on('tool_execution_start', event => { if (event.toolName === 'subagent') { launching.add(event.toolCallId); launchEpoch += 1; } });
    pi.on('tool_execution_end', event => { if (launching.delete(event.toolCallId)) launchEpoch += 1; });
    pi.on('session_shutdown', () => {
      ready = false; unsubscribe(); unsubscribeStarted();
      for (const reject of pending) reject(refusal());
    });
  };
  const request = (method: 'status' | 'stop', params?: { id: string }) => new Promise<z.infer<typeof replySchema>>((resolve, reject) => {
    const requestId = randomUUID();
    const finish = (result: Error | z.infer<typeof replySchema>): void => {
      clearTimeout(timer); unsubscribe(); pending.delete(fail);
      if (result instanceof Error) reject(result); else resolve(result);
    };
    const fail = (error: Error): void => finish(error);
    const unsubscribe = events.on(`${PREFIX}reply:${requestId}`, value => {
      try {
        const reply = decode(replySchema, value);
        if (reply.requestId !== requestId) throw refusal();
        finish(reply);
      } catch { finish(refusal()); }
    });
    const timer = setTimeout(() => finish(refusal()), 15_000);
    pending.add(fail);
    events.emit(`${PREFIX}request`, { version: 1, requestId, method, ...(params === undefined ? {} : { params }) });
  });
  const status = async (params?: { id: string }): Promise<unknown> => {
    const reply = await request('status', params);
    if (!reply.success) throw refusal();
    return reply.data;
  };
  const stopAndAwait = async (): Promise<void> => {
    if (!ready) return;
    const deadline = Date.now() + 15_000;
    const targets = new Map<string, { active: boolean; instance?: string }>();
    const stopped = new Set<string>();
    while (true) {
      const epoch = launchEpoch;
      const snapshot = decode(snapshotSchema, await status());
      for (const run of snapshot.asyncSnapshot.runs) {
        const target = targets.get(run.id) ?? { active: false };
        target.active = run.state === 'queued' || run.state === 'running';
        targets.set(run.id, target);
      }
      for (const [id, target] of targets) {
        const details = decode(statusSchema, await status({ id })).details;
        const workflow = details.workflowTerminalProof;
        const proof = details.lifecycleStatus?.processTerminal;
        if (workflow) {
          if (workflow.runId !== id || workflow.state === 'unknown') throw refusal();
          if (workflow.state === 'observed') {
            if (!workflow.dispatchClosed || !workflow.children || workflow.children.some(child => child.state !== 'observed')) throw refusal();
            targets.delete(id); continue;
          }
        } else if (proof) {
          if (proof.runId !== id || proof.state === 'unknown' || (target.instance !== undefined && proof.runnerProcessInstanceId !== target.instance)) throw refusal();
          target.instance = proof.runnerProcessInstanceId;
          if (proof.state === 'observed') { targets.delete(id); continue; }
        }
        if (target.active && !stopped.has(id)) {
          const reply = await request('stop', { id });
          // A child can finish between status and stop; only its subsequent terminal proof can settle it.
          if (!reply.success && reply.error.code !== 'invalid_state' && reply.error.code !== 'not_found') throw refusal();
          if (reply.success) {
            if (decode(stopSchema, reply.data).runId !== id) throw refusal();
            stopped.add(id);
          }
        }
      }
      if (targets.size === 0 && launching.size === 0 && epoch === launchEpoch) return;
      if (Date.now() >= deadline) throw refusal();
      await delay(25);
    }
  };
  return { factory, bind(session) {
    const abort = session.abort.bind(session);
    let interrupt: Promise<void> | undefined;
    session.abort = () => {
      if (interrupt === undefined) interrupt = Promise.all([abort(), stopAndAwait()]).then(() => undefined).finally(() => { interrupt = undefined; });
      return interrupt;
    };
  } };
}
