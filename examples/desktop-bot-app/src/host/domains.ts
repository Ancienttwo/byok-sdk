/**
 * The Host's bridge domains. Each domain owns its methods
 * (`src/bridge/domains/<domain>.ts`) and its handlers
 * (`src/host/<domain>/domain.ts`); this file only composes them. A signal one
 * domain gives another meets here, so no domain imports another.
 */
import type { Daemon, DaemonConfig } from '@byok-sdk/client';
import type { ByokServer } from '@byok-sdk/server';
import type { MethodHandlers, MethodTable } from '../bridge/domain.ts';
import type { HostMethods } from '../bridge/protocol.ts';
import { createActivityDomain } from './activity/domain.ts';
import { createK8Domain } from './k8/domain.ts';
import { createKeysDomain } from './keys/domain.ts';
import { createSettingsDomain } from './settings/domain.ts';

/** What a domain composes from: the running Host and the layout and daemon configuration it runs with. */
export interface HostContext {
  readonly daemon: Daemon;
  readonly daemonConfig: DaemonConfig;
  readonly server: ByokServer;
  readonly storeDir: string;
  readonly hostStorageRoot: string;
}

/** One domain on the Host: its handlers, and what it closes before the daemon stops. */
export interface HostDomain<M extends MethodTable<M>> {
  readonly handlers: MethodHandlers<M>;
  close?(): Promise<void>;
}

/** The composed domains: one handler per domain method, closed in reverse order of creation. */
export interface ComposedDomains {
  readonly handlers: MethodHandlers<Omit<HostMethods, 'status'>>;
  close(): Promise<void>;
}

/** Creates every domain in order; a domain that fails to start closes the ones before it, then the failure propagates. */
export async function composeDomains(context: HostContext): Promise<ComposedDomains> {
  const opened: { close?(): Promise<void> }[] = [];
  const close = async () => {
    for (const domain of opened.reverse()) await domain.close?.();
  };
  const open = async <M extends MethodTable<M>>(create: (context: HostContext) => Promise<HostDomain<M>>) => {
    const domain = await create(context);
    opened.push(domain);
    return domain.handlers;
  };
  try {
    const handlers = {
      ...await open(createK8Domain),
      ...await open(createActivityDomain),
      ...await open(createSettingsDomain),
      ...await open(createKeysDomain),
    };
    return { handlers, close };
  } catch (error) {
    await close();
    throw error;
  }
}
