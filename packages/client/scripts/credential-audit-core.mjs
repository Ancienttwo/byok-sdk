import path from 'node:path';

/** The only paths the Linux audit treats as credential canaries. */
export const CANARY_RELATIVE_PATHS = Object.freeze({
  claude: path.join('.claude', 'byok-sdk-audit-canary'),
  codex: path.join('.codex', 'byok-sdk-audit-canary'),
  pi: path.join('.pi', 'byok-sdk-audit-canary'),
});

export function canonicalCanaryPaths(home) {
  return Object.fromEntries(
    Object.entries(CANARY_RELATIVE_PATHS).map(([runtime, relative]) => [runtime, path.resolve(home, relative)]),
  );
}

function decodeStraceString(value) {
  // strace quotes paths using C-style escapes. Canary paths contain no characters
  // that need escaping, but decoding the common forms keeps matching exact rather
  // than relying on a substring search.
  return value
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r');
}

function pidFromTraceName(fileName) {
  const match = /\.(\d+)$/.exec(fileName);
  return match ? Number(match[1]) : undefined;
}

function pidFromLine(line) {
  const match = /^\s*\[pid\s+(\d+)\]\s+/.exec(line);
  return match ? Number(match[1]) : undefined;
}

function roleHints(line) {
  const roles = [];
  if (line.includes('credential-audit-positive-control')) roles.push('positive-control');
  if (line.includes('fake-claude.mjs')) {
    roles.push('fixture:claude');
    if (line.includes('--version') || (line.includes('auth') && line.includes('status'))) roles.push('detect:claude');
    if (line.includes('--verbose')) roles.push('task:claude');
  }
  if (line.includes('fake-codex.mjs')) {
    roles.push('fixture:codex');
    if (line.includes('--version') || (line.includes('login') && line.includes('status'))) roles.push('detect:codex');
    if (/"exec"/.test(line)) roles.push('task:codex');
  }
  if (line.includes('fake-pi.mjs')) {
    roles.push('fixture:pi');
    if (line.includes('--version')) roles.push('detect:pi');
    if (line.includes('--mode')) roles.push('task:pi');
  }
  if (line.includes('adapter-task-smoke.mjs')) roles.push('smoke-node');
  return roles;
}

function preferredRole(roles, pid) {
  const ordered = ['positive-control', 'fixture:claude', 'fixture:codex', 'fixture:pi', 'task:claude', 'task:codex', 'task:pi', 'detect:claude', 'detect:codex', 'detect:pi', 'smoke-node'];
  return ordered.find((role) => roles.includes(role)) ?? (pid === undefined ? 'unknown' : `pid:${pid}`);
}

function quotedArgsPath(line, syscall) {
  const marker = `${syscall}(`;
  const start = line.indexOf(marker);
  if (start < 0) return undefined;
  const rest = line.slice(start + marker.length);
  const match = /"((?:\\.|[^"\\])*)"/.exec(rest);
  return match ? decodeStraceString(match[1]) : undefined;
}

function syscallReturn(line, syscall) {
  const marker = `${syscall}(`;
  const start = line.indexOf(marker);
  if (start < 0) return undefined;
  const result = /\)\s+=\s+(-?\d+)/.exec(line.slice(start));
  return result ? Number(result[1]) : undefined;
}

function processReturnPid(line, syscall) {
  const result = syscallReturn(line, syscall);
  return result !== undefined && result >= 0 ? result : undefined;
}

function syscallSucceeded(line, syscall) {
  return syscallReturn(line, syscall) === 0;
}

function syscallNumericArg(line, syscall, index = 0) {
  const marker = `${syscall}(`;
  const start = line.indexOf(marker);
  if (start < 0) return undefined;
  const rest = line.slice(start + marker.length);
  const end = rest.indexOf(')');
  const value = (end < 0 ? rest : rest.slice(0, end)).split(',')[index]?.trim();
  return /^\d+$/.test(value ?? '') ? Number(value) : undefined;
}

function openatDirfd(line) {
  const marker = 'openat(';
  const start = line.indexOf(marker);
  if (start < 0) return undefined;
  const rest = line.slice(start + marker.length);
  const token = /^\s*([^,]+),/.exec(rest)?.[1]?.trim();
  if (!token) return undefined;
  if (token === 'AT_FDCWD') return 'AT_FDCWD';
  return /^\d+$/.test(token) ? Number(token) : undefined;
}

function openFlagsContainDirectory(line, syscall) {
  const marker = `${syscall}(`;
  const start = line.indexOf(marker);
  return start >= 0 && line.slice(start).includes('O_DIRECTORY');
}

function isPotentialCanaryPath(rawPath, canonicalPaths) {
  return Object.values(canonicalPaths).some((canonical) => path.basename(rawPath) === path.basename(canonical));
}

function isCanaryAncestor(candidate, canonicalPaths) {
  return Object.values(canonicalPaths).some((canonical) => {
    const relative = path.relative(candidate, canonical);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}

function resolvePath(rawPath, base) {
  if (path.isAbsolute(rawPath)) return path.normalize(rawPath);
  return base === undefined ? undefined : path.resolve(base, rawPath);
}

function execEvidence(line) {
  if (!/\bexecve\(/.test(line)) return undefined;
  const executable = quotedArgsPath(line, 'execve');
  if (!executable) return undefined;
  return { executable, roles: roleHints(line) };
}

function cloneProcessState(state) {
  return { cwd: state.cwd, descriptors: new Map(state.descriptors) };
}

/** Parse one strace -ff output file, retaining exact canonical opens only. */
export function parseTraceFile(text, fileName, canonicalPaths) {
  const filePid = pidFromTraceName(fileName);
  const processes = new Set();
  const observations = new Map();
  const relationships = [];
  const execs = [];
  const opens = [];
  const unresolvedPaths = [];
  const unresolvedProcessStates = [];
  const states = new Map();
  const stateFor = (pid) => {
    let state = states.get(pid);
    if (!state) {
      state = { cwd: undefined, descriptors: new Map() };
      states.set(pid, state);
    }
    return state;
  };

  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const linePid = pidFromLine(line);
    const processPid = linePid ?? filePid;
    const state = stateFor(processPid);
    const exec = execEvidence(line);
    const hints = exec?.roles ?? [];
    if (exec) execs.push({ ...exec, pid: processPid });
    for (const hint of hints) {
      processes.add(hint);
      const observed = observations.get(processPid) ?? new Set();
      observed.add(hint);
      observations.set(processPid, observed);
    }

    for (const syscall of ['clone', 'clone3', 'fork', 'vfork']) {
      const childPid = processReturnPid(line, syscall);
      if (childPid !== undefined) {
        relationships.push({ parentPid: processPid, childPid, syscall });
        states.set(childPid, cloneProcessState(state));
      }
    }

    const chdirPath = quotedArgsPath(line, 'chdir');
    if (chdirPath !== undefined && syscallSucceeded(line, 'chdir')) {
      const resolved = resolvePath(chdirPath, state.cwd);
      if (resolved === undefined) {
        state.cwd = undefined;
        unresolvedProcessStates.push({ pid: processPid, traceFile: fileName, syscall: 'chdir', reason: 'relative cwd cannot be resolved', line });
      } else {
        state.cwd = resolved;
      }
    }

    const fchdirFd = syscallNumericArg(line, 'fchdir');
    if (fchdirFd !== undefined && syscallSucceeded(line, 'fchdir')) {
      const descriptor = state.descriptors.get(fchdirFd);
      if (descriptor?.directory && descriptor.path !== undefined) {
        state.cwd = descriptor.path;
      } else {
        state.cwd = undefined;
        unresolvedProcessStates.push({ pid: processPid, traceFile: fileName, syscall: 'fchdir', fd: fchdirFd, reason: 'directory fd cannot be resolved', line });
      }
    }

    const closeFd = syscallNumericArg(line, 'close');
    if (closeFd !== undefined && syscallSucceeded(line, 'close')) state.descriptors.delete(closeFd);
    for (const syscall of ['dup', 'dup2', 'dup3']) {
      const sourceFd = syscallNumericArg(line, syscall, 0);
      const resultFd = syscallReturn(line, syscall);
      const targetFd = syscall === 'dup' ? resultFd : syscallNumericArg(line, syscall, 1);
      if (sourceFd === undefined || targetFd === undefined || resultFd === undefined || resultFd < 0) continue;
      const descriptor = state.descriptors.get(sourceFd);
      if (descriptor) state.descriptors.set(targetFd, { ...descriptor });
      else state.descriptors.delete(targetFd);
    }
    const fcntlSourceFd = syscallNumericArg(line, 'fcntl');
    if (fcntlSourceFd !== undefined && /F_DUPFD(?:_CLOEXEC)?/.test(line)) {
      const resultFd = syscallReturn(line, 'fcntl');
      if (resultFd !== undefined && resultFd >= 0) {
        const descriptor = state.descriptors.get(fcntlSourceFd);
        if (descriptor) state.descriptors.set(resultFd, { ...descriptor });
        else state.descriptors.delete(resultFd);
      }
    }

    const syscallMatch = /\b(openat|open)\(/.exec(line);
    if (!syscallMatch) continue;
    const syscall = syscallMatch[1];
    const openedPath = quotedArgsPath(line, syscall);
    if (openedPath === undefined) continue;
    const dirfd = syscall === 'openat' ? openatDirfd(line) : 'AT_FDCWD';
    const relative = !path.isAbsolute(openedPath);
    let base = state.cwd;
    let resolutionFailure;
    if (syscall === 'openat' && dirfd !== 'AT_FDCWD' && relative) {
      const descriptor = dirfd === undefined ? undefined : state.descriptors.get(dirfd);
      if (descriptor?.directory && descriptor.path !== undefined) base = descriptor.path;
      else {
        base = undefined;
        resolutionFailure = descriptor ? 'numeric dirfd is not a known directory' : 'numeric dirfd is unresolved';
      }
    }
    const resolvedPath = resolvePath(openedPath, base);
    if (relative && resolvedPath === undefined && isPotentialCanaryPath(openedPath, canonicalPaths)) {
      unresolvedPaths.push({ path: openedPath, rawPath: openedPath, syscall, dirfd, pid: processPid, role: hints[0], roles: hints, traceFile: fileName, reason: resolutionFailure ?? (syscall === 'openat' && dirfd !== 'AT_FDCWD' ? 'relative path has an unresolved directory fd' : 'relative path has an unresolved cwd'), line });
    }
    const runtime = resolvedPath === undefined ? undefined : Object.entries(canonicalPaths).find(([, canonical]) => resolvedPath === canonical)?.[0];
    const resultFd = syscallReturn(line, syscall);
    if (resultFd !== undefined && resultFd >= 0) {
      const directory = openFlagsContainDirectory(line, syscall) || (resolvedPath !== undefined && isCanaryAncestor(resolvedPath, canonicalPaths));
      state.descriptors.set(resultFd, { path: resolvedPath, directory });
    }
    if (runtime) opens.push({ runtime, path: resolvedPath, syscall, pid: processPid, role: hints[0], roles: hints, traceFile: fileName, line });
  }

  const sortedRoles = [...processes].sort();
  const role = preferredRole(sortedRoles, filePid);
  for (const open of opens) {
    open.role = open.role ?? role;
    open.roles = open.roles.length > 0 ? open.roles : sortedRoles;
  }
  for (const unresolved of [...unresolvedPaths, ...unresolvedProcessStates]) {
    unresolved.role = unresolved.role ?? role;
    unresolved.roles = unresolved.roles.length > 0 ? unresolved.roles : sortedRoles;
  }
  return {
    traceFile: fileName,
    pid: filePid,
    role,
    roles: sortedRoles,
    execs: [...new Map(execs.map((exec) => [`${exec.pid ?? 'root'}\u0000${exec.executable}`, exec])).values()].sort((a, b) => `${a.pid ?? ''}\u0000${a.executable}`.localeCompare(`${b.pid ?? ''}\u0000${b.executable}`)),
    observations: [...observations.entries()].map(([pid, rolesForPid]) => ({ pid, roles: [...rolesForPid].sort() })),
    relationships,
    opens,
    unresolvedPaths,
    unresolvedProcessStates,
  };
}

function directRolesForEntry(entry) {
  const direct = new Set();
  for (const observation of entry.observations) {
    if (observation.pid === entry.pid || (entry.pid === undefined && observation.pid === undefined)) {
      observation.roles.forEach((role) => direct.add(role));
    }
  }
  return [...direct].sort();
}

/** Normalize all trace files into a stable, sorted evidence object. */
export function normalizeTraceEvidence(files, canonicalPaths) {
  const parsed = files
    .map(({ name, text }) => parseTraceFile(text, name, canonicalPaths))
    .sort((a, b) => a.traceFile.localeCompare(b.traceFile));
  const byPid = new Map(parsed.filter((entry) => entry.pid !== undefined).map((entry) => [entry.pid, entry]));
  const directRoles = new Map(parsed.map((entry) => [entry.traceFile, directRolesForEntry(entry)]));
  const parentByChildPid = new Map();
  for (const entry of parsed) {
    for (const relationship of entry.relationships) {
      if (byPid.has(relationship.childPid)) parentByChildPid.set(relationship.childPid, relationship.parentPid);
    }
  }

  const resolvedRoles = new Map();
  const resolveEntry = (entry, visiting = new Set()) => {
    if (resolvedRoles.has(entry.traceFile)) return resolvedRoles.get(entry.traceFile);
    if (visiting.has(entry.traceFile)) return undefined;
    visiting.add(entry.traceFile);
    const direct = directRoles.get(entry.traceFile) ?? [];
    let role = direct.length > 0 ? preferredRole(direct, entry.pid) : undefined;
    if (!role && entry.pid !== undefined) {
      const parentPid = parentByChildPid.get(entry.pid);
      const parent = parentPid === undefined ? undefined : byPid.get(parentPid);
      if (parent) role = resolveEntry(parent, visiting);
    }
    resolvedRoles.set(entry.traceFile, role);
    return role;
  };
  parsed.forEach((entry) => resolveEntry(entry));

  const processes = parsed.map((entry) => {
    const roles = directRoles.get(entry.traceFile) ?? [];
    return {
      traceFile: entry.traceFile,
      pid: entry.pid,
      role: resolvedRoles.get(entry.traceFile) ?? null,
      roles,
      execs: [...new Set(entry.execs.map((exec) => exec.executable))].sort(),
    };
  });
  const processByPid = new Map(parsed.filter((entry) => entry.pid !== undefined).map((entry) => [entry.pid, entry.traceFile]));
  const canonicalOpens = parsed
    .flatMap((entry) => entry.opens.map((open) => {
      const traceFile = open.pid !== undefined ? processByPid.get(open.pid) ?? entry.traceFile : entry.traceFile;
      const process = processes.find((candidate) => candidate.traceFile === traceFile);
      return { ...open, traceFile, role: process?.role ?? null, roles: process?.roles ?? [] };
    }))
    .sort((a, b) => `${a.path}\u0000${a.traceFile}\u0000${a.line}`.localeCompare(`${b.path}\u0000${b.traceFile}\u0000${b.line}`));
  const unresolvedPaths = parsed.flatMap((entry) => [...entry.unresolvedPaths, ...entry.unresolvedProcessStates].map((unresolved) => {
    const traceFile = unresolved.pid !== undefined ? processByPid.get(unresolved.pid) ?? entry.traceFile : entry.traceFile;
    const process = processes.find((candidate) => candidate.traceFile === traceFile);
    return { ...unresolved, traceFile, role: process?.role ?? null, roles: process?.roles ?? [] };
  }));
  const unresolvedProcesses = processes.filter((process) => process.role === null);
  return {
    traceFiles: parsed.map((entry) => entry.traceFile),
    processes,
    unresolvedProcesses,
    unresolvedPaths,
    canonicalOpens,
  };
}

export function positiveControlVerdict(evidence, canonicalPaths) {
  const unresolvedPaths = evidence.unresolvedPaths ?? [];
  const missing = Object.entries(canonicalPaths)
    .filter(([, canonical]) => !evidence.canonicalOpens.some((open) => open.path === canonical))
    .map(([runtime]) => runtime)
    .sort();
  const positiveControlProcesses = evidence.processes.filter((process) => process.role === 'positive-control' || process.roles.includes('positive-control'));
  return {
    pass: missing.length === 0 && evidence.unresolvedProcesses.length === 0 && unresolvedPaths.length === 0 && positiveControlProcesses.length > 0,
    expectedRuntimes: Object.keys(canonicalPaths).sort(),
    missingRuntimes: missing,
    capturedOpens: evidence.canonicalOpens.length,
    unresolvedProcesses: evidence.unresolvedProcesses,
    unresolvedPaths,
    positiveControlProcesses,
  };
}

export function normalSmokeVerdict(evidence) {
  const unresolvedPaths = evidence.unresolvedPaths ?? [];
  return {
    pass: evidence.canonicalOpens.length === 0 && evidence.unresolvedProcesses.length === 0 && unresolvedPaths.length === 0,
    canonicalOpenCount: evidence.canonicalOpens.length,
    canonicalOpens: evidence.canonicalOpens,
    unresolvedProcesses: evidence.unresolvedProcesses,
    unresolvedPaths,
  };
}
