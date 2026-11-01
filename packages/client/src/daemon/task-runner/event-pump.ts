// `TaskRunner` members that drain a runtime session's events into progress,
// approvals, artifacts and the terminal (see ./support.ts for how a member
// module runs).
import { resultReplyFailureReason } from '../result-reply-failure';
import { DEFAULT_ARTIFACT_LIMITS, readArtifactBytes } from '../artifact-read';
import { createEnvelope, type AgentEvent, type BlobRef, SEALED_SPLIT_TABLE } from '@byok-sdk/protocol';
import { projectRuntimeBoundaryFailure } from '../../runtime-failure';
import { spillOversizedEvent } from '../event-spill';
import { ProgressEventTooLargeError } from '../progress-batcher';
import type { ActiveTask } from './support';
import { classifyToolCall, describeHighRiskToolCall } from '../../tool-authorization';
import { MAX_INLINE_ARTIFACT_BYTES, observePreparedCall, agentMessageSealing, closingReply, errorMessage, estimateEventBytes, openArtifact, NO_SEALED_SPILL, observeTerminalUsage, taskFinalizing, taskTearingDown, taskMessageAccepted, taskMessageSendAttempted } from './support';
import type { TaskRunner } from '../task-runner';
import { ACTIVITY_INGRESS_EXCEEDED_REASON_PREFIX, MAX_OUTPUT_BYTES_EXCEEDED_REASON_PREFIX, PREPARED_USAGE_UNAVAILABLE_REASON_PREFIX } from './state';
import { hostFor } from './host';
import type { TerminalPlan } from './finish';

export async function pump(this: TaskRunner, active: ActiveTask): Promise<void> {
  try {
    for await (let event of active.session.events) {
      if (this['tasks'].get(active.taskId) !== active || taskFinalizing(this, active.taskId)) return;
      if (taskTearingDown(this, active.taskId)) {
        // Cancellation owns the result, but the native interrupt may still
        // deliver metering after a tool result/diagnostic. Consume only that
        // observation, never progress, artifacts, approvals or a new terminal.
        if (event.type === 'usage') observeTerminalUsage(active, event);
        if (event.type === 'turn_end') return;
        continue;
      }
      // A concurrent task.cancel/task.reject may already have finished
      // (and deleted) this task while this loop was awaiting the next
      // event — e.g. the runtime's own interrupt handling settles with a
      // trailing turn_end shortly after handleCancel() already reported
      // task.cancelled and started tearing the session down. That event
      // is stray at this point: without this check, the turn_end branch
      // below would unconditionally resend task.complete (and any
      // buffered task.progress) for a task the server already moved to a
      // terminal state, which it can only log as a dropped/illegal
      // transition (console.warn) rather than the silent-drop §9
      // guarantees for genuinely stale terminal messages. Mirrors the
      // same check already used below for the non-turn_end loop exits.
      if (this['tasks'].get(active.taskId) !== active) return;
      // Display only: a delta never reaches the batcher, the record or the reply.
      if (event.type === 'message_draft_delta') {
        active.messageDraft?.pushDelta(event.text, event.startsMessage);
        continue;
      }
      // `all` never blocks: classify the full reported input before any
      // spill, and only remind. `auto` already gated the call before it ran.
      if (event.type === 'tool_use' && active.toolAuthorization.default === 'all') noteToolReminder.call(this, active, event);

      // DaemonConfig.maxInlineEventBytes: bound this ONE event before it is
      // counted, batched, or sent. An oversized `tool_use.input` /
      // `tool_result.output` is uploaded to the blob plane in full and
      // replaced inline by a head/tail preview plus a `spill` descriptor
      // (see `event-spill.ts`). Deliberately placed BEFORE the whole-task
      // byte accounting below so `maxTaskOutputBytes` counts what actually
      // goes on the wire, not the pre-spill size — a task that spills is
      // not a task that flooded.
      event = await spillOversizedEvent(event, {
        maxInlineBytes: this['maxInlineEventBytes'],
        // #654: a sealed task never stores a plaintext spill blob. Its
        // event keeps the preview, which is sealed with the rest of the batch.
        blobClient: this['deps'].sealedTasks?.sealsOutput(active.taskId) ? NO_SEALED_SPILL : this['deps'].blobClient,
        taskId: active.taskId,
        signal: active.blobAbort.signal,
        log: (message) => {
          if (!taskTearingDown(this, active.taskId)) console.error(`[byok/client] ${message}`);
        },
      });
      // The upload above is a real await: a concurrent cancel/reject may
      // have finished this task while it was in flight. Same guard, same
      // reason as the two above — see this loop's own top-of-body checks.
      if (this['tasks'].get(active.taskId) !== active || taskFinalizing(this, active.taskId)) return;
      if (taskTearingDown(this, active.taskId)) continue; // skip the aborted spill, then drain queued interrupt usage
      // After the spill (it reads `spill.unstoredReason`) and the teardown
      // guards, so the record ends exactly where the terminal decision is.
      active.executionRecord.observe(event);

      // M5 batch-3 (workstream 2): DaemonConfig.maxTaskOutputBytes
      // enforcement — see `estimateEventBytes`'s own doc comment for
      // exactly what's counted (a serialized-payload-length
      // approximation) and what isn't (batching overhead; an artifact's
      // actual file bytes, uploaded separately by `sendArtifact`). Checked
      // here, before any per-event-type handling below, so a task that's
      // about to be torn down for this never pays for `sendArtifact`'s own
      // disk I/O or dispatches a pointless approval request first.
      active.outputBytesSoFar += estimateEventBytes(event);
      if (active.outputBytesSoFar > this['maxTaskOutputBytes']) {
        active.batcher.flush();
        await this['failActiveTaskForResourceLimit'](
          active.taskId,
          `${MAX_OUTPUT_BYTES_EXCEEDED_REASON_PREFIX}: task emitted approximately ${active.outputBytesSoFar} bytes of output (serialized-event-length approximation), exceeding the configured limit of ${this['maxTaskOutputBytes']} bytes`,
          false, // Called by this pump: it cannot await its own settlement.
        );
        return;
      }

      if (event.type === 'usage') {
        // Terminal usage is last-observed, not an accumulator. The bundled
        // Codex/Claude adapters emit their runtime terminal observation
        // before turn_end/error; a custom adapter that emits several keeps
        // only the latest actual observation rather than inventing a sum.
        // Keep terminal provider cost observation when a separate context snapshot arrives.
        observeTerminalUsage(active, event);
        if (active.prepared !== undefined) {
          const verdict = observePreparedCall(active.prepared, event);
          if (verdict !== undefined) {
            // The observation that ended the Execution still reaches the
            // wire, ahead of the typed failure it caused.
            active.batcher.push(event);
            active.batcher.flush();
            await this['teardownActiveTask'](active, verdict, false, false);
            return;
          }
        }
      }

      // The session hook can be stateful. Share one decision with both text lanes.
      const startsMessage = event.type === 'progress'
        && active.adapter.descriptor.progressEventsAreMessages === true && event.text.trim() !== ''
        && active.session.progressStartsMessage?.(event) !== false;
      active.messageDraft?.push(event, startsMessage);
      if (event.type === 'tool_use' || event.type === 'tool_result') {
        // A tool interaction ends the current text run: whatever the model
        // said before it was narration about what it was ABOUT to do, not
        // its answer. See `ActiveTask.finalTextParts` for why `usage`,
        // `artifact` and `turn_end` deliberately do not reset here.
        active.finalTextParts.length = 0;
      }

      if (event.type === 'turn_end') {
        await pumpTurnEnd.call(this, active, event);
        return;
      }
      if (event.type === 'progress') {
        active.summaryParts.push(event.text);
        // A blank whole message must not erase the reply that came before it.
        if (startsMessage) {
          active.finalTextParts.length = 0;
        }
        active.finalTextParts.push(event.text);
      }
      if (event.type === 'artifact') await this['sendArtifact'](active, event.name, event.contentType);
      active.batcher.push(event);
    }
    // The events iterable ended without either an explicit turn_end or a
    // typed RuntimeExecutionFailure. Bundled adapters translate process
    // disappearance into a typed infrastructure failure before their
    // iterable ends; a clean end here is therefore an adapter-contract
    // violation, not permission for TaskRunner to guess provider meaning.
    // This is also exactly what happens when `handleCancel`/`handleReject`
    // concurrently call `session.close()` while this loop is still
    // awaiting the same iterable (ending it is how those paths stop the
    // session). Check identity against the tasks map — if something else
    // already finished this exact active task, its own message
    // (task.cancelled / task.fail) already reported the outcome; this is
    // not a second failure. M5 batch-3 (workstream 2): `beingTornDown` is
    // the SAME guard for `teardownActiveTask`'s own controlled teardown
    // (graceful shutdown / resource-limit enforcement) — see
    // `ActiveTask.beingTornDown`'s own doc comment for why the identity
    // check alone doesn't cover that path's pre-finish() hard-kill
    // `close()` call.
    if (this['tasks'].get(active.taskId) !== active || taskTearingDown(this, active.taskId)) return;
    active.executionRecord.streamEnded();
    const failure = projectRuntimeBoundaryFailure(undefined, 'run');
    console.error('[byok/client] runtime adapter events iterable ended without terminal authority');
    await this['fail'](active.taskId, failure.reason, failure.retryable, failure.failure);
  } catch (err) {
    if (this['tasks'].get(active.taskId) !== active || taskTearingDown(this, active.taskId)) return;
    active.batcher.flush();
    if (err instanceof ProgressEventTooLargeError) {
      await this['failActiveTaskForResourceLimit'](
        active.taskId,
        `${ACTIVITY_INGRESS_EXCEEDED_REASON_PREFIX}: event requires ${err.actualBytes} UTF-8 bytes, exceeding the advertised activity ingress limit of ${err.maxBytes} bytes`,
        false,
      );
      return;
    }
    // The runner fails the task as the runtime's `run` failure below, so the
    // record counts the throw as the runtime ending its stream.
    active.executionRecord.streamEnded();
    const failure = projectRuntimeBoundaryFailure(err, 'run');
    if (failure.contractViolation) {
      // Never the error object itself (issue #395); see the start() case.
      console.error(
        `[byok/client] runtime adapter ${active.adapter.descriptor.id} events iterable returned an untyped failure for task ${active.taskId}`,
      );
    }
    await this['fail'](active.taskId, failure.reason, failure.retryable, failure.failure);
  }
}

/** The `turn_end` branch of {@link pump}; every path ends the pump. */
async function pumpTurnEnd(this: TaskRunner, active: ActiveTask, event: Extract<AgentEvent, { type: 'turn_end' }>): Promise<void> {
  if (active.prepared !== undefined && active.prepared.initialPromptTokens === undefined) {
    // A prepared result nobody can check against its byte bound is not
    // a success. Fail closed rather than completing without evidence.
    active.batcher.flush();
    await this['fail'](
      active.taskId,
      `${PREPARED_USAGE_UNAVAILABLE_REASON_PREFIX}: this prepared Execution settled with no provider usage observed`,
      false,
    );
    return;
  }
  active.batcher.push(event);
  active.batcher.flush();
  const finalOutput = active.summaryParts.join('');
  // Resolve the result decision before Git observation and reply handoff.
  // Missing/unreadable results can still deliver a required reply; a task
  // that cannot deliver its required result takes the salvage path
  // `fail()` already applies to every other failure — rather than
  // being observed as completed and only then failed.
  const outcome = await this['resolveStagedResult'](active);
  if (!outcome.deliver) return; // already reported task.fail and finished
  const failureReason = outcome.failure === undefined ? undefined
    : resultReplyFailureReason(outcome.failure, active.terminalProjection!.mode === 'result-document' ? active.terminalProjection!.contract : '');
  if (outcome.failure !== undefined) active.resultReplyFailure = outcome.failure;
  if (!this['canPublishAgentMessage'](active)) return;
  const recordFailure = async () => {
    if (outcome.failure === undefined) return;
    if (this['deps'].recordResultReplyFailure === undefined) throw new Error('required reply result failure has no durable intent writer');
    await this['deps'].recordResultReplyFailure(active.taskId, outcome.failure);
  };
  if (active.messageRequirement !== undefined && !taskMessageAccepted(this, active.taskId)) {
    // Tool-authored and daemon-authored replies share one immutable
    // draft and one append → failure intent → activation boundary.
    // A recovery binding stays inert until the journal intent exists.
    const outbox = active.messageOutbox;
    let refusalReason: string | undefined;
    try {
      if (outbox === undefined) {
        refusalReason = 'required Agent message lane is unavailable for this task';
        throw new Error(refusalReason);
      }
      if (outbox.get(active.taskId) === undefined) {
        const body = (closingReply(active) ?? finalOutput).trim();
        if (body === '') {
          refusalReason = 'runtime produced no reply text for the required Agent message';
          throw new Error(refusalReason);
        }
        try {
          await outbox.appendDraft({ taskId: active.taskId, tenantId: this['deps'].tenantId!,
            agentRef: active.agentRef, requirement: active.messageRequirement,
            contentType: active.messageRequirement.contentType, body,
            ...(outcome.failure === undefined ? {} : { recoverySessionRef: active.session.sessionRef }),
            maxPendingEvents: 64, maxPendingBytes: 4 * 1024 * 1024, ...agentMessageSealing(this, active.taskId) });
        } catch (error) {
          // An in-flight tool author may win the immutable draft.
          if (!taskMessageAccepted(this, active.taskId) && outbox.get(active.taskId) === undefined) throw error;
        }
      }
      if (!this['canPublishAgentMessage'](active)) return;
      await recordFailure();
      if (!this['canPublishAgentMessage'](active)) return;
      if (!taskMessageAccepted(this, active.taskId)) {
        const host = hostFor(this);
        host.setMessageCompletion(active.taskId, { finalOutput, ...(failureReason === undefined ? {} : { failureReason }), ...(outcome.document === undefined ? {} : { document: outcome.document }) });
        // T1 records the open completion gate (and its token) in the reducer;
        // M1/M2 resolve it when the disposition arrives.
        void host.dispatch({ type: 'turn.ended', taskId: active.taskId, atMs: Date.now() }).catch(() => undefined);
        const activated = await this['activateAgentMessage'](outbox, active.taskId, active.session.sessionRef,
          () => this['canPublishAgentMessage'](active), () => taskMessageSendAttempted(this, active.taskId));
        if (!this['canPublishAgentMessage'](active)) return;
        if (activated === undefined) throw new Error('Agent message draft disappeared before activation');
        this['sendAgentMessageRecord'](outbox, activated);
        return;
      }
    } catch (err) {
      if (outcome.failure !== undefined) throw err; // preserve the runtime-boundary failure projection
      if (!this['canPublishAgentMessage'](active)) return;
      hostFor(this).clearMessageCompletion(active.taskId);
      await this['fail'](active.taskId, refusalReason ?? `failed to deliver the required Agent message: ${errorMessage(err)}`, false);
      return;
    }
  } else {
    await recordFailure();
    if (!this['canPublishAgentMessage'](active)) return;
  }
  if (failureReason !== undefined) await this['fail'](active.taskId, failureReason, false);
  else await this['publishSuccessfulCompletion'](active, finalOutput, outcome.document);
  return;
}

/** The exact `task.complete` plan, shared by turn_end and the message gate. */
export function successfulCompletionPlan(
  this: TaskRunner, active: ActiveTask, finalOutput: string, document?: unknown,
): TerminalPlan {
  return {
    kind: 'complete',
    cause: 'complete',
    retryable: false,
    prepare: async () => {
      await this['persistAgentTerminalEvidence'](active, 'complete');
      const finalMessage = closingReply(active);
      return createEnvelope('task.complete', {
        summary: finalOutput,
        ...(finalMessage === undefined ? {} : { finalMessage }),
        sessionRef: active.session.sessionRef,
        ...(document !== undefined ? { document } : {}),
        ...this['terminalInferenceUsagePayload'](active),
        ...this['preparedObservationPayload'](active),
        ...this['agentTerminalPayload'](active),
      }, { taskId: active.taskId, sessionRef: active.session.sessionRef });
    },
  };
}

export async function publishSuccessfulCompletion(this: TaskRunner, active: ActiveTask, finalOutput: string, document?: unknown): Promise<void> {
  await this['settleSemanticTerminal'](active, successfulCompletionPlan.call(this, active, finalOutput, document));
}

export async function sendArtifact(this: TaskRunner, active: ActiveTask, name: string, contentType: string): Promise<void> {
  const opened = await openArtifact(active.workspaceDir, name);
  if (!opened.ok) {
    this['reportArtifactError'](active, name, opened.reason);
    return;
  }

  let bytes: Buffer;
  try {
    const limits = this['deps'].artifactLimits ?? DEFAULT_ARTIFACT_LIMITS;
    const remaining = limits.maxTaskBytes - (active.artifactBytesSoFar ?? 0);
    bytes = await readArtifactBytes(opened.handle, Math.min(limits.maxFileBytes, remaining),
      active.blobAbort.signal, count => { active.artifactBytesSoFar = (active.artifactBytesSoFar ?? 0) + count; });
  } catch (err) {
    this['reportArtifactError'](active, name, `failed to read artifact "${name}": ${errorMessage(err)}`);
    return;
  } finally {
    await opened.handle.close().catch(() => {});
  }

  if (this['tasks'].get(active.taskId) !== active || active.blobAbort.signal.aborted || taskTearingDown(this, active.taskId)) return;
  const sealedTasks = this['deps'].sealedTasks;
  if (sealedTasks?.sealsOutput(active.taskId)) {
    // #654 decision 12b: a sealed task's artifact is sealed inline content.
    // It is never uploaded as a plaintext blob.
    const inline = bytes.toString('base64');
    if (Buffer.byteLength(inline, 'utf8') > SEALED_SPLIT_TABLE['task.artifact'].limits.inline) {
      this['reportArtifactError'](active, name, `artifact "${name}" is over the sealed inline limit and was not sent`);
      return;
    }
    try {
      const sealed = await sealedTasks.sealArtifact(active.taskId, { name, contentType, inline });
      if (this['tasks'].get(active.taskId) !== active || active.blobAbort.signal.aborted || taskTearingDown(this, active.taskId)) return;
      if (sealed === undefined) this['reportArtifactError'](active, name, `artifact "${name}" was not sent: no sealing key`);
      else this['deps'].send(sealed);
    } catch (err) {
      this['reportArtifactError'](active, name, `failed to seal artifact "${name}": ${errorMessage(err)}`);
    }
    return;
  }
  if (bytes.length <= MAX_INLINE_ARTIFACT_BYTES) {
    const inline = bytes.toString('base64');
    if (new TextEncoder().encode(inline).length <= MAX_INLINE_ARTIFACT_BYTES) {
      this['deps'].send(createEnvelope('task.artifact', { name, contentType, inline }, { taskId: active.taskId }));
      return;
    }
  }

  try {
    const blobRef: BlobRef = await this['deps'].blobClient.uploadArtifact(bytes, contentType, {
      signal: active.blobAbort.signal,
    });
    if (this['tasks'].get(active.taskId) !== active || active.blobAbort.signal.aborted || taskTearingDown(this, active.taskId)) return;
    this['deps'].send(createEnvelope('task.artifact', { name, contentType, blobRef }, { taskId: active.taskId }));
  } catch (err) {
    this['reportArtifactError'](active, name, `failed to upload artifact "${name}": ${errorMessage(err)}`);
  }
}

export function reportArtifactError(this: TaskRunner, active: ActiveTask, name: string, reason: string): void {
  if (active.blobAbort.signal.aborted || taskTearingDown(this, active.taskId)) return;
  // The name and reason go to the task's own progress stream; stderr is a
  // service log and gets sizes only (issue #395).
  console.error(
    `[byok/client] artifact for task ${active.taskId} dropped: nameBytes=${Buffer.byteLength(name, 'utf8')} reasonBytes=${Buffer.byteLength(reason, 'utf8')}`,
  );
  active.batcher.push({ type: 'error', message: reason });
}

function noteToolReminder(this: TaskRunner, active: ActiveTask, event: Extract<AgentEvent, { type: 'tool_use' }>): void {
  const input = event.input !== null && typeof event.input === 'object' && !Array.isArray(event.input)
    ? event.input as Record<string, unknown> : {};
  const call = { toolName: event.tool, input, cwd: active.workspaceDir, ...(event.mcp === undefined ? {} : { mcp: event.mcp }) };
  const risk = classifyToolCall(call, active.workspaceDir, undefined, active.toolAuthorization.rules);
  const identity = { taskId: active.taskId, toolName: event.tool,
    ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }) };
  try {
    if (risk.level === 'normal') {
      if (risk.suppressedReasons !== undefined && risk.suppressedReasons.length > 0) {
        this['deps'].onToolAuthorizationDecision?.(Object.freeze({
          ...identity, decision: 'allow', authorization: risk.authorization, reasons: Object.freeze([]),
          suppressedReasons: risk.suppressedReasons,
        }));
      }
      return;
    }
    this['deps'].onToolReminder?.(Object.freeze({
      ...identity,
      reasons: risk.reasons, authorization: risk.authorization, summary: describeHighRiskToolCall(call, risk.reasons, risk.authorization),
    }));
  } catch (error) {
    console.error(`[byok/client] tool authorization observer failed for task ${active.taskId}: ${errorMessage(error)}`);
  }
}
