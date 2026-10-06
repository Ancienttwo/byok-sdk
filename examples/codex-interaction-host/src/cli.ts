#!/usr/bin/env node
import type { RuntimeStartupDisposalFailure } from '@byok-sdk/client';
import { fixtureScenarios, type FixtureScenario } from './scenarios';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--fixture' || !fixtureScenarios.includes(args[1] as FixtureScenario)) {
  console.error(`Usage: node dist/cli.js --fixture <${fixtureScenarios.join('|')}>\nOffline only. No live Codex launcher is provided.`);
  process.exitCode = 2;
} else {
  // Capture intent before the first asynchronous readiness/start operation.
  // The SDK retains disposal ownership; signals never force a raw process exit.
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  let isStartupDisposalFailure: (value: unknown) => value is RuntimeStartupDisposalFailure = (_value): _value is RuntimeStartupDisposalFailure => false;
  try {
    // Invalid arguments do not load the SDK; cancellation intent is captured
    // even while the valid command is loading its public runtime modules.
    const [{ startFixtureHost }, sdk] = await Promise.all([import('./index.js'), import('@byok-sdk/client')]);
    isStartupDisposalFailure = sdk.isRuntimeStartupDisposalFailure;
    const run = await startFixtureHost({ scenario: args[1] as FixtureScenario,
      input: process.stdin, output: process.stdout, signal: controller.signal });
    try { await run.done; } finally { await run.close(); }
  } catch (error) {
    if (isStartupDisposalFailure(error)) {
      try { await error.retryDisposal(); } catch {
        console.error('Process disposal is unresolved; no workspace cleanup or new session was attempted.');
        process.exitCode = 1;
      }
    }
    const expectedAbort = controller.signal.aborted && error instanceof Error && error.name === 'AbortError';
    // Cancel intent never hides unresolved disposal or another real failure.
    if (!expectedAbort) {
      console.error('Reference Host failed closed. No automatic retry or resume.');
      process.exitCode = 1;
    }
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop); process.stdin.pause();
  }
}
