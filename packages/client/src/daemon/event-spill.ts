import { createHash } from 'node:crypto';
import type { AgentEvent, AgentEventSpill } from '@byok-sdk/protocol';
import type { BlobResolver } from './blob-client';

/**
 * Default per-event inline ceiling (64 KiB) for the two `AgentEvent` variants
 * that carry runtime-authored payloads (`tool_use.input`,
 * `tool_result.output`) — see `DaemonConfig.maxInlineEventBytes`
 * (`create-daemon.ts`) for the host-facing contract.
 *
 * 64 KiB is the same threshold `sendArtifact` already uses to decide inline
 * vs. blob for an artifact (`MAX_INLINE_ARTIFACT_BYTES`): one number for "a
 * payload this daemon is willing to put on the activity wire".
 */
export const DEFAULT_MAX_INLINE_EVENT_BYTES = 64 * 1024;

/**
 * Smallest accepted `maxInlineEventBytes`. Below this a legitimate spill
 * descriptor (`field` + byte counts + a `BlobRef` whose `blobId` is chosen by
 * the server, plus the event's own `type`/`tool`/`toolCallId`) stops fitting
 * inside the cap it is supposed to keep the event under, which would turn a
 * host's configuration mistake into a per-event runtime invariant failure.
 * Enforced up front at `DaemonConfig` validation, never here.
 */
export const MIN_MAX_INLINE_EVENT_BYTES = 4096;

/** Hard ceiling on `AgentEventSpill.unstoredReason`, mirroring the protocol schema's own bound. */
const MAX_UNSTORED_REASON_BYTES = 512;

export interface EventSpillDeps {
  /** Effective inline ceiling for this daemon; already validated at the `DaemonConfig` layer. */
  maxInlineBytes: number;
  /** Only the upload half of `BlobResolver` is needed, so a test double stays minimal. */
  blobClient: Pick<BlobResolver, 'uploadArtifact'>;
  /** Scopes the upload's idempotency key to the task that produced the event. */
  taskId: string;
  /** Task lifecycle authority — aborting it stops the spill upload with the rest of the task's blob I/O. */
  signal?: AbortSignal;
  /** Diagnostic seam. Called only on a path that loses information (upload failure, or an event this policy cannot bound). */
  log?: (message: string) => void;
}

type SpillableEvent = Extract<AgentEvent, { type: 'tool_use' | 'tool_result' }>;

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** UTF-8 width of one code point — matches what `Buffer.byteLength` charges, including 3 bytes for a lone surrogate. */
function utf8Width(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * Longest PREFIX of `value` that costs at most `maxBytes` UTF-8 bytes, cut
 * only on a code-point boundary — a surrogate pair (an emoji, any astral
 * character) is kept whole or dropped whole, never halved into a lone
 * surrogate that `JSON.stringify` would have to escape and a consumer would
 * decode as U+FFFD.
 */
function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let bytes = 0;
  let index = 0;
  while (index < value.length) {
    const codePoint = value.codePointAt(index) as number;
    const width = utf8Width(codePoint);
    if (bytes + width > maxBytes) break;
    bytes += width;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return value.slice(0, index);
}

/** Longest SUFFIX of `value` costing at most `maxBytes` UTF-8 bytes, cut only on a code-point boundary. */
function utf8Suffix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let bytes = 0;
  let index = value.length;
  while (index > 0) {
    // Step back one code point: a low surrogate preceded by a high surrogate
    // is one character, not two.
    let step = 1;
    const last = value.charCodeAt(index - 1);
    if (last >= 0xdc00 && last <= 0xdfff && index >= 2) {
      const previous = value.charCodeAt(index - 2);
      if (previous >= 0xd800 && previous <= 0xdbff) step = 2;
    }
    const codePoint = value.codePointAt(index - step) as number;
    const width = utf8Width(codePoint);
    if (bytes + width > maxBytes) break;
    bytes += width;
    index -= step;
  }
  return value.slice(index);
}

/** Bounded, non-empty diagnostic string for a failed upload — truncated on a code-point boundary so the reason itself can never push the event back over the cap. */
function boundedUnstoredReason(error: unknown): string {
  const raw = error instanceof Error && error.message.length > 0
    ? `${error.name}: ${error.message}`
    : String(error);
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return 'blob upload failed with a non-descriptive error';
  return utf8Prefix(collapsed, MAX_UNSTORED_REASON_BYTES);
}

/**
 * Bound one normalized `AgentEvent` at the daemon's ingestion boundary
 * (`TaskRunner.pump`).
 *
 * An event whose serialized form already fits `maxInlineBytes` is returned
 * **as the same object reference** — the overwhelming majority of events pay
 * exactly one `JSON.stringify` and nothing else, and no downstream identity
 * comparison changes meaning.
 *
 * An oversized `tool_use` / `tool_result` has its runtime-authored field
 * (`input` / `output`) uploaded to the blob plane in full and REPLACED inline
 * by `{ preview: { head, tail } }`, with an additive `spill` descriptor
 * carrying either the resulting `BlobRef` or a bounded `unstoredReason`. The
 * replacement is *measured* against the cap, never assumed to fit: the
 * preview budget is whatever is left after the rest of the event and the
 * real descriptor, and it is shrunk until `JSON.stringify(result)` actually
 * fits (JSON escaping can cost several bytes per source character, so the
 * byte budget alone is not a bound).
 *
 * Storage failure is never silent and never fatal: the preview still ships,
 * `unstoredReason` says why the omitted bytes are unreadable, and `log` is
 * called. The runtime's own transcript still holds the content, so failing
 * the task over a telemetry upload would trade a real result for an
 * observability problem.
 */
export async function spillOversizedEvent(event: AgentEvent, deps: EventSpillDeps): Promise<AgentEvent> {
  if (event.type !== 'tool_use' && event.type !== 'tool_result') return event;

  const serializedEvent = JSON.stringify(event);
  if (byteLength(serializedEvent) <= deps.maxInlineBytes) return event;

  const spillable: SpillableEvent = event;
  const field: 'input' | 'output' = spillable.type === 'tool_use' ? 'input' : 'output';
  const value = spillable.type === 'tool_use' ? spillable.input : spillable.output;
  if (value === undefined) {
    deps.log?.(
      `task ${deps.taskId}: ${spillable.type} event is ${byteLength(serializedEvent)} bytes, over the ${deps.maxInlineBytes}-byte inline cap, but carries no ${field} to spill; forwarding unchanged`,
    );
    return event;
  }

  const serialized: string | undefined = JSON.stringify(value);
  if (serialized === undefined) {
    deps.log?.(
      `task ${deps.taskId}: ${spillable.type}.${field} is not JSON-serializable; forwarding the event unchanged`,
    );
    return event;
  }
  const totalBytes = byteLength(serialized);

  // Everything about this event EXCEPT the spilled field and the descriptor.
  // If that alone already exceeds the cap, the field is not what makes this
  // event oversized (a pathological `tool` name, say) and spilling it would
  // upload bytes without bounding anything.
  const skeleton = JSON.stringify({ ...spillable, [field]: { preview: { head: '', tail: '' } } });
  if (byteLength(skeleton) >= deps.maxInlineBytes) {
    deps.log?.(
      `task ${deps.taskId}: ${spillable.type} event exceeds the ${deps.maxInlineBytes}-byte inline cap independently of its ${field} (${byteLength(skeleton)} bytes without it); forwarding unchanged`,
    );
    return event;
  }

  const digest = createHash('sha256').update(serialized, 'utf8').digest('hex');
  let stored: Pick<AgentEventSpill, 'blob'> | Pick<AgentEventSpill, 'unstoredReason'>;
  try {
    const blob = await deps.blobClient.uploadArtifact(serialized, 'application/json', {
      idempotencyKey: `spill_${deps.taskId}_${digest}`,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });
    stored = { blob };
  } catch (error) {
    const unstoredReason = boundedUnstoredReason(error);
    stored = { unstoredReason };
    deps.log?.(
      `task ${deps.taskId}: ${totalBytes}-byte ${spillable.type}.${field} could not be stored, only a preview will reach the wire — ${unstoredReason}`,
    );
  }

  // Worst-case descriptor: the real `blob`/`unstoredReason`, and byte counts
  // at their widest (`omittedBytes` can never exceed `totalBytes`, so
  // `totalBytes`'s digit count bounds both).
  const descriptorFor = (omittedBytes: number): AgentEventSpill => ({
    field,
    totalBytes,
    omittedBytes,
    contentType: 'application/json',
    ...stored,
  });
  const overhead = byteLength(
    JSON.stringify({ ...spillable, [field]: { preview: { head: '', tail: '' } }, spill: descriptorFor(totalBytes) }),
  );

  let headBudget = Math.max(0, Math.ceil((deps.maxInlineBytes - overhead) / 2));
  let tailBudget = Math.max(0, Math.floor((deps.maxInlineBytes - overhead) / 2));
  let result: AgentEvent;
  let resultBytes: number;
  for (;;) {
    const head = utf8Prefix(serialized, headBudget);
    // Sliced past the head so a short value can never have its middle
    // counted twice (head and tail overlapping into one duplicated run).
    const tail = utf8Suffix(serialized.slice(head.length), tailBudget);
    const retained = byteLength(head) + byteLength(tail);
    result = {
      ...spillable,
      [field]: { preview: { head, tail } },
      spill: descriptorFor(totalBytes - retained),
    } as AgentEvent;
    resultBytes = byteLength(JSON.stringify(result));
    if (resultBytes <= deps.maxInlineBytes) break;

    // JSON escaping made the measured event larger than the byte budget
    // predicted. Shrink by ACTUAL retained bytes (not by the budget, which
    // may already be slack) so every iteration makes strict progress.
    const headBytes = byteLength(head);
    const tailBytes = byteLength(tail);
    if (headBytes === 0 && tailBytes === 0) break;
    const excess = resultBytes - deps.maxInlineBytes;
    const dropHead = headBytes === 0 ? 0 : Math.min(headBytes, Math.max(1, Math.ceil(excess / 2)));
    const dropTail = tailBytes === 0 ? 0 : Math.min(tailBytes, Math.max(dropHead === 0 ? 1 : 0, excess - dropHead));
    if (dropHead === 0 && dropTail === 0) break;
    headBudget = headBytes - dropHead;
    tailBudget = tailBytes - dropTail;
  }

  if (resultBytes > deps.maxInlineBytes) {
    // Unreachable for any `maxInlineBytes >= MIN_MAX_INLINE_EVENT_BYTES`: the
    // skeleton check above already proved the event minus its spilled field
    // fits, and the descriptor is bounded. Loud rather than silently shipping
    // an event this policy promised to bound.
    throw new Error(
      `event spill failed to bound a ${spillable.type} event: replacement is ${resultBytes} bytes against a ${deps.maxInlineBytes}-byte cap (${field} was ${totalBytes} bytes, descriptor overhead ${overhead} bytes)`,
    );
  }
  return result;
}
