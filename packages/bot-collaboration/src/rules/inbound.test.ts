import { expect, it } from 'vitest';
import { inboundDisposition, inboundDispositions, type InboundState } from './inbound';

const state = (turns: InboundState['turns'] = {}, batches: InboundState['inputBatches'] = {}): InboundState => ({ turns, inputBatches: batches });
const row = (id: string, root?: string, filtered?: string, sequence?: number) => ({ id, root, filtered, sequence });
const turn = (id: string, status: string, conclusion?: string) => ({ id, root: id, status, conclusion });

it('reports a filtered message with its refusal code and no Turn', () => {
  expect(inboundDisposition(state(), row('m1', undefined, 'unverified_sender'))).toEqual({ id: 'm1', disposition: 'filtered', code: 'unverified_sender' });
  expect(inboundDisposition(state(), row('m2', undefined, 'not_owner'))).toEqual({ id: 'm2', disposition: 'filtered', code: 'not_owner' });
});

it('reports an open batch as coalesced, then answered after its Turn succeeds', () => {
  expect(inboundDisposition(state({}, { batch: { state: 'open' } }), row('m1', 'batch'))).toEqual({ id: 'm1', disposition: 'coalesced', turnId: 'batch' });
  expect(inboundDisposition(state({ batch: turn('batch', 'queued') }), row('m1', 'batch'))).toEqual({ id: 'm1', disposition: 'coalesced', turnId: 'batch' });
  expect(inboundDisposition(state({ batch: turn('batch', 'succeeded', 'succeeded') }), row('m1', 'batch'))).toEqual({ id: 'm1', disposition: 'answered', turnId: 'batch' });
  expect(inboundDisposition(state({ batch: turn('batch', 'delivered', 'delivered') }), row('m1', 'batch'))).toEqual({ id: 'm1', disposition: 'answered', turnId: 'batch' });
});

it('reports a cancel as cancelled and every other terminal as failed', () => {
  expect(inboundDisposition(state({ t: turn('t', 'failed', 'cancelled') }), row('m1', 't'))).toEqual({ id: 'm1', disposition: 'cancelled', turnId: 't' });
  for (const conclusion of ['failed', 'expired', 'declined', 'superseded', 'abandoned']) {
    expect(inboundDisposition(state({ t: turn('t', 'failed', conclusion) }), row('m1', 't'))).toEqual({ id: 'm1', disposition: 'failed', turnId: 't' });
  }
  // A status alone can make a Turn failed, for example a seat without a conclusion.
  expect(inboundDisposition(state({ t: turn('t', 'failed') }), row('m1', 't'))).toEqual({ id: 'm1', disposition: 'failed', turnId: 't' });
});

it('never leaves a recorded message without a destination', () => {
  // A missing Turn and no open batch is a failed destination, not silence.
  expect(inboundDisposition(state(), row('m1', 'gone'))).toEqual({ id: 'm1', disposition: 'failed', turnId: 'gone' });
  expect(inboundDisposition(state(), row('m2'))).toEqual({ id: 'm2', disposition: 'failed', turnId: 'm2' });
});

it('orders destinations by the ledger sequence, then by id', () => {
  const input: InboundState = { channel: { inbounds: {
    b: row('b', 't', undefined, 2), a: row('a', 't', undefined, 1), c: row('c', undefined, 'not_owner', 1),
  } }, turns: { t: turn('t', 'queued') } };
  expect(inboundDispositions(input).map(row => row.id)).toEqual(['a', 'c', 'b']);
});
