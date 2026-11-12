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
const closeFields = { closeObservedAt: z.number().nonnegative(), exitCode: z.number().int().nullable(), signal: z.string().nullable() };
const treeSchema = z.discriminatedUnion('mechanism', [
  z.object({ state: z.literal('observed'), mechanism: z.literal('posix-process-group'), processGroupId: z.number().int().positive(), verifiedAt: z.number().nonnegative() }),
  z.object({ state: z.literal('observed'), mechanism: z.literal('windows-taskkill'), pid: z.number().int().positive(), verifiedAt: z.number().nonnegative() }),
]);
const instanceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('runner'), processInstanceId: z.string().min(1), ...closeFields }),
  z.object({ kind: z.literal('pi-writer'), processInstanceId: z.string().min(1), ...closeFields,
    attempt: z.number().int().nonnegative(), processTree: treeSchema }),
]);
const processProofSchema = z.object({
  version: z.literal(1), runId: z.string().min(1), runnerProcessInstanceId: z.string().min(1),
  state: z.enum(['pending', 'not-started', 'observed', 'unknown']),
  observedAt: z.number().nonnegative().optional(),
  instances: z.array(instanceSchema).optional(),
  canonicalSession: z.object({ canonicalSessionId: z.string().min(1), leaseDisposition: z.enum(['released', 'not-held']),
    freeAtObservation: z.literal(true), canonicalSessionLeaseReleased: z.literal(true).optional() }).optional(),
}).refine(proof => proof.state !== 'observed' || (proof.observedAt !== undefined
  && proof.instances?.some(instance => instance.kind === 'runner' && instance.processInstanceId === proof.runnerProcessInstanceId)));
const stopSchema = z.object({ runId: z.string().min(1), state: z.literal('stopping') });
const statusSchema = z.object({ details: z.object({
  lifecycleStatus: z.object({ processTerminal: processProofSchema }).optional(),
  workflowTerminalProof: z.object({
    version: z.literal(1), kind: z.literal('workflow'), runId: z.string().min(1),
    state: z.enum(['pending', 'observed', 'unknown']), dispatchClosed: z.boolean(), observedAt: z.number().nonnegative().optional(),
    children: z.array(processProofSchema).optional(),
  }).refine(proof => proof.state !== 'observed' || proof.observedAt !== undefined).optional(),
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
  const request = (method: 'status' | 'stop', signal: AbortSignal, params?: { id: string }) => new Promise<z.infer<typeof replySchema>>((resolve, reject) => {
    if (signal.aborted) { reject(refusal()); return; }
    const requestId = randomUUID();
    const finish = (result: Error | z.infer<typeof replySchema>): void => {
      signal.removeEventListener('abort', expired); unsubscribe(); pending.delete(fail);
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
    const expired = (): void => finish(refusal());
    signal.addEventListener('abort', expired, { once: true });
    pending.add(fail);
    events.emit(`${PREFIX}request`, { version: 1, requestId, method, ...(params === undefined ? {} : { params }) });
  });
  const status = async (signal: AbortSignal, params?: { id: string }): Promise<unknown> => {
    const reply = await request('status', signal, params);
    if (!reply.success) throw refusal();
    return reply.data;
  };
  const stopAndAwait = async (signal: AbortSignal): Promise<void> => {
    if (!ready) { if (launchEpoch !== 0) throw refusal(); return; }
    const targets = new Map<string, { active: boolean; instance?: string }>();
    const stopped = new Set<string>();
    while (true) {
      const epoch = launchEpoch;
      const snapshot = decode(snapshotSchema, await status(signal));
      for (const run of snapshot.asyncSnapshot.runs) {
        const target = targets.get(run.id) ?? { active: false };
        target.active = run.state === 'queued' || run.state === 'running';
        targets.set(run.id, target);
      }
      for (const [id, target] of targets) {
        const details = decode(statusSchema, await status(signal, { id })).details;
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
          const reply = await request('stop', signal, { id });
          // A child can finish between status and stop; only its subsequent terminal proof can settle it.
          if (!reply.success && reply.error.code !== 'invalid_state' && reply.error.code !== 'not_found') throw refusal();
          if (reply.success) {
            if (decode(stopSchema, reply.data).runId !== id) throw refusal();
            stopped.add(id);
          }
        }
      }
      if (targets.size === 0 && launching.size === 0 && epoch === launchEpoch) return;
      await delay(25, undefined, { signal });
    }
  };
  return { factory, bind(session) {
    const abort = session.abort.bind(session);
    let interrupt: Promise<void> | undefined;
    session.abort = () => {
      if (interrupt === undefined) {
        const controller = new AbortController();
        const expired = new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(refusal()), { once: true });
        });
        const timer = setTimeout(() => controller.abort(), 15_000);
        interrupt = Promise.race([Promise.all([abort(), stopAndAwait(controller.signal)]), expired]).then(() => undefined)
          .finally(() => { clearTimeout(timer); controller.abort(); interrupt = undefined; });
      }
      return interrupt;
    };
  } };
}
