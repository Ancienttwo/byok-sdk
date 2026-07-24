import { describe, expect, it } from 'vitest';
import {
  canonicalCanaryPaths,
  normalizeTraceEvidence,
  normalSmokeVerdict,
  parseTraceFile,
  positiveControlVerdict,
} from '../../scripts/credential-audit-core.mjs';

const paths = canonicalCanaryPaths('/synthetic-home');
const pathDir = (file) => file.slice(0, file.lastIndexOf('/'));

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

  it('fails closed for unresolved relative canary-relevant paths', () => {
    const evidence = normalizeTraceEvidence(
      [{ name: 'trace.30', text: 'execve(\"/usr/bin/node\", [\"node\", \"/repo/adapter-task-smoke.mjs\"], 0) = 0\nopenat(AT_FDCWD, \".claude/byok-sdk-audit-canary\", O_RDONLY) = 3\n' }],
      paths,
    );
    expect(evidence.unresolvedPaths).toHaveLength(1);
    expect(normalSmokeVerdict(evidence)).toMatchObject({ pass: false });
  });

  it('resolves relative AT_FDCWD paths after an absolute chdir', () => {
    const evidence = normalizeTraceEvidence(
      [{ name: 'trace.31', text: `chdir(\"${pathDir(paths.claude)}\") = 0\nopenat(AT_FDCWD, \"byok-sdk-audit-canary\", O_RDONLY) = 3\n` }],
      paths,
    );
    expect(evidence.canonicalOpens).toHaveLength(1);
    expect(evidence.unresolvedPaths).toEqual([]);
  });

  it('tracks numeric directory fds and dup/close operations', () => {
    const directory = pathDir(paths.codex);
    const evidence = normalizeTraceEvidence(
      [{ name: 'trace.32', text: `open(\"${directory}\", O_RDONLY|O_DIRECTORY) = 3\ndup(3) = 4\nclose(3) = 0\nopenat(4, \"byok-sdk-audit-canary\", O_RDONLY) = 5\n` }],
      paths,
    );
    expect(evidence.canonicalOpens).toMatchObject([{ runtime: 'codex', syscall: 'openat' }]);
    expect(evidence.unresolvedPaths).toEqual([]);
  });

  it('fails closed for unresolved numeric dirfds', () => {
    const evidence = normalizeTraceEvidence(
      [{ name: 'trace.33', text: 'openat(9, \".pi/byok-sdk-audit-canary\", O_RDONLY) = 3\n' }],
      paths,
    );
    expect(evidence.unresolvedPaths).toHaveLength(1);
    expect(normalSmokeVerdict(evidence).pass).toBe(false);
    expect(positiveControlVerdict(evidence, paths).pass).toBe(false);
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
      unresolvedPaths: [],
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
