/**
 * Sealed payload v1 on the device (#654 E3c). A sealed task's offer carries
 * its frozen `sealing` in plaintext. This module opens the task's sealed
 * input (offer and steers) and seals its output (the 7 daemon-to-server
 * types of `SEALED_SPLIT_TABLE`) with the scope key, through the core
 * functions, fail closed.
 *
 * A task that seals its output never sends plaintext content in those types:
 * each one is sealed, or it is one of the closed plaintext forms (decision
 * 12d), or it is not sent.
 */
import {
  openSealedContent,
  sealContent,
  type SealedBinding,
  type SealedCategory,
  type SealedContentHeaderV1,
  type SealedContentOpenFailure,
} from '@byok-sdk/core/sealed-payload';
import {
  SEALED_INLINE_MAX_PADDED_LENGTH,
  SEALED_PAYLOAD_MAX_CONTENT_LENGTH,
  SEALED_SPLIT_TABLE,
  createEnvelope,
  isSealedMessageType,
  isSealedTaskPlainOutput,
  requiredReceiverCapabilities,
  type AgentRef,
  type BlobRef,
  type Envelope,
  type MessageType,
  type SealedMessageType,
  type SealedSplitEntry,
  type TaskFailure,
  type TaskSealing,
} from '@byok-sdk/protocol';
import { BlobHttpError } from './blob-http-error';
import { routineTemplateBinding, routineTemplateExpired, type RoutineRef } from './sealed-routine-template';
import { DAEMON_TASK_FAILURE, taskFailureField } from './task-failure';

type JsonObject = { [key: string]: unknown };

/** The scope key this device seals a task's output with, and its view of the member chain. */
export interface SealingKey {
  readonly scopeKey: Uint8Array;
  readonly epoch: number;
  /** This device's member id. */
  readonly sender: string;
  /** The member chain head this device verified. */
  readonly chainHead: { readonly seq: number; readonly hash: string };
}

/** The scope keys this device holds, and its view of the member chain (E2d-3: the device member keyring). */
export interface SealedScopeKeyring {
  /** The latest policy categories of a scope this device may use, or `undefined`. */
  scopeCategories(scopeId: string): Promise<readonly SealedCategory[] | undefined>;
  /** The key of one scope epoch, to open content sealed under it. */
  openingKey(scope: { readonly id: string; readonly epoch: number }): Promise<Uint8Array | undefined>;
  /** Whether the authenticated header of opened content passes the sender-view check. */
  acceptHeader(header: SealedContentHeaderV1): Promise<boolean>;
  /** The newest fresh key of the scope at `minEpoch` or later, to seal output. */
  sealingKey(scopeId: string, minEpoch: number): Promise<SealingKey | undefined>;
}

/** Ciphertext blobs: a padded frame above the inline maximum travels as a blob (§8.6). */
export interface SealedCiphertextBlobs {
  /** The blob's bytes after the SHA-256 and size check. */
  download(ref: BlobRef): Promise<Uint8Array>;
  upload(ciphertext: Uint8Array): Promise<BlobRef>;
}

export interface SealedTasksOptions {
  readonly keyring: SealedScopeKeyring;
  readonly tenantId: string;
  readonly deviceId: string;
  readonly blobs: SealedCiphertextBlobs;
  /**
   * The flags the current session's server advertised, which decide whether
   * an output may name its ciphertext blob. `undefined` while the connection
   * is between sessions or a start is under way: the next session's flags
   * are not known yet.
   */
  readonly serverCapabilities: () => readonly string[] | undefined;
}

export type SealedOfferOpenResult =
  | { readonly ok: true; readonly offer: Envelope }
  | { readonly ok: false; readonly code: SealedContentOpenFailure };

interface SealedTask {
  readonly sealing: TaskSealing;
  readonly agentRef: AgentRef | null;
  readonly steerIds: Set<string>;
  /** Keeps this task's outbound in send order while each one is sealed. It holds no envelope. */
  tail: Promise<void>;
}

const SEALED_OUTPUT_TYPE: Partial<Record<MessageType, SealedMessageType>> = Object.fromEntries(
  (Object.keys(SEALED_SPLIT_TABLE) as SealedMessageType[])
    .filter((type) => SEALED_SPLIT_TABLE[type].category === 'task-output')
    .map((type) => [SEALED_SPLIT_TABLE[type].plainType, type]),
);

/** The terminal types; each must reach the wire in some form, or the task never settles. */
const TERMINAL_TYPES: ReadonlySet<MessageType> = new Set(['task.complete', 'task.fail', 'task.cancelled', 'task.decline']);

/**
 * A seal that may succeed later: its ciphertext upload failed short of a
 * final refusal, or the server flags are not known until the next session.
 * The caller seals again later.
 */
class SealedRetryError extends Error {}

/** Fields a `task.fail` keeps when a task that cannot seal reports `sealed_key_unavailable`. */
const UNSEALABLE_FAIL_FIELDS = ['harnessId', 'usage', 'agentRef', 'agentHomeProjection', 'agentHomeMemoryChange'] as const;

function pick(payload: JsonObject, fields: readonly string[]): JsonObject {
  return Object.fromEntries(fields.filter((field) => payload[field] !== undefined).map((field) => [field, payload[field]]));
}

function omit(payload: JsonObject, fields: readonly string[]): JsonObject {
  return Object.fromEntries(Object.entries(payload).filter(([field]) => !fields.includes(field)));
}

export class SealedTasks {
  readonly #tasks = new Map<string, SealedTask>();
  /** Sealed envelope id -> the plaintext envelope it replaced, for the local observer. */
  readonly #plainBySealedId = new Map<string, Envelope>();

  constructor(private readonly options: SealedTasksOptions) {}

  /** Whether this task's output is sealed. */
  sealsOutput(taskId: string | undefined): boolean {
    return taskId !== undefined && this.#tasks.get(taskId)?.sealing.categories.includes('task-output') === true;
  }

  /** Whether this task has a sealing policy at all. */
  isSealed(taskId: string | undefined): boolean {
    return taskId !== undefined && this.#tasks.has(taskId);
  }

  /** Whether this task's input is sealed, so a plaintext steer is a downgrade (§6.2). */
  sealsInput(taskId: string | undefined): boolean {
    return taskId !== undefined && this.#tasks.get(taskId)?.sealing.categories.includes('task-input') === true;
  }

  /**
   * Whether this outbound goes through {@link sealOutbound}: every outbound
   * of a task that seals its output, so one task's sends keep their order.
   * Only its output types are sealed; `task.claim` and the rest pass as they
   * are. Checked synchronously at send time.
   */
  sealsOutbound(envelope: Envelope): boolean {
    return this.sealsOutput(envelope.task_id);
  }

  /**
   * Opens a sealed offer and returns the plaintext offer it seals, or the
   * closed decline code. The offer's categories must cover the scope
   * policy's (design §6.2). A task that seals its output needs a sealing key
   * before it may run, also when its instruction is plaintext; that key is
   * asked for after the input opens, whose chain head can make the epoch
   * fresh. An offer with `routineRef` carries a routine template, which
   * opens under the template binding and only up to its `notAfter`.
   */
  async openOffer(envelope: Envelope): Promise<SealedOfferOpenResult> {
    if (!isSealedMessageType(envelope.type) || envelope.task_id === undefined) return { ok: false, code: 'sealing_policy_mismatch' };
    const taskId = envelope.task_id;
    const entry = SEALED_SPLIT_TABLE[envelope.type];
    const { sealing, sealed, routineRef, ...plain } = envelope.payload as JsonObject & { sealing: TaskSealing; sealed?: JsonObject; routineRef?: RoutineRef };
    const agentRef = (plain.agentRef as AgentRef | undefined) ?? null;
    if (routineRef !== undefined && routineTemplateExpired(routineRef, Date.now())) return { ok: false, code: 'sealing_policy_mismatch' };
    const below = await this.#belowPolicy(sealing);
    if (below !== undefined) return { ok: false, code: below };
    let payload = plain;
    if (sealed !== undefined) {
      const binding = routineRef === undefined
        ? this.#binding(entry.plainType, 'server-to-daemon', { taskId }, sealing, agentRef)
        : routineTemplateBinding(this.options.tenantId, routineRef, agentRef, sealing);
      const opened = await this.#open(sealed, binding, sealing);
      if (!opened.ok) return { ok: false, code: opened.code };
      if (Object.keys(opened.plaintext).some((field) => !(entry.moved as readonly string[]).includes(field))) {
        return { ok: false, code: 'sealed_open_failed' };
      }
      // v1 has no sealing rule for blob bytes, so a sealed instruction is inline text.
      if (typeof opened.plaintext.instruction === 'object' && opened.plaintext.instruction !== null) {
        return { ok: false, code: 'sealing_policy_mismatch' };
      }
      payload = { ...plain, ...opened.plaintext };
    }
    if (sealing.categories.includes('task-output') && await this.#sealingKey(sealing) === undefined) {
      return { ok: false, code: 'sealed_key_unavailable' };
    }
    let offer: Envelope;
    try {
      offer = createEnvelope(entry.plainType, payload as never, { taskId, ...(envelope.seq === undefined ? {} : { seq: envelope.seq }) });
    } catch {
      return { ok: false, code: 'sealed_open_failed' };
    }
    if (!this.#tasks.has(taskId)) this.#tasks.set(taskId, { sealing, agentRef, steerIds: new Set(), tail: Promise.resolve() });
    return { ok: true, offer };
  }

  /**
   * Opens a sealed steer of a sealed task and applies its text once per
   * `steerId` (decision 12a). The id is checked after the open, so it is the
   * authenticated one. A failed apply does not count, so a redelivery is
   * applied. Anything else is dropped with a log line.
   */
  async applySteer(envelope: Envelope, apply: (text: string) => Promise<void>): Promise<void> {
    const taskId = envelope.task_id;
    const task = taskId === undefined ? undefined : this.#tasks.get(taskId);
    const drop = (why: string): undefined => {
      console.error(`[byok/client] sealed task.steer for task ${taskId} dropped: ${why}`);
      return undefined;
    };
    if (taskId === undefined || task === undefined || !task.sealing.categories.includes('task-input')) return drop('the task does not seal task input');
    const { steerId, sealed } = envelope.payload as { steerId: string; sealed: JsonObject };
    const opened = await this.#open(sealed, this.#binding('task.steer', 'server-to-daemon', { taskId, steerId }, task.sealing, task.agentRef), task.sealing);
    if (!opened.ok) return drop(opened.code);
    const { text, ...rest } = opened.plaintext;
    if (typeof text !== 'string' || Object.keys(rest).length > 0) return drop('sealed_open_failed');
    if (task.steerIds.has(steerId)) return drop(`steer ${steerId} was already applied`);
    task.steerIds.add(steerId);
    try {
      await apply(text);
    } catch (error) {
      task.steerIds.delete(steerId);
      throw error;
    }
  }

  /**
   * Seals one outbound envelope of a task that seals its output, in send
   * order. A closed plaintext form, or an envelope that is already sealed,
   * passes as it is and keeps its place. Without a sealing key a terminal
   * becomes its closed plaintext form, and any other type is not sent
   * (`undefined`).
   */
  sealOutbound(envelope: Envelope): Promise<Envelope | undefined> {
    const task = this.#tasks.get(envelope.task_id!)!;
    const sealed = task.tail.then(() => this.#sealOutbound(task, envelope));
    task.tail = sealed.then(() => undefined, () => undefined);
    return sealed;
  }

  async settled(): Promise<void> {
    await Promise.all([...this.#tasks.values()].map((task) => task.tail));
  }

  /**
   * A sealed task's artifact (decision 12b): inline content only, up to the
   * table's `inline` limit, named by a fresh `artifactId`. `undefined` when no
   * sealing key is available.
   */
  async sealArtifact(taskId: string, artifact: { readonly name: string; readonly contentType: string; readonly inline: string }): Promise<Envelope | undefined> {
    const sealed = await this.#seal(taskId, this.#tasks.get(taskId)!, 'task.artifact', { ...artifact, artifactId: crypto.randomUUID() });
    // Local view only: a plaintext artifact this large has no valid wire form.
    if (sealed !== undefined) this.#plainBySealedId.set(sealed.id, { ...sealed, type: 'task.artifact', payload: artifact } as Envelope);
    return sealed;
  }

  /**
   * A terminal the daemon builds from a journaled offer (recovery, or a
   * result over the journal bound), sealed with that offer's context when it
   * seals output. A closed plaintext form, such as `daemon_interrupted`,
   * stays plaintext. With `sealable` false (the keyring is another member's),
   * a terminal that seals output takes its closed plaintext form.
   */
  async sealRecovered(offer: Envelope, terminal: Envelope, sealable = true): Promise<Envelope> {
    const { sealing, agentRef } = offer.payload as { sealing?: TaskSealing; agentRef?: AgentRef };
    if (!isSealedMessageType(offer.type) || sealing === undefined || !sealing.categories.includes('task-output') || isSealedTaskPlainOutput(terminal.type, terminal.payload)) {
      return terminal;
    }
    if (!sealable) return this.unsealable(terminal)!;
    const task: SealedTask = { sealing, agentRef: agentRef ?? null, steerIds: new Set(), tail: Promise.resolve() };
    return (await this.#sealOutbound(task, terminal))!;
  }

  /** The plaintext envelope a sealed outbound replaced, so the local observer keeps reading plaintext. */
  plainOf(envelope: Envelope): Envelope {
    const plain = this.#plainBySealedId.get(envelope.id);
    this.#plainBySealedId.delete(envelope.id);
    return plain ?? envelope;
  }

  async #sealOutbound(task: SealedTask, envelope: Envelope): Promise<Envelope | undefined> {
    if (SEALED_OUTPUT_TYPE[envelope.type] === undefined || isSealedTaskPlainOutput(envelope.type, envelope.payload)) return envelope;
    const taskId = envelope.task_id!;
    const payload = envelope.payload as JsonObject;
    let sealed: Envelope | undefined;
    let plain = envelope;
    try {
      sealed = await this.#seal(taskId, task, envelope.type, payload);
    } catch (error) {
      if (error instanceof SealedRetryError || !TERMINAL_TYPES.has(envelope.type)) throw error;
      // A terminal that cannot be sealed as it is (over the plaintext limit,
      // over an inline-only frame, a ciphertext blob the server refused for good,
      // or not a valid sealed message) would hold the task's terminal commit
      // forever. Settle it with a small sealed failure instead, and show the
      // local observer that failure, not the terminal it replaced.
      console.error(`[byok/client] ${envelope.type} for sealed task ${taskId} replaced by a sealed failure: ${error instanceof Error ? error.message : String(error)}`);
      const failure = { reason: 'terminal_result_unsealable', retryable: false, ...this.#daemonFailure(), ...pick(payload, UNSEALABLE_FAIL_FIELDS) };
      sealed = await this.#seal(taskId, task, 'task.fail', failure);
      plain = createEnvelope('task.fail', failure as never, { taskId });
    }
    if (sealed === undefined) return this.unsealable(envelope);
    this.#plainBySealedId.set(sealed.id, plain);
    return sealed;
  }

  async #seal(taskId: string, task: SealedTask, plainType: MessageType, payload: JsonObject): Promise<Envelope | undefined> {
    const type = SEALED_OUTPUT_TYPE[plainType];
    if (type === undefined) throw new Error(`${plainType} has no sealed form`);
    const entry = SEALED_SPLIT_TABLE[type];
    const present = entry.forbidden.filter((field) => payload[field] !== undefined);
    if (present.length > 0) throw new Error(`${plainType} of sealed task ${taskId} carries ${present.join(', ')}, which ${type} does not carry`);
    const key = await this.#sealingKey(task.sealing);
    if (key === undefined) return undefined;
    const kept = omit(payload, entry.moved);
    const identity = { taskId, ...pick(kept, entry.identity) } as SealedBinding['identity'];
    const { header, ciphertext } = await sealContent({
      scopeKey: key.scopeKey,
      scope: { id: task.sealing.scopeId, epoch: key.epoch },
      chainHead: key.chainHead,
      sender: key.sender,
      category: 'task-output',
      binding: this.#binding(plainType, 'daemon-to-server', identity, task.sealing, task.agentRef),
      plaintext: pick(payload, entry.moved) as never,
      maxContentLength: SEALED_PAYLOAD_MAX_CONTENT_LENGTH,
    });
    if (header.paddedLength <= SEALED_INLINE_MAX_PADDED_LENGTH) {
      return createEnvelope(type, { ...kept, sealed: { ...header, ciphertext: Buffer.from(ciphertext).toString('base64url') } } as never, { taskId });
    }
    // Above the inline frame, the output names its ciphertext blob, but only
    // when the server holds such a blob (§2.5): never for an inline-only type,
    // and only after the server advertised every flag the member needs.
    const inlineOnly = (entry as SealedSplitEntry).inlineOnly === true;
    const advertised = inlineOnly ? [] : this.options.serverCapabilities();
    if (advertised === undefined) {
      throw new SealedRetryError(`${plainType} of sealed task ${taskId} waits for the next session to advertise the server flags`);
    }
    if (inlineOnly
      || !requiredReceiverCapabilities(type, { ...kept, sealed: { ciphertextRef: {} } }).every((flag) => advertised.includes(flag))) {
      throw new Error(`${plainType} of sealed task ${taskId} seals to ${header.paddedLength} bytes, over the inline maximum`);
    }
    const ciphertextRef = omit(await this.#upload(ciphertext) as unknown as JsonObject, ['url']);
    return createEnvelope(type, { ...kept, sealed: { ...header, ciphertextRef } } as never, { taskId });
  }

  async #upload(ciphertext: Uint8Array): Promise<BlobRef> {
    try {
      return await this.options.blobs.upload(ciphertext);
    } catch (error) {
      const message = `ciphertext upload failed: ${error instanceof Error ? error.message : String(error)}`;
      // A 4xx other than a timeout or a rate limit (a quota, the blob size
      // limit, a bad request) refuses every later reservation the same way.
      // A 401 or 403 from the signed content URL is its `sig`/`exp` pair
      // expiring (`docs/protocol.md` §7.1); the next attempt reserves a new URL.
      if (error instanceof BlobHttpError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429
        && !(error.signedUrl && (error.status === 401 || error.status === 403))) {
        throw new Error(message);
      }
      throw new SealedRetryError(message);
    }
  }

  /** The decline code when the scope is not usable, or the offer's categories do not cover its policy (design §6.2). */
  async #belowPolicy(sealing: TaskSealing): Promise<'sealed_key_unavailable' | 'sealing_policy_mismatch' | undefined> {
    const policy = await this.#keyring(() => this.options.keyring.scopeCategories(sealing.scopeId));
    if (policy === undefined) return 'sealed_key_unavailable';
    return policy.some((category) => !(sealing.categories as readonly SealedCategory[]).includes(category)) ? 'sealing_policy_mismatch' : undefined;
  }

  #sealingKey(sealing: TaskSealing): Promise<SealingKey | undefined> {
    return this.#keyring(() => this.options.keyring.sealingKey(sealing.scopeId, sealing.epoch));
  }

  /** A keyring that fails holds no usable key: the caller fails closed as for a missing key. */
  async #keyring<T>(read: () => Promise<T | undefined>): Promise<T | undefined> {
    try {
      return await read();
    } catch (error) {
      console.error(`[byok/client] scope keyring failed: ${error instanceof Error ? error.name : typeof error}`);
      return undefined;
    }
  }

  /**
   * A replacement failure is the daemon's own, so it never keeps the runtime's
   * class. It carries `unknown` when the current server advertises
   * runtime-failure-class; between sessions no flag is known, so it carries none.
   */
  #daemonFailure(): { failure?: TaskFailure } {
    return taskFailureField(DAEMON_TASK_FAILURE, this.options.serverCapabilities() ?? []);
  }

  /** The closed plaintext form of a terminal that has no sealing key (decision 12d). */
  unsealable(envelope: Envelope): Envelope | undefined {
    const taskId = envelope.task_id!;
    const payload = envelope.payload as JsonObject;
    const code = 'sealed_key_unavailable';
    switch (envelope.type) {
      case 'task.complete':
      case 'task.fail':
        return createEnvelope('task.fail', { reason: code, retryable: false, ...this.#daemonFailure(), ...pick(payload, UNSEALABLE_FAIL_FIELDS) } as never, { taskId });
      case 'task.cancelled':
        return createEnvelope('task.cancelled', omit(payload, ['reason']) as never, { taskId });
      case 'task.decline':
        return createEnvelope('task.decline', { reason: code, code, retryable: false, ...pick(payload, ['agentRef']) } as never, { taskId });
      default:
        console.error(`[byok/client] ${envelope.type} for sealed task ${taskId} not sent: no sealing key`);
        return undefined;
    }
  }

  #binding(
    family: MessageType,
    direction: SealedBinding['direction'],
    identity: SealedBinding['identity'],
    sealing: TaskSealing,
    agentRef: AgentRef | null,
  ): SealedBinding {
    return {
      tenantId: this.options.tenantId,
      family,
      direction,
      identity,
      deviceId: this.options.deviceId,
      agentRef: agentRef === null ? null : { agentId: agentRef.agentId, profileRevision: agentRef.profileRevision },
      categories: sealing.categories,
      notAfter: null,
    };
  }

  async #open(
    sealed: JsonObject,
    binding: SealedBinding,
    sealing: TaskSealing,
  ): Promise<{ ok: true; plaintext: JsonObject } | { ok: false; code: SealedContentOpenFailure }> {
    const { ciphertext, ciphertextRef, ...header } = sealed as JsonObject & { ciphertext?: string; ciphertextRef?: BlobRef };
    const scope = header.scope as { id: string; epoch: number };
    const scopeKey = await this.#keyring(() => this.options.keyring.openingKey({ id: scope.id, epoch: scope.epoch }));
    if (scopeKey === undefined) return { ok: false, code: 'sealed_key_unavailable' };
    let bytes: Uint8Array;
    try {
      bytes = ciphertext !== undefined ? Buffer.from(ciphertext, 'base64url') : await this.options.blobs.download(ciphertextRef!);
    } catch {
      return { ok: false, code: 'sealed_open_failed' };
    }
    const opened = await openSealedContent({
      header, ciphertext: bytes, scopeKey, binding,
      sealing: { scopeId: sealing.scopeId, epoch: sealing.epoch },
      maxContentLength: SEALED_PAYLOAD_MAX_CONTENT_LENGTH,
    });
    if (!opened.ok) return { ok: false, code: opened.reason };
    // A stale or foreign sender view fails closed (E2d-e4).
    if (await this.#keyring(() => this.options.keyring.acceptHeader(opened.header)) !== true) return { ok: false, code: 'sealed_open_failed' };
    // The sender-view check can move the chain view forward; the floor holds against the view the task runs under.
    const moved = await this.#belowPolicy(sealing);
    if (moved !== undefined) return { ok: false, code: moved };
    return { ok: true, plaintext: opened.plaintext };
  }
}
