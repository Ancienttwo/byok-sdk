import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolvePiRuntimeIdentity } from '../adapters/pi/resolve-bin';

const PROBE_PATH = fileURLToPath(new URL('./fixtures/pi-rpc-fork-live-probe.mjs', import.meta.url));
const PI_PACKAGE_PATH = fileURLToPath(
  new URL('../../node_modules/@earendil-works/pi-coding-agent/package.json', import.meta.url),
);

interface ProbeResult {
  code: number | null;
  lines: unknown[];
  stderr: string;
}

async function runPinnedPiRpcProbe(): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROBE_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines: unknown[] = [];
    let stdout = '';
    let stderr = '';
    let endedInput = false;

    const finishLines = () => {
      let newline: number;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (line.length > 0) lines.push(JSON.parse(line));
      }
      if (!endedInput && lines.length >= 2) {
        endedInput = true;
        child.stdin.end();
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      try {
        finishLines();
      } catch (error) {
        child.kill();
        reject(error);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        finishLines();
        resolve({ code, lines, stderr });
      } catch (error) {
        reject(error);
      }
    });
  });
}

describe('pinned official Pi RPC packaging probe', () => {
  it('serializes native toolCallId and isError as JSONL without a provider call', async () => {
    // The client manifest pins the official package by its own name at an
    // exact version; the installed manifest must be exactly that artifact.
    const expected = resolvePiRuntimeIdentity();
    // The name anchors the pin to the official scope; the version travels
    // from the same manifest pin, so a version bump needs no edit here. The
    // installed-manifest comparison directly below is the drift check.
    expect(expected.name).toBe('@earendil-works/pi-coding-agent');
    const packageJson = JSON.parse(await readFile(PI_PACKAGE_PATH, 'utf8')) as {
      name?: unknown;
      version?: unknown;
      byokFork?: unknown;
    };
    expect(packageJson.name).toBe(expected.name);
    expect(packageJson.version).toBe(expected.version);
    // The official artifact carries no fork stanza.
    expect(Object.hasOwn(packageJson, 'byokFork')).toBe(false);

    const result = await runPinnedPiRpcProbe();
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.lines).toEqual([
      {
        type: 'tool_execution_start',
        toolCallId: 'pi-probe-tool-call',
        toolName: 'pi_probe_tool',
        args: { input: 'probe' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'pi-probe-tool-call',
        toolName: 'pi_probe_tool',
        result: { content: [{ type: 'text', text: 'probe failure' }] },
        isError: true,
      },
    ]);
  });
});
