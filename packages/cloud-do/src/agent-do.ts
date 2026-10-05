import { DurableObject } from 'cloudflare:workers';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, watchEvents, type AgentEvent, type ConversationId, type EntryRecord } from '@earendil-works/pi-durable';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { admitCloudSubmission } from './admission';
import { CloudDoError, cloudErrorResponse, type CloudDoErrorCode } from './errors';
import { PLATFORM_PROFILES, platformCredentialReader, type PlatformProfileId } from './platform-credentials';
import { admitCloudText } from './input-guard';
import { SessionRuntime, type CloudRenewRequest, type CloudRenewResult, type CloudRunSettlement, type ExecutionLease } from './session-runtime';
import type { CloudToolDispatcher } from './tools';
import type { InvocationTerminalState, InvocationRow } from './invocation-ledger';
import { admitCloudInbox } from './inbox-admission';
import { runInputSeqs, utf8Prefix, type AdmissionIdentity, type InboxRow, type TranscriptCursor, type TranscriptRun } from './cloud-state';
import { CloudEventDoorbell, CloudEventStreams } from './event-stream';
import { runCloudWake, committedRunOutcome, type CloudWakeAdmission } from './wake-runner';
import { safeCloudError } from './errors';

export { CLOUD_HARNESS_SETTINGS } from './session-runtime';

function modelFailureCode(message: string | undefined): CloudDoErrorCode {
  return safeCloudError(new Error(message)).code;
}

function assistantText(message: AssistantMessage): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
}

function finalAssistant(entries: readonly EntryRecord[]) {
  const entry = [...entries].reverse().find(entry => entry.kind === 'pi.assistant'
    && entry.model?.some(message => message.role === 'assistant' && message.stopReason !== 'toolUse'));
  const assistant = entry?.model?.find(message => message.role === 'assistant' && message.stopReason !== 'toolUse');
  return assistant?.role === 'assistant' && entry ? { entry, assistant } : undefined;
}

function inputTexts(entries: readonly EntryRecord[]): Map<number, string> {
  const seqs = new Set(runInputSeqs(entries));
  if (!seqs.size) return new Map();
  const data = entries.find(entry => entry.kind === 'byok.run-input')?.data as {items?:{seq:number;text:string}[]} | undefined;
  return new Map((data?.items ?? []).filter(item => seqs.has(item.seq)).map(item => [item.seq,item.text]));
}

/** RPC options accept data properties only. */
function transcriptRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new CloudDoError('CLOUD_REQUEST_INVALID');
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !keys.includes(key) || !field?.enumerable || !('value' in field)) throw new CloudDoError('CLOUD_REQUEST_INVALID');
    result[key] = field.value;
  }
  return result;
}

/** Native watch batches can contain a whole message, a block, or a delta. */
function projectText(blocks: Map<number, string>, event: AgentEvent): string | undefined {
  const replace = (message: AssistantMessage) => {
    blocks.clear();
    message.content.forEach((block, index) => { if (block.type === 'text') blocks.set(index, block.text); });
  };
  if (event.type === 'message_start' && event.message.role === 'assistant') replace(event.message);
  else if (event.type === 'snapshot' && event.generation?.message) replace(event.generation.message);
  else if (event.type === 'message_update') {
    for (const change of event.changes) {
      if (change.type === 'text_delta') blocks.set(change.contentIndex, (blocks.get(change.contentIndex) ?? '') + change.delta);
      if (change.type === 'text_start' || change.type === 'block') {
        if (change.block.type === 'text') blocks.set(change.contentIndex, change.block.text);
        else blocks.delete(change.contentIndex);
      }
      if (change.type === 'message') replace(change.message);
    }
  } else if (event.type === 'message_end' && event.entry.model?.[0]?.role === 'assistant') return assistantText(event.entry.model[0]);
  else return undefined;
  return [...blocks.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join('');
}

/** One named DO owns one Harness; 4b adds platform-only text model submissions. */
export class AgentDO extends DurableObject<Record<string, unknown>> {
  #runtime?: SessionRuntime;
  #doorbell = new CloudEventDoorbell();
  #eventStreams = new CloudEventStreams(this.#doorbell);

  /** The consuming Worker supplies trusted code. No executable function is persisted. */
  protected createDispatcher(_id: string): CloudToolDispatcher | undefined { return undefined; }

  /** Post-commit notification. Consumer failures never change the invocation outcome. */
  protected onInvocationSettled(_id: string, _state: InvocationTerminalState): void | Promise<void> {}

  protected projectInvocation(_row: InvocationRow): { key: string; dataJson: string } | undefined { return undefined; }

  /** The consumer owns billing truth and fences every pending admission key on release. */
  protected admitWake(_items: readonly InboxRow[], _signal: AbortSignal, _key: string, _admission: AdmissionIdentity): CloudWakeAdmission | Promise<CloudWakeAdmission> {
    return { accepted: true, reservation: 'none' };
  }

  protected instructions(_profile: PlatformProfileId): string | undefined { return undefined; }
  protected renew(_request: CloudRenewRequest, _signal: AbortSignal): CloudRenewResult | Promise<CloudRenewResult> { return { ok: true }; }
  protected settleRun(_run: CloudRunSettlement, _signal: AbortSignal): void | Promise<void> {}

  protected sessionRuntime(): SessionRuntime {
    return this.#runtime ??= new SessionRuntime(this.ctx, this.env, {
      createDispatcher: id => this.createDispatcher(id),
      projectInvocation: row => this.projectInvocation(row),
      onCommit: () => this.#doorbell.ring(),
      onInvocationSettled: (id, state) => this.onInvocationSettled(id, state),
      instructions: profile => this.instructions(profile),
      renew: (request, signal) => this.renew(request, signal),
      settleRun: (run, signal) => this.settleRun(run, signal),
    });
  }

  async configureSession(input: unknown): Promise<Response> {
    try { await this.sessionRuntime().configure(input); return Response.json({ configured: true }); }
    catch (error) { return cloudErrorResponse(error); }
  }

  async readInvocation(id: string) {
    await this.sessionRuntime().ready();
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new CloudDoError('CLOUD_REQUEST_INVALID');
    return this.sessionRuntime().readInvocation(id);
  }

  async enqueue(input: unknown): Promise<Response> {
    let guard;
    try {
      const admitted = admitCloudInbox(input);
      const runtime = this.sessionRuntime();
      guard = await runtime.prepareGuard();
      runtime.cloud.validateEnqueue(admitted, guard);
      await runtime.ready();
      const result = await runtime.cloud.enqueue(admitted, guard, Date.now(), {
        busy: runtime.hasLiveOwner, repairRetrying: runtime.repairRetrying,
      });
      this.#doorbell.ring();
      return Response.json({ accepted: result.accepted, ...result.row });
    } catch (error) { return cloudErrorResponse(error); }
    finally { guard?.dispose(); }
  }

  /** The platform supplies retryCount. This handler never replaces a live owner. */
  async alarm(info?: AlarmInvocationInfo): Promise<void> {
    const runtime = this.sessionRuntime();
    let harness: Harness;
    try { harness = await runtime.ready(); }
    catch (error) {
      // A rejected recovery promise is cached. Only a restart can recover it.
      if (runtime.recovering) return;
      throw safeCloudError(error);
    }
    if (runtime.hasLiveOwner) {
      const guard = runtime.activeLease?.guard;
      if (guard) runtime.cloud.expireQueued(guard);
      runtime.cloud.retention();
      this.#doorbell.ring();
      // Settlement debt has no lease and may progress while unrelated native work is live.
      if (runtime.cloud.unackedRuns().length) await runtime.deliverSettlementsForAlarm(info?.retryCount ?? 0,guard);
      else await runtime.cloud.rearmAlarm({ busy: true, repairRetrying: runtime.repairRetrying });
      return;
    }
    try {
      await runtime.repairPendingRuns(info?.retryCount ?? 0);
      if (runtime.busy) return;
      const woke = await runCloudWake(runtime, harness, this.env, (items, signal, key, admission) => this.admitWake(items, signal, key, admission),
        () => this.#doorbell.ring(),info?.retryCount ?? 0);
      if (!woke) await runtime.deliverSettlementsForAlarm(info?.retryCount ?? 0);
    } catch (error) { throw safeCloudError(error); }
  }

  async events(input: { after?: number } = {}): Promise<Response> {
    try {
      const fields = this.#readOptions(input, ['after']);
      const runtime = this.sessionRuntime();
      await runtime.ready();
      return this.#eventStreams.open(runtime.cloud, fields.after, work => this.ctx.waitUntil(work));
    } catch (error) { return cloudErrorResponse(error); }
  }

  async readSnapshot() { await this.sessionRuntime().ready(); return this.sessionRuntime().cloud.snapshot(); }
  async readRuns(input: { after?: number; limit?: number } = {}) {
    await this.sessionRuntime().ready(); return this.sessionRuntime().cloud.readRuns(this.#readOptions(input, ['after', 'limit']));
  }
  async readInbox(input: { after?: number; limit?: number } = {}) {
    await this.sessionRuntime().ready(); return this.sessionRuntime().cloud.readInbox(this.#readOptions(input, ['after', 'limit']));
  }
  async readInvocations(input: { after?: number; limit?: number } = {}) {
    await this.sessionRuntime().ready(); return this.sessionRuntime().cloud.readInvocations(this.#readOptions(input, ['after', 'limit']));
  }
  async readTranscript(input: { after?: TranscriptCursor; limit?: number } = {}) {
    const options = transcriptRecord(input, ['after','limit']);
    const limit = options.limit === undefined ? 20 : options.limit;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new CloudDoError('CLOUD_REQUEST_INVALID');
    let after: TranscriptCursor | undefined;
    if (options.after !== undefined) {
      const cursor = transcriptRecord(options.after, ['horizon','run','item']);
      if (Object.keys(cursor).length !== 3 || typeof cursor.horizon !== 'number' || !Number.isSafeInteger(cursor.horizon) || cursor.horizon < 0
        || [cursor.run,cursor.item].some(value => value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0))) {
        throw new CloudDoError('CLOUD_REQUEST_INVALID');
      }
      after = cursor as unknown as TranscriptCursor;
    }
    const runtime = this.sessionRuntime();
    const harness = await runtime.ready();
    const plan = runtime.cloud.planTranscript(after,limit);
    const contexts = new Map<number, Promise<readonly EntryRecord[]>>();
    const entries = (id: number): Promise<readonly EntryRecord[]> => {
      const cached = contexts.get(id);
      if (cached) return cached;
      const read = harness.conversation(id as ConversationId, BACKGROUND_CONTEXT).then(async conversation =>
        conversation ? (await conversation.context(BACKGROUND_CONTEXT)).entries : []).catch(error => {
          if (runtime.cloud.readRun(id)?.membershipPending === 1) return [];
          throw error;
        });
      contexts.set(id,read);
      return read;
    };
    const runs: TranscriptRun[] = [];
    for (const {run,turns,invocations} of plan.runs) {
      const claimedSeqs = runtime.cloud.claimedSeqs(run.conversationId);
      const view = await entries(run.conversationId);
      const texts = inputTexts(view);
      const final = finalAssistant(view);
      const result: TranscriptRun = { nativeRunId: run.conversationId, revision: run.revision, state: run.state,
        errorCode: run.errorCode, trigger: run.trigger, settlementAck: run.settlementAck === null || run.settlementAck === 1,
        claimedSeqs, turns: turns.map(turn => ({ ...turn, text: texts.get(turn.seq) ?? turn.text })), invocations };
      if (final) {
        const text = assistantText(final.assistant);
        const truncated = new TextEncoder().encode(text).length > 16_384;
        result.text = truncated ? utf8Prefix(text,1024) : text;
        if (truncated) result.truncated = true;
      }
      runs.push(result);
    }
    for (const item of plan.items) if (item.text === null && item.runId !== null) {
      item.text = inputTexts(await entries(item.runId)).get(item.seq) ?? null;
    }
    return { runs, items: plan.items, next: plan.next };
  }
  #readOptions(input: unknown, allowed: readonly string[]): Record<string, number | undefined> {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) throw new CloudDoError('CLOUD_REQUEST_INVALID');
    const result: Record<string, number | undefined> = {};
    for (const key of Reflect.ownKeys(input)) {
      const field = Object.getOwnPropertyDescriptor(input, key);
      if (typeof key !== 'string' || !allowed.includes(key) || !field?.enumerable || !('value' in field)
        || (field.value !== undefined && typeof field.value !== 'number')) throw new CloudDoError('CLOUD_REQUEST_INVALID');
      result[key] = field.value;
    }
    return result;
  }

  async readRunOutput(conversationId: number, input: { entryId?: number; offset?: number } = {}) {
    if (!Number.isSafeInteger(conversationId) || conversationId < 2) throw new CloudDoError('CLOUD_REQUEST_INVALID');
    const options = this.#readOptions(input, ['entryId', 'offset']);
    const runtime = this.sessionRuntime();
    const harness = await runtime.ready();
    if (!runtime.cloud.readRun(conversationId)) throw new CloudDoError('CLOUD_REQUEST_INVALID');
    const conversation = await harness.conversation(conversationId as ConversationId, BACKGROUND_CONTEXT);
    if (!conversation) throw new CloudDoError('CLOUD_REQUEST_INVALID');
    const context = await conversation.context(BACKGROUND_CONTEXT);
    const final = finalAssistant(context.entries);
    if (!final || (options.entryId !== undefined && options.entryId !== final.entry.id)) throw new CloudDoError('CLOUD_REQUEST_INVALID');
    const {entry,assistant} = final;
    const bytes = new TextEncoder().encode(assistantText(assistant));
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length
      || (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80)) throw new CloudDoError('CLOUD_REQUEST_INVALID');
    let end = Math.min(bytes.length, offset + 65_536);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    return { entryId: entry.id, offset, nextOffset: end, done: end === bytes.length,
      text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(offset, end)) };
  }

  async cancelActiveRun(): Promise<Response> {
    try { const runtime = this.sessionRuntime(); await runtime.ready(); return Response.json({ cancelled: runtime.cancelActive() }); }
    catch (error) { return cloudErrorResponse(error); }
  }
  async cancelInboxItem(seq: number): Promise<Response> {
    let guard;
    try {
      if (!Number.isSafeInteger(seq) || seq < 1) throw new CloudDoError('CLOUD_REQUEST_INVALID');
      const runtime = this.sessionRuntime(); await runtime.ready();
      const row = runtime.cloud.readInboxItem(seq);
      if (!row) throw new CloudDoError('CLOUD_REQUEST_INVALID');
      if (row.state === 'running') {
        if (runtime.activeLease?.conversationId === row.runId) runtime.cancelActive();
      } else if (row.state === 'queued') {
        guard = await runtime.prepareGuard(); runtime.cloud.cancelQueued(seq, guard);
      }
      await runtime.cloud.rearmAlarm({ busy: runtime.hasLiveOwner, repairRetrying: runtime.repairRetrying });
      this.#doorbell.ring();
      return Response.json({ item: runtime.cloud.readInboxItem(seq) });
    } catch (error) { return cloudErrorResponse(error); }
    finally { guard?.dispose(); }
  }

  // Admission and credential preflight happen before even schema initialization.
  #harness(): Promise<Harness> {
    return this.sessionRuntime().open();
  }

  async open() {
    const harness = await this.#harness();
    return { scheduling: (await harness.inspect(BACKGROUND_CONTEXT)).scheduling };
  }

  /** D1: every call allocates a new ownerless conversation, including after a restart. */
  async openExecution(): Promise<{ conversationId: number }> {
    const harness = await this.#harness();
    const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
    return { conversationId: conversation.id };
  }

  async #execution(id: number) {
    if (!Number.isSafeInteger(id) || id < 2) throw new Error('Invalid execution conversation');
    const conversation = await (await this.#harness()).conversation(id as ConversationId, BACKGROUND_CONTEXT);
    if (!conversation) throw new Error('Unknown execution conversation');
    return conversation;
  }

  async #admitText(text: string, selected?: PlatformProfileId): Promise<void> {
    await admitCloudText(this.env, text, selected);
  }

  /** Passive native pi entries prove storage without starting a model or tool task. */
  async appendExecution(conversationId: number, text: string): Promise<void> {
    if (typeof text !== 'string') throw new Error('Execution text must be a string');
    await this.#admitText(text);
    const conversation = await this.#execution(conversationId);
    await conversation.commit(tx => tx.appendEntry(conversation.id, { kind: 'byok.execution', data: { text } }), BACKGROUND_CONTEXT);
  }

  async readExecution(conversationId: number): Promise<string[]> {
    const conversation = await this.#execution(conversationId);
    const context = await conversation.context(BACKGROUND_CONTEXT);
    return context.entries.filter(entry => entry.kind === 'byok.execution').map(entry => {
      const data = entry.data as { text: string };
      return data.text;
    });
  }

  /** Binding/RPC-only. The consumer authorizes identity before obtaining this stub.
   * Errors are structured Responses so the same code/status survive DO RPC. */
  async submit(input: unknown): Promise<Response> {
    let lease: ExecutionLease | undefined;
    let guard;
    try {
      const admitted = admitCloudSubmission(input);
      const profile = PLATFORM_PROFILES[admitted.profile];
      await platformCredentialReader(this.env).get(profile.secretName);
      // Check every configured platform key before input enters durable storage.
      await this.#admitText(admitted.instruction, admitted.profile);
      const runtime = this.sessionRuntime();
      const harness = await runtime.ready(admitted.profile);
      guard = await runtime.prepareGuard(admitted.profile);
      lease = runtime.reserve(admitted.profile, guard);
      const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' },
        agent: runtime.agentChange(admitted.profile, guard) }, BACKGROUND_CONTEXT);
      const execution = lease;
      runtime.attach(execution, conversation.id);
      const events = await watchEvents(harness, conversation.id, BACKGROUND_CONTEXT);
      const encoder = new TextEncoder();
      // Native byte-stream backpressure/cancellation survives DO RPC transfer.
      const body = new IdentityTransformStream();
      const writer = body.writable.getWriter();
      let cancelled = false;
      let aborting: Promise<void> | undefined;
      let failure: string | undefined;
      let released = '';
      const textBlocks = new Map<number, string>();
      const cancel = () => {
        if (!aborting) {
          cancelled = true;
          runtime.cancel(execution);
          // A disconnected consumer has no error channel. Do not expose a raw exception.
          aborting = conversation.abort(BACKGROUND_CONTEXT).finally(() => events.stop()).catch(() => undefined);
        }
        return aborting;
      };
      void writer.closed.catch(cancel);
      const write = async (value: unknown) => {
        if (cancelled) return;
        try { await writer.write(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)); }
        catch { void cancel(); }
      };
      // A transferred native stream reports a disconnected peer on its next
      // write. Keep one request-scoped probe in flight. This is not a DO alarm.
      let probing = false;
      const probe = setInterval(() => {
        if (cancelled || probing) return;
        probing = true;
        void writer.write(encoder.encode(': keepalive\n\n')).catch(() => cancel()).finally(() => { probing = false; });
      }, 250);
      const publish = async (text: string) => {
        if (text.startsWith(released) && text.length > released.length) {
          const delta = text.slice(released.length);
          released = text;
          await write({ type: 'text_delta', delta });
        }
      };
      events.start(async batch => {
        for (const event of batch) {
          if (event.type === 'message_start' && event.message.role === 'assistant') released = '';
          const text = projectText(textBlocks, event);
          if (text !== undefined) await publish(text);
          if (event.type === 'message_end') {
            const message = event.entry.model?.[0];
            if (message?.role === 'assistant' && message.stopReason === 'error') {
              failure = modelFailureCode(message.errorMessage);
            }
          }
          if (event.type === 'task_failed') failure ??= runtime.fatal(conversation.id) ?? 'CLOUD_MODEL_REQUEST_FAILED';
        }
      });
      const run = async () => {
        let outcomeWriting = false;
        try {
          const submission = await conversation.submit({ type: 'input', content: admitted.instruction, whenBusy: 'reject', requestId: runtime.cloud.readRun(conversation.id)!.requestId! }, BACKGROUND_CONTEXT);
          runtime.recordSubmission(conversation.id, submission.id);
          const settled = await submission.wait(BACKGROUND_CONTEXT);
          await conversation.waitForIdle(BACKGROUND_CONTEXT);
          const stopped = await events.stop();
          // Backpressure can leave a final watch batch undelivered. Native
          // committed state is the authority for the final text and error code.
          const context = await conversation.context(BACKGROUND_CONTEXT);
          const last = [...context.entries].reverse().find(entry => entry.kind === 'pi.assistant')?.model?.[0];
          if (last?.role === 'assistant') {
            await publish(assistantText(last));
            if (last.stopReason === 'error') failure = modelFailureCode(last.errorMessage);
          }
          failure = runtime.fatal(conversation.id) ?? failure;
          if (settled.status !== 'done' || stopped.reason === 'listener_error') failure ??= 'CLOUD_MODEL_REQUEST_FAILED';
          const outcome = await committedRunOutcome(conversation, runtime, settled.status, settled.status === 'unanswered' ? settled.detail : undefined);
          if (failure) { outcome.state = 'failed'; outcome.errorCode = modelFailureCode(failure); delete outcome.text; }
          outcomeWriting = true;
          await runtime.settle(execution, outcome);
          const committed = runtime.cloud.readRun(conversation.id);
          if (committed?.state !== 'completed') failure = committed?.errorCode ?? 'CLOUD_MODEL_REQUEST_FAILED';
          if (failure) await write({ type: 'error', code: failure, retryable: false });
          else await write({ type: 'done', conversationId: conversation.id });
        } catch (error) {
          const code = runtime.fatal(conversation.id) ?? safeCloudError(error).code;
          await write({ type: 'error', code, retryable: false });
          await events.stop();
          // A native/business failure is terminal. A failed durable settlement belongs to repair.
          if (!outcomeWriting && error instanceof CloudDoError && runtime.cloud.readRun(conversation.id)?.state === 'running') {
            runtime.cancel(execution, code);
            await conversation.abort(BACKGROUND_CONTEXT, { background: true });
            await conversation.waitForIdle(BACKGROUND_CONTEXT);
            await runtime.settle(execution, { state: 'failed', errorCode: code });
          }
        }
        finally {
          clearInterval(probe);
          await runtime.release(execution);
          if (!cancelled) { try { await writer.close(); } catch { void cancel(); } }
        }
      };
      this.ctx.waitUntil(run());
      return new Response(body.readable, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
    } catch (error) {
      if (lease) await this.sessionRuntime().release(lease);
      else guard?.dispose();
      return cloudErrorResponse(error);
    }
  }
}
