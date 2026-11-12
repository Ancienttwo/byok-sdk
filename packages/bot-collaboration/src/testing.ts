// The `./testing` entry: the shared vectors a Host runs against its own store, the L test host,
// and the K4 test data they use. It runs on vitest.
export { cardCallVectors, cardVectors, coalesceVectors, commitVectors, deviceVectors, homeVectors, replyVectors, roomVectors, seedCollaboration,
  seedRoom, settlementVectors, SYNC_OPTIONS, syncVectors, VECTOR_NOW, type CardCallSubject, type CardSubject, type CoalesceSubject, type CommitSubject,
  type DeviceSubject, type HomeCalls, type HomeSubject, type ReplySubject, type RoomSubject, type SeedTeam, type SettlementSubject,
  type SyncIntentRecord, type SyncSubject } from './commit-vectors.test-support.js';
export { deliveryVectors, FINAL_BODY, replyToken, type DeliverySubject } from './delivery-vectors.test-support.js';
export { policy, template } from './k4-fixtures.test-support.js';
export { openLTestHost, ResultStubAdapter, ResultStubSession, type LTestHost } from './l-test-host.test-support.js';
export { RETENTION_NOW, retentionVectors, type RetentionSubject } from './retention-vectors.test-support.js';
export { routineVectors, type OccurrenceRow, type RoutineSubject } from './routine-vectors.test-support.js';
