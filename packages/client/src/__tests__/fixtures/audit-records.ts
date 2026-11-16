import { createAuditAppender } from '../../daemon/audit-log';
import type { DaemonRecord } from '../../daemon/daemon-record';

/** Seeds one audit record through the production appender and surfaces its write error. */
export async function appendAuditRecord(storeDir: string, record: DaemonRecord): Promise<void> {
  let failure: { readonly error: unknown } | undefined;
  const appender = createAuditAppender(storeDir, (error) => { failure = { error }; });
  appender.append(record);
  await appender.flush();
  if (failure !== undefined) throw failure.error;
}
