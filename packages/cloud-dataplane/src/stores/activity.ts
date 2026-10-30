import type { Clock, CollectExpiredInput, CollectExpiredResult, TenantId } from '@byok-sdk/core';
import { ByokCloudError, type ActivityAppendInput, type ActivityReadOptions, type ActivityStore, type ActivityTail } from '@byok-sdk/cloud';
import type { ByokPool } from '../pool';

/** A1 changes the port; A2 supplies the new durable schema and implementation. */
export class PostgresActivityStore implements ActivityStore {
  constructor(_pool: ByokPool, _clock: Clock) {
    throw new ByokCloudError('activity_store_unavailable', 'The durable activity log requires the A2 Postgres adapter. This intermediate stack head is not deployable.');
  }
  async append(_tenant: TenantId, _input: ActivityAppendInput): Promise<ActivityTail> { return this.#unavailable(); }
  async read(_tenant: TenantId, _taskId: string, _options?: ActivityReadOptions): Promise<ActivityTail | undefined> { return this.#unavailable(); }
  async settle(_tenant: TenantId, _taskId: string, _terminalAt: string): Promise<ActivityTail> { return this.#unavailable(); }
  async collectExpired(_tenant: TenantId, _input: CollectExpiredInput): Promise<CollectExpiredResult> { return this.#unavailable(); }
  #unavailable(): never { throw new ByokCloudError('activity_store_unavailable', 'Postgres activity log is unavailable until A2.'); }
}
