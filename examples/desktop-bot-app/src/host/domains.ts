/**
 * The Host's bridge domains. Each domain owns its methods
 * (`src/bridge/domains/<domain>.ts`) and its handlers
 * (`src/host/<domain>/domain.ts`); this file only composes them. A signal one
 * domain gives another meets here, so no domain imports another.
 */
import type { Daemon, DaemonConfig } from '@byok-sdk/client';
import type { AgentMessageInput, BotCollaboration } from '@byok-sdk/bot-collaboration';
import type { ByokServer, DueWake } from '@byok-sdk/server';
import { joinHandlers, type MethodHandlers, type MethodTable } from '../bridge/domain.ts';
import { MAIN_METHODS, type HostMethods, type MainMethod } from '../bridge/protocol.ts';
import { createActivityDomain } from './activity/domain.ts';
import { createK8Domain } from './k8/domain.ts';
import { createKeysDomain } from './keys/domain.ts';
import { createSettingsDomain } from './settings/domain.ts';

/** The embedded server's wake and Agent message consumers. */
export interface ServerConsumers {
  consume(wake: DueWake, signal: AbortSignal): Promise<void>;
  consumeMessage(input: AgentMessageInput): ReturnType<BotCollaboration['consumeMessage']>;
}

/** What a domain composes from: the running Host and the layout and daemon configuration it runs with. */
export interface HostContext {
  readonly daemon: Daemon;
  readonly daemonConfig: DaemonConfig;
  readonly server: ByokServer;
  readonly storeDir: string;
  readonly hostStorageRoot: string;
  /** The server exists before any domain, so its consumers refuse until the k8 domain binds them, once. */
  readonly consumers: { bind(consumers: ServerConsumers): void };
  /** A domain's views changed: the Host pushes its state again, so main hints the renderer to pull. */
  changed(): void;
}

/** One domain on the Host: a handler for each of its methods that main does not answer, and what it closes before the daemon stops. */
export interface HostDomain<M extends MethodTable<M>> {
  readonly handlers: MethodHandlers<Omit<M, MainMethod>>;
  /** Runs after every domain call in flight has settled; no new call reaches the domain once shutdown began. */
  close?(): Promise<void>;
}

/** The composed domains: one handler per domain method, closed in reverse order of creation. */
export interface ComposedDomains {
  readonly handlers: MethodHandlers<Omit<HostMethods, 'status'>>;
  close(): Promise<void>;
}

/** Closes every domain, last created first; then throws the first failure, or all of them. */
async function closeAll(domains: readonly { close?(): Promise<void> }[]): Promise<void> {
  const failures: unknown[] = [];
  for (const domain of [...domains].reverse()) {
    try {
      await domain.close?.();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Bridge domains failed to close');
}

/**
 * Creates every domain in order. A domain that fails to start closes the ones
 * before it, then the failure propagates. A method two domains answer, or a
 * Host handler for a method main answers, refuses the composition.
 */
export async function composeDomains(context: HostContext): Promise<ComposedDomains> {
  const opened: { close?(): Promise<void> }[] = [];
  const open = async <M extends MethodTable<M>>(create: (context: HostContext) => Promise<HostDomain<M>>) => {
    const domain = await create(context);
    opened.push(domain);
    return domain.handlers;
  };
  try {
    const handlers: ComposedDomains['handlers'] = joinHandlers(
      await open(createK8Domain),
      await open(createActivityDomain),
      await open(createSettingsDomain),
      await open(createKeysDomain),
    );
    const misplaced = MAIN_METHODS.find(name => Object.hasOwn(handlers, name));
    if (misplaced) throw new Error(`Bridge method ${misplaced} is answered by main, not the Host`);
    return { handlers, close: () => closeAll(opened) };
  } catch (error) {
    await closeAll(opened);
    throw error;
  }
}
