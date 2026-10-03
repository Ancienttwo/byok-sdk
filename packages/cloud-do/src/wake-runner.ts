import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Conversation, Harness } from '@earendil-works/pi-durable';
import { composeCloudInput, inboxInput, type InboxRow, type RunHistory } from './cloud-state';
import { CloudDoError, safeCloudError, type CloudDoErrorCode } from './errors';
import { PLATFORM_PROFILES, platformCredentialReader } from './platform-credentials';
import type { CloudOperationGuard } from './input-guard';
import type { ExecutionLease, RunOutcome, SessionRuntime } from './session-runtime';

export type CloudWakeAdmission = { accepted: true; reservation: 'held' | 'none' }
  | { accepted: false; code: CloudDoErrorCode };
export type WakeAdmission = (items: readonly InboxRow[], signal: AbortSignal, key: string) => CloudWakeAdmission | Promise<CloudWakeAdmission>;

/** The timer also bounds a consumer that ignores the supplied abort signal. */
async function admittedBeforeDeadline(work: Promise<CloudWakeAdmission>, lease: ExecutionLease): Promise<CloudWakeAdmission> {
  let remove = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    const abort = () => reject(new CloudDoError(Date.now() >= lease.deadlineAt ? 'CLOUD_EXECUTION_TIMEOUT' : 'CLOUD_EXECUTION_ABORTED'));
    lease.controller.signal.addEventListener('abort', abort, { once: true });
    remove = () => lease.controller.signal.removeEventListener('abort', abort);
    if (lease.controller.signal.aborted) abort();
  });
  try { return await Promise.race([work, cancelled]); }
  finally { remove(); }
}

export async function cloudRunHistory(runtime: SessionRuntime, harness: Harness): Promise<RunHistory[]> {
  const history: RunHistory[] = [];
  for (const run of runtime.cloud.completedRuns()) {
    const conversation = await harness.conversation(run.conversationId as Conversation['id'], BACKGROUND_CONTEXT);
    if (!conversation) continue;
    const view = await conversation.context(BACKGROUND_CONTEXT);
    const input = run.trigger === 'wake'
      ? view.entries.find(entry => entry.kind === 'byok.run-input')?.data
      : view.entries.find(entry => entry.kind === 'pi.user')?.model?.find(message => message.role === 'user')?.content;
    const entry = [...view.entries].reverse().find(entry => entry.kind === 'pi.assistant');
    const reply = entry?.model?.find(message => message.role === 'assistant');
    if (input === undefined || reply?.role !== 'assistant') continue;
    history.push({ input, reply: reply.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') });
  }
  return history;
}

export async function committedRunOutcome(conversation: Conversation, runtime: SessionRuntime,
  status: string, detail?: unknown): Promise<RunOutcome> {
  const view = await conversation.context(BACKGROUND_CONTEXT);
  const entry = [...view.entries].reverse().find(entry => entry.kind === 'pi.assistant');
  const last = entry?.model?.find(message => message.role === 'assistant');
  const failure = runtime.fatal(conversation.id)
    ?? (last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'aborted')
      ? safeCloudError(new Error(last.errorMessage)).code : undefined)
    ?? (status !== 'done' ? safeCloudError(new Error(typeof detail === 'string' ? detail : '')).code : undefined);
  if (failure) return { state: 'failed', errorCode: failure };
  return { state: 'completed', entryId: entry?.id,
    text: last?.role === 'assistant' ? last.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') : '' };
}

/** Each invocation of this function owns a fresh conversation and one shared runtime lease. */
export async function runCloudWake(runtime: SessionRuntime, harness: Harness,
  env: Readonly<Record<string, unknown>>, admit: WakeAdmission, notify: () => void): Promise<void> {
  const guard = await runtime.prepareGuard();
  let lease: ExecutionLease | undefined;
  let conversation: Conversation | undefined;
  let selected: InboxRow[] = [];
  let settling = false;
  try {
    runtime.cloud.expireQueued(guard);
    runtime.cloud.retention();
    selected = runtime.cloud.selectBatch(Date.now(), guard);
    notify();
    if (!selected.length) { await runtime.cloud.rearmAlarm({ busy: runtime.busy, repairRetrying: runtime.repairRetrying }); return; }
    lease = runtime.reserve(selected[0]!.profile, guard);
    const profile = PLATFORM_PROFILES[lease.profile];
    conversation = await harness.createConversation({ ownership: { kind: 'ownerless' },
      agent: { model: { provider: lease.profile, modelId: profile.model } } }, BACKGROUND_CONTEXT);
    runtime.attach(lease, conversation.id, 'wake', guard);
    runtime.markReservation(conversation.id, 'pending');
    const key = runtime.cloud.readRun(conversation.id)!.requestId!;
    const admission = await admittedBeforeDeadline(Promise.resolve().then(() => admit(Object.freeze(selected.map(row => Object.freeze({ ...row }))), lease!.controller.signal, key)), lease);
    if (!admission || typeof admission !== 'object' || typeof admission.accepted !== 'boolean') throw new CloudDoError('CLOUD_REQUEST_INVALID');
    if (!admission.accepted) {
      runtime.markReservation(conversation.id, 'none');
      throw safeCloudError(new Error(admission.code));
    }
    if (admission.reservation !== 'held' && admission.reservation !== 'none') throw new CloudDoError('CLOUD_REQUEST_INVALID');
    runtime.markReservation(conversation.id, admission.reservation);
    await platformCredentialReader(env).get(profile.secretName);
    const claimed = runtime.claimWake(lease, selected.map(row => row.seq));
    notify();
    if (!claimed.length) {
      const closed = runtime.cloud.readRun(conversation.id);
      if (closed?.errorCode && closed.errorCode !== 'CLOUD_WAKE_EMPTY') throw new CloudDoError(closed.errorCode);
      return;
    }
    const inputs = { items: inboxInput(claimed) };
    const data = JSON.parse(guard.guardPayload(JSON.stringify(inputs)));
    await conversation.commit(tx => tx.appendEntry(conversation!.id, { kind: 'byok.run-input', data }), BACKGROUND_CONTEXT);
    const content = composeCloudInput(claimed, await cloudRunHistory(runtime, harness));
    guard.guardText(content);
    const submission = await conversation.submit({ type: 'input', content, whenBusy: 'reject', requestId: key }, BACKGROUND_CONTEXT);
    runtime.recordSubmission(conversation.id, submission.id);
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    await conversation.waitForIdle(BACKGROUND_CONTEXT);
    const outcome = await committedRunOutcome(conversation, runtime, settled.status, settled.status === 'unanswered' ? settled.detail : undefined);
    settling = true;
    await runtime.settle(lease, outcome);
  } catch (error) {
    if (!lease || error instanceof CloudDoError && error.code === 'CLOUD_TOOL_BUSY') {
      if (error instanceof CloudDoError && error.code === 'CLOUD_TOOL_BUSY') return;
      throw safeCloudError(error);
    }
    // Infrastructure failures retain the running claim for alarm repair. Do not replace a completed pi outcome.
    if (settling || !(error instanceof CloudDoError)) throw safeCloudError(error);
    const code = runtime.fatal(lease.conversationId!) ?? safeCloudError(error).code;
    runtime.cloud.failQueued(selected.map(row => row.seq), code, guard);
    if (conversation && runtime.cloud.readRun(conversation.id)?.state === 'running') {
      runtime.cancel(lease, code);
      await conversation.abort(BACKGROUND_CONTEXT, { background: true });
      await conversation.waitForIdle(BACKGROUND_CONTEXT);
    }
    if (conversation) {
      settling = true;
      await runtime.settle(lease, { state: 'interrupted', errorCode: code });
    }
    notify();
  } finally {
    if (lease) await runtime.release(lease);
    else guard.dispose();
  }
}
