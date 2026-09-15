#!/usr/bin/env node
// The SDK-owned launch-cwd launcher.
//
// `node byok-launch-cwd.mjs <trustedCwd> <command> [...args]` changes this
// process's working directory and then execs the target there. It exists for
// the runtimes whose MCP server configuration has no per-server cwd field
// (claude's `mcpServers` JSON, codex's `-c mcp_servers.*`): their CLI spawns
// the server itself, inheriting its own cwd, which is the Agent home.
//
// Why a chdir'd parent rather than a flag on the child: a `bun --compile`
// binary reads `$cwd/bunfig.toml` and runs its `preload` before any of its own
// code, and `--config=/dev/null` does not suppress that for a compiled binary.
// The cwd the child is exec'd with is the only control point.
//
// Argv is structural: no shell, no quoting, no concatenation. An argument
// containing a space, a quote, `$(...)`, a `;` or a newline is forwarded
// byte-identical.
//
// This file is plain ESM and is shipped as source (`package.json` `files`),
// not bundled: it must be the exact bytes the operator can read, and it must
// run on a Node that has nothing of this package installed.
import { spawn } from 'node:child_process';
import process from 'node:process';

// Names that change how a Node process LOADS code. They take effect before
// this file's first statement, so this cannot sanitize them for itself — it
// can only refuse to continue. `buildRuntimeEnv` (`daemon/environment.ts`)
// hard-denies the same list on the way in; this is the assertion at the point
// where the boundary is actually established.
const LOADER_ENV_DENY = [
  /^NODE_OPTIONS$/,
  /^NODE_REPL_EXTERNAL_MODULE$/,
  /^NODE_PATH$/,
  /^BUN_/,
  /^DYLD_/,
  /^LD_/,
];

function fail(message) {
  process.stderr.write(`byok-launch-cwd: ${message}\n`);
  process.exit(78); // EX_CONFIG
}

// `--import` / `--require` / `--experimental-default-config-file` reach here
// through NODE_OPTIONS or an explicit exec argv, and all of them run before
// the chdir below. An empty execArgv is the only state in which this
// launcher's own load was not influenced by the environment it is protecting
// the child from.
if (process.execArgv.length > 0) {
  fail(`refusing to launch with a non-empty interpreter argv: ${process.execArgv.join(' ')}`);
}

const injected = Object.keys(process.env).filter(
  (name) => LOADER_ENV_DENY.some((pattern) => pattern.test(name)),
);
if (injected.length > 0) {
  fail(`refusing to launch with loader environment variables set: ${injected.sort().join(', ')}`);
}

const [trustedCwd, command, ...args] = process.argv.slice(2);
if (typeof trustedCwd !== 'string' || trustedCwd.length === 0 || typeof command !== 'string' || command.length === 0) {
  fail('usage: byok-launch-cwd <trusted-cwd> <command> [args...]');
}

try {
  process.chdir(trustedCwd);
} catch (error) {
  fail(`could not change directory to ${trustedCwd}: ${error && error.message}`);
}

const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });

// Signals are forwarded rather than handled: the runtime CLI owns this
// process group's lifecycle and must be able to stop the real server through
// the launcher it was given instead of it.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}

child.once('error', (error) => {
  process.stderr.write(`byok-launch-cwd: ${command} could not be spawned: ${error.message}\n`);
  process.exit(126);
});

child.once('exit', (code, signal) => {
  if (signal !== null) {
    // Reproduce the child's own death by signal so the parent sees the same
    // termination it would have seen without this launcher in between. The
    // forwarding handlers installed above must go first, or re-raising would
    // be caught by them instead of killing this process.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
