import type { AgentEvent } from '@byok-sdk/protocol';
import type { ConversationView, EntryRecord, LiveState, ToolSlot } from '@earendil-works/pi-durable';
import type { McpEventIdentities } from '../../mcp/event-identity';
import { servedModelName } from '../served-model';

/** What the durable lane reports from one change of the conversation view. */
export type DurableEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_end'; callId: string; tool: string; entry?: EntryRecord }
  | { type: 'assistant'; entry: EntryRecord }
  /** Retry or compaction became active: both are disabled in this lane. */
  | { type: 'unexpected'; what: 'retry' | 'compaction' };

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const liveOf = (view: ConversationView): LiveState => (view.docs['pi.live'] ?? {}) as LiveState;
const firstMessage = (entry: EntryRecord): Record<string, unknown> => object(Array.isArray(entry.model) ? entry.model[0] : undefined);
/** Text of each content block by index; non-text blocks are absent. */
function textBlocks(message: unknown): string[] {
  const content = object(message).content;
  const texts: string[] = [];
  if (Array.isArray(content)) content.forEach((block, index) => { const part = object(block); if (part.type === 'text' && typeof part.text === 'string') texts[index] = part.text; });
  return texts;
}

/**
 * Projects successive values of `Conversation.watch()` into durable lane
 * events. pi-durable 1.5 removed its event stream; the view's `pi.live`
 * document and appended entries carry the same facts. Entries are read by ID,
 * so a window that dropped entries while the listener was busy is filled from
 * `missed`, which the caller pages from committed history.
 */
export class DurableViewProjection {
  #last: number;
  #slots = new Map<string, ToolSlot>();
  /** Done slots still listed in `pi.live`: their end was already reported. */
  #ended = new Set<string>();
  /** Text already reported per content block of the streamed answer. */
  #released: string[] = [];
  #streaming = false;
  #retry = false;
  #compacting = false;

  /** The attachment value is history: only later changes are reported. */
  constructor(initial: ConversationView) {
    this.#last = initial.entries.at(-1)?.id ?? initial.before ?? 0;
    const live = liveOf(initial);
    for (const slot of live.tools ?? []) if (slot.status !== 'done') this.#slots.set(slot.callId, slot); else this.#ended.add(slot.callId);
    if (live.generation?.message !== undefined) { this.#streaming = true; this.#released = textBlocks(live.generation.message); }
    this.#retry = live.generation?.retry !== undefined;
    this.#compacting = (live.compactions?.length ?? 0) > 0;
  }

  /** Newest entry ID already reported. */
  get last(): number { return this.#last; }

  /** The newest entry before `view`'s window that was not reported, if the window skipped any. */
  missing(view: ConversationView): { minEntryId: number; maxEntryId: number } | undefined {
    const first = view.entries[0]?.id;
    return view.before !== undefined && first !== undefined && view.before > this.#last ? { minEntryId: this.#last + 1, maxEntryId: view.before } : undefined;
  }

  advance(view: ConversationView, missed: readonly EntryRecord[] = []): DurableEvent[] {
    const live = liveOf(view);
    const appended = [...missed, ...view.entries].filter(entry => entry.id > this.#last);
    appended.sort((a, b) => a.id - b.id);
    const events: DurableEvent[] = [];
    // Tool calls that end now: a slot that becomes done, one created done, or one that vanished with its run.
    const ends: { slot: ToolSlot; entryId?: number }[] = [];
    const now = new Map((live.tools ?? []).map(slot => [slot.callId, slot]));
    for (const [callId, previous] of this.#slots) {
      const slot = now.get(callId);
      if (slot?.status === 'done') ends.push({ slot, entryId: slot.entry });
      else if (slot === undefined) ends.push({ slot: previous, entryId: appended.find(entry => firstMessage(entry).role === 'toolResult' && firstMessage(entry).toolCallId === callId)?.id });
    }
    for (const slot of now.values()) if (slot.status === 'done' && !this.#slots.has(slot.callId) && !this.#ended.has(slot.callId)) ends.push({ slot, entryId: slot.entry });
    this.#slots = new Map([...now].filter(([, slot]) => slot.status !== 'done'));
    this.#ended = new Set([...now.values()].filter(slot => slot.status === 'done').map(slot => slot.callId));
    // Entries in append order; a tool's end directly precedes its result's message.
    const endOf = ({ slot, entryId }: { slot: ToolSlot; entryId?: number }, entry?: EntryRecord): DurableEvent =>
      ({ type: 'tool_end', callId: slot.callId, tool: slot.name, ...(entry === undefined || entryId === undefined ? {} : { entry }) });
    for (const entry of appended) {
      for (const end of ends) if (end.entryId === entry.id) events.push(endOf(end, entry));
      if (entry.kind === 'pi.assistant' && firstMessage(entry).role === 'assistant') {
        // An answer that arrived between two values was never streamed: report all of it.
        this.#release(textBlocks(firstMessage(entry)), events);
        this.#streaming = false; this.#released = [];
        events.push({ type: 'assistant', entry });
      }
    }
    for (const end of ends) if (end.entryId === undefined || !appended.some(entry => entry.id === end.entryId)) events.push(endOf(end));
    // The streamed answer comes last: a value can fold earlier rounds' entries
    // with the next round's partial, never with its own, because pi-durable
    // clears the partial in the commit that appends the round's assistant entry.
    const partial = live.generation?.message;
    if (partial !== undefined) {
      if (!this.#streaming) { this.#streaming = true; this.#released = []; }
      this.#release(textBlocks(partial), events);
    } else if (this.#streaming && live.generation === undefined) { this.#streaming = false; this.#released = []; }
    const retry = live.generation?.retry !== undefined, compacting = (live.compactions?.length ?? 0) > 0;
    if (retry && !this.#retry) events.push({ type: 'unexpected', what: 'retry' });
    if (compacting && !this.#compacting) events.push({ type: 'unexpected', what: 'compaction' });
    this.#retry = retry; this.#compacting = compacting;
    if (appended.length > 0) this.#last = Math.max(this.#last, appended.at(-1)!.id);
    return events;
  }

  #release(texts: readonly string[], events: DurableEvent[]): void {
    texts.forEach((text, index) => {
      const released = this.#released[index] ?? '';
      if (text.length > released.length && text.startsWith(released)) events.push({ type: 'text', delta: text.slice(released.length) });
      this.#released[index] = text;
    });
  }
}

/**
 * `mcp` by the exact registered name (`mcp__<server>__<tool>`) of a tool in the
 * daemon's observed toolsets. A builtin, an SDK-reserved helper (registered
 * bare) or any other name gets none; the name is never split.
 */
export function withMcpIdentity(event: AgentEvent, identities: McpEventIdentities): AgentEvent {
  if (event.type !== 'tool_use' && event.type !== 'tool_result') return event;
  const mcp = identities.get(event.tool);
  return mcp === undefined ? event : { ...event, mcp };
}
/** Run boundaries never complete a BYOK execution; the engine decides that after idle. */
export function projectDurableEvent(event: DurableEvent): AgentEvent[] {
  if (event.type === 'text') return [{ type: 'progress', text: event.delta }];
  if (event.type === 'tool_end') {
    if (!event.callId) throw new Error('durable tool result has no authoritative id');
    const message = event.entry === undefined ? {} : firstMessage(event.entry);
    return [{ type: 'tool_result', tool: event.tool, toolCallId: event.callId, output: message, isError: event.entry === undefined || message.isError === true }];
  }
  if (event.type === 'unexpected') return [{ type: 'error', message: 'durable slice 1 unexpectedly activated retry or compaction' }];
  const message = firstMessage(event.entry);
  const usage = object(message.usage);
  const input = usage.input, cacheRead = usage.cacheRead, cacheWrite = usage.cacheWrite;
  const sum = count(input) && count(cacheRead) && count(cacheWrite) ? input + cacheRead + cacheWrite : undefined;
  const model = servedModelName(message.responseModel);
  return [{ type: 'usage', ...(sum !== undefined && count(sum) ? { inputTokens: sum } : {}),
    ...(count(cacheRead) ? { cachedInputTokens: cacheRead } : {}), ...(count(usage.output) ? { outputTokens: usage.output } : {}), ...(count(usage.totalTokens) ? { totalTokens: usage.totalTokens } : {}),
    ...(model === undefined ? {} : { model }) }];
}
