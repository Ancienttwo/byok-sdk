/** The Host side of the k8 bridge domain (`src/bridge/domains/k8.ts`). Owned by A2b #1806; handlers by A3 #1807. */
import path from 'node:path';
import brand from '../../../brand.config.ts';
import type { K8Methods } from '../../bridge/domains/k8.ts';
import { executionCatalog } from '../conversation/catalog.ts';
import { ConversationService } from '../conversation/service.ts';
import type { HostDomain, HostContext } from '../domains.ts';
import { HostStore } from '../store/store.ts';
import { Conversation } from './conversation.ts';

/**
 * Opens the Host store and the K8 conversation on this device's catalog, then binds the server's consumers to it.
 * Closing closes the conversation (and its K8 ledger) before the store; the daemon stops after every domain closed.
 */
export async function createK8Domain(context: HostContext): Promise<HostDomain<K8Methods>> {
  const { deviceId } = context.daemon.status();
  if (deviceId === undefined) throw new Error('The daemon has no device id after start');
  const hostDir = path.join(context.hostStorageRoot, 'host');
  const store = HostStore.open(path.join(hostDir, 'store.sqlite'));
  let conversation: Conversation;
  try {
    conversation = await Conversation.open({
      server: context.server, productId: context.daemonConfig.productId, ledgerFile: path.join(hostDir, 'k8.sqlite'), store,
      ...executionCatalog(brand, deviceId),
    });
  } catch (error) {
    store.close();
    throw error;
  }
  const service = new ConversationService({ conversation, store, server: context.server, brand, changed: context.changed });
  context.consumers.bind({
    consume: async (wake, signal) => {
      await conversation.consume(wake, signal);
      service.changed();
    },
    consumeMessage: async input => {
      const result = await conversation.consumeMessage(input);
      service.changed();
      return result;
    },
  });
  return {
    handlers: {
      'k8.view': params => service.view(params),
      'k8.saveBot': params => service.saveBot(params),
      'k8.archiveBot': params => service.archiveBot(params),
      'k8.send': params => service.send(params),
      'k8.clear': params => service.clear(params),
      'k8.cancel': params => service.cancel(params),
      'k8.answer': params => service.answer(params),
    },
    close: async () => {
      service.close();
      try {
        await conversation.close();
      } finally {
        store.close();
      }
    },
  };
}
