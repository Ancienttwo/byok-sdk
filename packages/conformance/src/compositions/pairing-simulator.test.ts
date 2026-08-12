/**
 * The in-memory composition running the pairing-simulator conformance suite.
 *
 * Same posture as its store-port siblings in this directory: a factory, and
 * nothing else. Two things it has to translate, and both are shape, not
 * behavior:
 *
 * - `ByokCloud.fetch` is a WHATWG handler (`Request` in, `Response` out); the
 *   simulator takes a `fetch`. One wrapper, no socket, no server.
 * - The SDK mounts no admin route, so pairing-code minting, presence read-back,
 *   and revocation come from `ByokCloud`'s in-process control plane. A hosted
 *   deployment would put its own authenticated routes here instead — which is
 *   exactly why the simulator takes a host adapter rather than guessing paths.
 */
import { createInMemoryByokCloud } from '@byok-sdk/cloud';
import {
  runPairingSimulatorConformance,
  type PairingSimulatorCompositionFactory,
} from '../simulator/index';
import { TENANT_A } from '../cloud/fixtures';

const ORIGIN = 'http://cloud.test';
const PRODUCT_ID = 'conformance-product';

const inMemoryFactory: PairingSimulatorCompositionFactory = {
  create() {
    // Presence throttling off: this suite asserts what the surface accepts, and
    // a minimum-interval 429 would be timing, not contract.
    const { cloud } = createInMemoryByokCloud({ presenceMinimumIntervalMs: 0 });
    return {
      baseUrl: ORIGIN,
      fetch: async (input, init) => cloud.fetch(new Request(input, init)),
      async createPairingCode() {
        return (await cloud.createPairingCode(TENANT_A, { productId: PRODUCT_ID })).code;
      },
      host: {
        listPresence: () => cloud.listPresence(TENANT_A),
        revokeDevice: (deviceId) => cloud.revokeDevice(TENANT_A, deviceId),
      },
    };
  },
};

runPairingSimulatorConformance('in-memory', inMemoryFactory);
