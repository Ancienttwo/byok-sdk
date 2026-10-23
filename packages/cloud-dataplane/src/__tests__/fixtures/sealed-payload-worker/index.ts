/**
 * The sealed-payload v1 vector Worker (#654 E1b).
 *
 * It runs core's runtime-neutral vector checker under local workerd, the
 * runtime of the hosted Host. The checker and the golden file are core's own
 * test files, imported by path, so workerd runs the same checks as the Node
 * and Bun legs. There is no `nodejs_compat` flag: core must run on WebCrypto
 * alone.
 *
 * `GET /vectors` answers the check counts, or a 500 with the first mismatch.
 * Every other path is a 404, which `startWranglerDev` reads as ready.
 */
import golden from '../../../../../core/src/__tests__/golden/sealed-payload-v1.json';
import {
  checkSealedPayloadVectors,
  type SealedPayloadVectors,
} from '../../../../../core/src/__tests__/support/sealed-payload-vectors';

export default {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== '/vectors') return new Response('not found', { status: 404 });
    try {
      const counts = await checkSealedPayloadVectors(golden as unknown as SealedPayloadVectors);
      return Response.json({ ok: true, counts });
    } catch (error) {
      return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  },
};
