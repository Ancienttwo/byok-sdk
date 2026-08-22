import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PROBE_PATH = fileURLToPath(new URL('./fixtures/pi-rpc-0.84.2-live-probe.mjs', import.meta.url));
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

describe('pinned Pi 0.84.2 RPC packaging probe', () => {
  it('serializes native toolCallId and isError as JSONL without a provider call', async () => {
    const packageJson = JSON.parse(await readFile(PI_PACKAGE_PATH, 'utf8')) as { version?: unknown };
    expect(packageJson.version).toBe('0.84.2');

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
