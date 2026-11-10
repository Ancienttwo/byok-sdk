import { describe, expectTypeOf, it } from 'vitest';
import type { Pool } from 'pg';
import { HostedPasses, type HostedPassPorts } from './passes';
import type { CommandEntryOptions } from './entry';
import type { HostedCollaborationStore } from './store';

declare const pool: Pool;
declare const store: HostedCollaborationStore;
declare const full: Required<HostedPassPorts>;

// The assertions are compile-time: the closures below are typechecked, never run.
describe('HostedPasses ports', () => {
  it('requires each of the seven pass ports', () => {
    const check = () => {
      const { task: _task, ...noTask } = full;
      // @ts-expect-error task is required
      new HostedPasses(pool, store, noTask);
      const { replies: _replies, ...noReplies } = full;
      // @ts-expect-error replies is required
      new HostedPasses(pool, store, noReplies);
      const { devices: _devices, ...noDevices } = full;
      // @ts-expect-error devices is required
      new HostedPasses(pool, store, noDevices);
      const { projections: _projections, ...noProjections } = full;
      // @ts-expect-error projections is required
      new HostedPasses(pool, store, noProjections);
      const { homes: _homes, ...noHomes } = full;
      // @ts-expect-error homes is required
      new HostedPasses(pool, store, noHomes);
      const { sync: _sync, ...noSync } = full;
      // @ts-expect-error sync is required
      new HostedPasses(pool, store, noSync);
      const { intervalMs: _intervalMs, ...noInterval } = full;
      // @ts-expect-error intervalMs is required
      new HostedPasses(pool, store, noInterval);
    };
    expectTypeOf(check).toBeFunction();
  });

  it('compiles without channel, connector and timings, and syncScope fits the entry', () => {
    const check = () => {
      const { channel: _channel, connector: _connector, timings: _timings, ...required } = full;
      const passes = new HostedPasses(pool, store, required);
      const sync: CommandEntryOptions<string>['sync'] = passes.syncScope;
      return sync;
    };
    expectTypeOf(check).toBeFunction();
    expectTypeOf<HostedPasses['syncScope']>().toExtend<CommandEntryOptions<string>['sync']>();
  });
});
