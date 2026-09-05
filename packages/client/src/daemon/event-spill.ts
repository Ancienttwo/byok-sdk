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

/**
 * Hard ceiling on `AgentEventSpill.unstoredReason`, mirroring the protocol
 * schema's own bound. Charged against the reason's JSON-ENCODED width (minus
 * its two quotes), not its raw UTF-8 width: a runtime error message can carry
 * control characters that `JSON.stringify` expands to six bytes each, so a
 * raw-byte bound would let a 512-byte reason cost 3072 bytes on the wire and
 * invalidate the descriptor arithmetic below.
 */
const MAX_UNSTORED_REASON_BYTES = 512;

/**
 * Worst-case JSON cost of the `,"spill":{…}` fragment when the descriptor
 * carries an `unstoredReason` rather than a server-chosen `BlobRef`.
 *
 * Every part is bounded by construction, which a `BlobRef` is not — its
 * `blobId` is an arbitrary-length server-chosen string:
 *
 * ```
 *   ,"spill":                                  9
 *   {                                          1
 *   "field":"output",                         17   ("output" is the longer of the two)
 *   "totalBytes":<=16 digits>,                30
 *   "omittedBytes":<=16 digits>,              32   (never exceeds totalBytes)
 *   "contentType":"application/json",         33   (a module constant)
 *   "unstoredReason":                         17
 *   "<=512 bytes of escaped reason>"         514   (MAX_UNSTORED_REASON_BYTES + 2 quotes)
 *   }                                          1
 *                                           ----
 *                                            654
 * ```
 *
 * Rounded up to 768 so digit-count growth cannot invalidate it. Because the
 * event is spread first and `spill` written last, a bounded event is EXACTLY
 * the empty-preview skeleton plus this fragment — so refusing to spill unless
 * `skeleton + MAX_SPILL_DESCRIPTOR_BYTES <= maxInlineBytes` is what makes the
 * final cap check unreachable rather than merely unlikely. `event-spill.test.ts`
 * asserts this against a maximally escaping reason instead of trusting the
 * comment.
 */
export const MAX_SPILL_DESCRIPTOR_BYTES = 768;

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

/** The exactly-one-of half of an `AgentEventSpill`: where the omitted bytes are, or why they are nowhere. */
type StoredHalf = Pick<AgentEventSpill, 'blob'> | Pick<AgentEventSpill, 'unstoredReason'>;

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * `JSON.stringify` that reports failure instead of throwing.
 *
 * `AgentEvent.input` / `.output` are `z.unknown()` — an in-process
 * `AgentSession` can put a BigInt, a cycle, or a throwing `toJSON` in there,
 * and `JSON.stringify` answers each of those with a `TypeError`. This module
 * runs inside `TaskRunner.pump`, where an escaping throw is caught at the
 * runtime boundary and fails the whole task, misattributing a telemetry
 * problem to the adapter. `undefined` covers both the throw and the values
 * `JSON.stringify` legitimately declines to encode (`undefined`, a function,
 * a symbol); every caller treats them the same way, because in both cases
 * this module cannot measure — and therefore cannot bound — the event.
 */
function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
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

/**
 * Bounded, non-empty diagnostic string — truncated on a code-point boundary so
 * the reason itself can never push the event back over the cap.
 *
 * The bound is on the ENCODED width (`JSON.stringify(reason)` minus its two
 * quotes), so `MAX_SPILL_DESCRIPTOR_BYTES` holds even for a reason built
 * entirely from characters that escape to six bytes each. For an all-ASCII
 * reason the encoded width equals the raw width, so the common case still
 * truncates at exactly 512 bytes.
 */
function boundReasonText(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const fallback = 'blob upload failed with a non-descriptive error';
  if (collapsed.length === 0) return fallback;
  let budget = MAX_UNSTORED_REASON_BYTES;
  for (;;) {
    const reason = utf8Prefix(collapsed, budget);
    // A single code point encodes to at most 12 bytes, so the ratio below can
    // never drive the budget to zero on a non-empty reason; the guard keeps
    // the protocol's `min(1)` true by construction rather than by argument.
    if (reason.length === 0) return fallback;
    const encoded = byteLength(JSON.stringify(reason)) - 2;
    if (encoded <= MAX_UNSTORED_REASON_BYTES) return reason;
    // Rescale by the OBSERVED escape ratio rather than subtracting the
    // overshoot: at 6 bytes per source character the overshoot exceeds the
    // whole budget, and subtracting it would throw the reason away entirely.
    // `budget - 1` keeps every iteration strictly decreasing, so this
    // terminates (in practice after one rescale).
    budget = Math.min(Math.floor((budget * MAX_UNSTORED_REASON_BYTES) / encoded), budget - 1);
  }
}

/** {@link boundReasonText} over whatever the blob upload rejected with. */
function boundedUnstoredReason(error: unknown): string {
  const raw = error instanceof Error && error.message.length > 0
    ? `${error.name}: ${error.message}`
    : String(error);
  return boundReasonText(raw);
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

  const serializedEvent = safeStringify(event);
  if (serializedEvent === undefined) {
    deps.log?.(
      `task ${deps.taskId}: ${event.type} event cannot be JSON-serialized (a BigInt, a cycle, or a throwing toJSON in its payload); forwarding it unchanged and unbounded`,
    );
    return event;
  }
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

  const serialized = safeStringify(value);
  if (serialized === undefined) {
    deps.log?.(
      `task ${deps.taskId}: ${spillable.type}.${field} is not JSON-serializable; forwarding the event unchanged`,
    );
    return event;
  }
  const totalBytes = byteLength(serialized);

  // Everything about this event EXCEPT the spilled field and the descriptor.
  // If that plus a worst-case bounded descriptor already exceeds the cap, the
  // field is not what makes this event oversized (a pathological `tool` name,
  // say) and spilling it would upload bytes without bounding anything.
  //
  // Charging MAX_SPILL_DESCRIPTOR_BYTES here rather than measuring the
  // skeleton alone is what turns the final cap check below into dead code:
  // past this point an empty-preview event carrying an `unstoredReason`
  // descriptor provably fits.
  const skeleton = safeStringify({ ...spillable, [field]: { preview: { head: '', tail: '' } } });
  if (skeleton === undefined) {
    deps.log?.(
      `task ${deps.taskId}: ${spillable.type} event cannot be JSON-serialized once its ${field} is replaced by a preview; forwarding it unchanged and unbounded`,
    );
    return event;
  }
  if (byteLength(skeleton) + MAX_SPILL_DESCRIPTOR_BYTES > deps.maxInlineBytes) {
    deps.log?.(
      `task ${deps.taskId}: ${spillable.type} event exceeds the ${deps.maxInlineBytes}-byte inline cap independently of its ${field} (${byteLength(skeleton)} bytes without it, plus up to ${MAX_SPILL_DESCRIPTOR_BYTES} bytes of spill descriptor); forwarding unchanged`,
    );
    return event;
  }

  const digest = createHash('sha256').update(serialized, 'utf8').digest('hex');
  let stored: StoredHalf;
  // Tracked separately from `stored` because narrowing a `Pick<…, 'blob'>`
  // union on an OPTIONAL property is not something `in` can do.
  let storedBlobId: string | undefined;
  try {
    const blob = await deps.blobClient.uploadArtifact(serialized, 'application/json', {
      idempotencyKey: `spill_${deps.taskId}_${digest}`,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });
    stored = { blob };
    storedBlobId = blob.blobId;
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
  const descriptorFor = (omittedBytes: number, half: StoredHalf): AgentEventSpill => ({
    field,
    totalBytes,
    omittedBytes,
    contentType: 'application/json',
    ...half,
  });

  /**
   * Measure the empty-preview overhead for one descriptor half, then shrink
   * the preview until the event actually fits. Returns the best it reached —
   * `resultBytes` may still exceed the cap when the descriptor itself is too
   * wide, which is the caller's signal to retry with a bounded half.
   * `undefined` means the replacement stopped being serializable, which the
   * caller reports rather than guesses around.
   */
  const bound = (half: StoredHalf): { result: AgentEvent; resultBytes: number; overhead: number } | undefined => {
    const overheadJson = safeStringify({
      ...spillable,
      [field]: { preview: { head: '', tail: '' } },
      spill: descriptorFor(totalBytes, half),
    });
    if (overheadJson === undefined) return undefined;
    const overhead = byteLength(overheadJson);

    let headBudget = Math.max(0, Math.ceil((deps.maxInlineBytes - overhead) / 2));
    let tailBudget = Math.max(0, Math.floor((deps.maxInlineBytes - overhead) / 2));
    for (;;) {
      const head = utf8Prefix(serialized, headBudget);
      // Sliced past the head so a short value can never have its middle
      // counted twice (head and tail overlapping into one duplicated run).
      const tail = utf8Suffix(serialized.slice(head.length), tailBudget);
      const retained = byteLength(head) + byteLength(tail);
      const result = {
        ...spillable,
        [field]: { preview: { head, tail } },
        spill: descriptorFor(totalBytes - retained, half),
      } as AgentEvent;
      const resultJson = safeStringify(result);
      if (resultJson === undefined) return undefined;
      const resultBytes = byteLength(resultJson);
      if (resultBytes <= deps.maxInlineBytes) return { result, resultBytes, overhead };

      // JSON escaping made the measured event larger than the byte budget
      // predicted. Shrink by ACTUAL retained bytes (not by the budget, which
      // may already be slack) so every iteration makes strict progress.
      const headBytes = byteLength(head);
      const tailBytes = byteLength(tail);
      if (headBytes === 0 && tailBytes === 0) return { result, resultBytes, overhead };
      const excess = resultBytes - deps.maxInlineBytes;
      const dropHead = headBytes === 0 ? 0 : Math.min(headBytes, Math.max(1, Math.ceil(excess / 2)));
      const dropTail = tailBytes === 0 ? 0 : Math.min(tailBytes, Math.max(dropHead === 0 ? 1 : 0, excess - dropHead));
      if (dropHead === 0 && dropTail === 0) return { result, resultBytes, overhead };
      headBudget = headBytes - dropHead;
      tailBudget = tailBytes - dropTail;
    }
  };

  let bounded = bound(stored);
  if (bounded === undefined) {
    deps.log?.(
      `task ${deps.taskId}: ${spillable.type} event cannot be JSON-serialized once its ${field} is replaced by a preview and a spill descriptor; forwarding it unchanged and unbounded`,
    );
    return event;
  }

  // `BlobRefSchema.blobId` is a server-chosen string with no length bound, so
  // a SUCCESSFUL upload can still hand back a locator that does not fit the
  // cap this function exists to hold — and throwing here would escape
  // `TaskRunner.pump` into the runtime-boundary catch and fail the task over
  // a telemetry detail. The blob stays uploaded; only the inline locator is
  // dropped, and the reason says why without repeating the oversized id.
  if (bounded.resultBytes > deps.maxInlineBytes && storedBlobId !== undefined) {
    const unstoredReason = boundReasonText(
      `spill locator too large for maxInlineBytes: blobId ${storedBlobId.length} chars`,
    );
    deps.log?.(
      `task ${deps.taskId}: ${totalBytes}-byte ${spillable.type}.${field} was stored, but its spill locator does not fit the ${deps.maxInlineBytes}-byte inline cap (descriptor overhead ${bounded.overhead} bytes); shipping the preview with unstoredReason instead — ${unstoredReason}`,
    );
    stored = { unstoredReason };
    storedBlobId = undefined;
    bounded = bound(stored);
    if (bounded === undefined) {
      deps.log?.(
        `task ${deps.taskId}: ${spillable.type} event cannot be JSON-serialized once its ${field} is replaced by a preview and a spill descriptor; forwarding it unchanged and unbounded`,
      );
      return event;
    }
  }

  if (bounded.resultBytes > deps.maxInlineBytes) {
    // Dead code, and provably so. Reaching here needs `stored` to hold an
    // `unstoredReason` (the `blob` branch above already fell back), whose
    // descriptor costs at most MAX_SPILL_DESCRIPTOR_BYTES = 768 encoded bytes
    // — 654 worst case, itemized at that constant. The skeleton gate above
    // refused to spill unless `skeleton + 768 <= maxInlineBytes`, and because
    // `spill` serializes last, an empty-preview event is EXACTLY
    // `skeleton + ,"spill":{…}`. So the loop's empty-preview terminal state
    // always measures at or under the cap and returns before this line.
    // Kept as a fail-closed assertion: shipping an event this policy promised
    // to bound would be worse than a loud failure.
    throw new Error(
      `event spill failed to bound a ${spillable.type} event: replacement is ${bounded.resultBytes} bytes against a ${deps.maxInlineBytes}-byte cap (${field} was ${totalBytes} bytes, descriptor overhead ${bounded.overhead} bytes)`,
    );
  }
  return bounded.result;
}
