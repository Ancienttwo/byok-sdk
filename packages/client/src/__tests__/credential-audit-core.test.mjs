import { describe, expect, it } from 'vitest';
import {
  canonicalCanaryPaths,
  normalizeTraceEvidence,
  normalSmokeVerdict,
  parseTraceFile,
  positiveControlVerdict,
} from '../../scripts/credential-audit-core.mjs';

const paths = canonicalCanaryPaths('/synthetic-home');

describe('credential audit trace parser', () => {
  it('matches canonical opens exactly and attributes fixture roles', () => {
    const evidence = normalizeTraceEvidence(
      [
        {
          name: 'trace.321',
          text: [
            `execve("/usr/bin/node", ["node", "/repo/fake-claude.mjs", "--version"], 0) = 0`,
            `openat(AT_FDCWD, "${paths.claude}", O_RDONLY) = 3`,
            `openat(AT_FDCWD, "${paths.claude}.suffix", O_RDONLY) = 4`,
          ].join('\n'),
        },
      ],
      paths,
    );

    expect(evidence.canonicalOpens).toHaveLength(1);
    expect(evidence.canonicalOpens[0]).toMatchObject({ runtime: 'claude', pid: 321, role: 'fixture:claude' });
    expect(evidence.processes[0].roles).toEqual(['detect:claude', 'fixture:claude']);
  });

  it('requires every runtime canary for a positive control', () => {
    const evidence = normalizeTraceEvidence(
      [
        {
          name: 'trace.99',
          text: [
            'execve("/usr/bin/node", ["node", "/repo/credential-audit-positive-control.mjs"], 0) = 0',
            ...Object.values(paths).map((file) => `open("${file}", O_RDONLY) = 3`),
          ].join('\n'),
        },
      ],
      paths,
    );
    expect(positiveControlVerdict(evidence, paths)).toMatchObject({ pass: true, capturedOpens: 3 });
  });

  it('rejects an incomplete positive control', () => {
    const evidence = normalizeTraceEvidence(
      [{ name: 'trace.100', text: `open("${paths.claude}", O_RDONLY) = 3\n` }],
      paths,
    );
    expect(positiveControlVerdict(evidence, paths)).toMatchObject({
      pass: false,
      missingRuntimes: ['codex', 'pi'],
    });
  });

  it('returns a failing normal-smoke verdict for any canonical access', () => {
    const evidence = normalizeTraceEvidence(
      [{ name: 'trace.7', text: `open("${paths.pi}", O_RDONLY) = 3\n` }],
      paths,
    );
    expect(normalSmokeVerdict(evidence)).toMatchObject({ pass: false, canonicalOpenCount: 1 });
  });

  it('passes a normal trace with no canonical opens when the process is attributed', () => {
    const evidence = normalizeTraceEvidence(
      [{
        name: 'trace.8',
        text: [
          'execve("/usr/bin/node", ["node", "/repo/adapter-task-smoke.mjs"], 0) = 0',
          'read(0, "ordinary", 8) = 8',
        ].join('\n'),
      }],
      paths,
    );
    expect(normalSmokeVerdict(evidence)).toEqual({
      pass: true,
      canonicalOpenCount: 0,
      canonicalOpens: [],
      unresolvedProcesses: [],
    });
    expect(parseTraceFile('', 'trace.8', paths).pid).toBe(8);
  });

  it('fails closed for an unknown zero-open process', () => {
    const evidence = normalizeTraceEvidence(
      [{ name: 'trace.42', text: 'read(0, "ordinary", 8) = 8\\n' }],
      paths,
    );
    expect(normalSmokeVerdict(evidence)).toMatchObject({
      pass: false,
      canonicalOpenCount: 0,
      unresolvedProcesses: [{ traceFile: 'trace.42', pid: 42, role: null }],
    });
  });

  it('inherits a known parent role for an unattributed child', () => {
    const evidence = normalizeTraceEvidence(
      [
        {
          name: 'trace.10',
          text: [
            'execve("/usr/bin/node", ["node", "/repo/adapter-task-smoke.mjs"], 0) = 0',
            'clone(child_stack=NULL, flags=SIGCHLD) = 11',
          ].join('\n'),
        },
        { name: 'trace.11', text: 'read(0, "ordinary", 8) = 8\\n' },
      ],
      paths,
    );
    expect(evidence.unresolvedProcesses).toEqual([]);
    expect(evidence.processes.find((process) => process.pid === 11)).toMatchObject({
      role: 'smoke-node',
      roles: [],
    });
    expect(normalSmokeVerdict(evidence).pass).toBe(true);
  });

  it('fails a positive control with an unresolved traced process', () => {
    const evidence = normalizeTraceEvidence(
      [
        {
          name: 'trace.20',
          text: [
            'execve("/usr/bin/node", ["node", "/repo/credential-audit-positive-control.mjs"], 0) = 0',
            ...Object.values(paths).map((file) => `open("${file}", O_RDONLY) = 3`),
          ].join('\n'),
        },
        { name: 'trace.21', text: 'read(0, "unresolved", 10) = 10\\n' },
      ],
      paths,
    );
    expect(positiveControlVerdict(evidence, paths)).toMatchObject({
      pass: false,
      unresolvedProcesses: [{ traceFile: 'trace.21', pid: 21, role: null }],
    });
  });
});
