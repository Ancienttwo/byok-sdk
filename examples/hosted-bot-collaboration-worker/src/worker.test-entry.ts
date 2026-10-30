import worker from './worker';
export { HostClock } from './worker';

// Only the harness entrypoint exposes this generation's readiness identity.
const entry: typeof worker = {
  ...worker,
  async fetch(request, env, ctx) {
    const identity = (env as typeof env & { H_TEST_INSTANCE: string }).H_TEST_INSTANCE;
    if (new URL(request.url).pathname === `/__test_ready/${identity}`) {
      return new Response(identity);
    }
    return worker.fetch(request, env, ctx);
  },
};
export default entry;
