import { promises as fs, type Dir, type Dirent, type Stats } from 'node:fs';
import path from 'node:path';
import type { AgentHomeManager } from '../../agent-home.js';
import { AGENT_HOME_READER_RUN_MAX_RETAINED } from '../../agent-home-readers.js';
import { acquireReplicaLock, resetReplica } from '../../adapters/pi-durable/replica.js';
import { atomicWriteFile } from '../../util/atomic-write.js';
import { AGENT_RESULT_DIRECTORY, AGENT_RESULT_MAX_RETAINED, AGENT_RESULT_RECORD_NAME, AGENT_RESULT_TEMP_NAME, pruneAgentResults } from '../agent-result-store.js';
import { sessionFileName, type AgentSessionHandoffStore } from '../agent-session-handoff-store.js';
import type { InputPreparationService } from '../input-preparation-service.js';
import type { JournalIdentity, LocalTaskJournal } from '../journal/journal.js';
import { withRelease } from '../../util/with-release.js';
import { acquirePathMutationGate, PathMutationGateBusyError, withGateReleaseFailures } from '../../util/path-mutation-gate.js';
import { readInstalledSkillPack, skillPacksRoot } from '../skill-pack-installer.js';
import type { ResolvedStorageConfig } from './config.js';
import { EXPIRING_CLASS_IDS, PROTECTED_CLASS_BOUNDS, PROTECTED_CLASS_IDS, RetentionRegistry, type ClassAuthority, type ProtectedClassId, type ClassUsage, type ExpiringClassId, type RetentionClassId, type SweepBudget } from './registry.js';
import type { ScratchRoot } from './scratch.js';
import { authorityBudget, classBudget } from './runtime-accounting.js';
import { TreeCleanup } from './tree-cleanup.js';
import { selectReaderRuns } from '../../agent-home-reader-retention.js';
import { RuntimeCleanup } from './runtime-cleanup.js';
import { agentSessionFileTtlMs, isAgentSessionLedgerName, isAgentTaskTerminalName, codexThreadIdFromRolloutName, isCodexRolloutFileName, isPiSessionFileName, piSessionRefFromFileName, pruneByLastWrite } from './session-ledgers.js';
import { existingDirectory, measureTree, removeOwnedPath } from './usage.js';
import { acquireAgySessionRetention, agySessionPaths, isAgyConversationFileName } from '../../util/agy-session-retention.js';
import { acquirePiSessionDiscovery, acquirePiSessionRetention, acquirePiSessionWriter, acquirePiSessionRebinding } from '../../util/pi-session-retention.js';

interface ProducerOptions {
  readonly storeDir: string;
  readonly scratch: ScratchRoot;
  readonly config: ResolvedStorageConfig;
  readonly journal: () => LocalTaskJournal | undefined;
  readonly identity: () => JournalIdentity | undefined;
  readonly preparation: () => InputPreparationService | undefined;
  readonly home?: AgentHomeManager;
  readonly handoffs?: AgentSessionHandoffStore;
  /** Folded `DaemonConfig.piByokLauncher.sessionDir`: the SDK expires Pi's own session files in it. */
  readonly piSessionDir?: string;
  /** `<home>/.gemini/antigravity-cli` of `DaemonConfig.runtimes.agy`: the SDK owns that home, so it expires what agy keeps there. */
  readonly agySessionStore?: string;
  readonly clock: () => Date;
  /** Entries one usage walk visits before it stops and reports truncated classes. */
  readonly usageScanLimit?: number;
}
const inside = (root: string, target: string): boolean => target === root || target.startsWith(`${root}${path.sep}`);
const TOKEN = /^[a-f0-9]{12}$/u;
const HOME_TEMP = /^\.byok-(?:memory|agent-memory)-[a-f0-9-]{36}\.tmp$/u;

/** Concrete producers, not a table that a Host must remember to populate. */
export function createRetentionRegistry(options: ProducerOptions): RetentionRegistry {
  const { storeDir, scratch, config, clock } = options;
  const { piSessionDir, agySessionStore } = options;
  const execRoot = path.join(scratch.root, 'exec');
  const daemonRoot = path.join(storeDir, 'tmp', 'daemon');
  const replicas = path.join(storeDir, 'durable-replicas');
  // Open cursors resume between passes: a large prefix of unexpired items cannot starve old tails.
  const cursors = new Map<string, Dir>();
  const codexWalks = new Map<string, { pending: string[]; current?: string }>();
  /** Drops a home's walk and closes the cursors it left open. */
  async function dropCodexWalk(home: string): Promise<void> {
    codexWalks.delete(home);
    for (const [key, directory] of [...cursors]) if (key.startsWith(`codex-session-store\0${home}${path.sep}`)) { cursors.delete(key); await directory.close().catch(() => undefined); }
  }
  async function* entries(id: ExpiringClassId, root: string, budget: SweepBudget): AsyncGenerator<Dirent> {
    if (!await existingDirectory(root)) return;
    if (id === 'exec-sdk' && budget.trigger === 'startup') {
      // Startup must prove the whole SDK namespace clean, even with arbitrarily
      // many released executions. Only enumeration bypasses the maintenance
      // share; reclaimTree still consumes the bounded deletion budget.
      const directory = await fs.opendir(root);
      for await (const entry of directory) {
        if (!await existingDirectory(root)) throw new Error('retention_root_disappeared');
        yield entry;
      }
      return;
    }
    const key = `${id}\0${root}`;
    let directory = cursors.get(key);
    if (directory === undefined) { directory = await fs.opendir(root); cursors.set(key, directory); }
    try {
      while (budget.available()) {
        if (!await existingDirectory(root)) throw new Error('retention_root_disappeared');
        const entry = await directory.read();
        if (entry === null) { await directory.close(); cursors.delete(key); return; }
        yield entry;
      }
    } catch (error) {
      await directory.close().catch(() => undefined); cursors.delete(key); throw error;
    }
  }
  async function releasedAt(directory: string): Promise<number | undefined> {
    const file = path.join(directory, 'released');
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (stat === undefined) return undefined;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64) throw new Error('retention_release_invalid');
    const value = await fs.readFile(file, 'utf8'), time = Date.parse(value);
    if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error('retention_release_invalid');
    return time;
  }
  async function remove(root: string, target: string, budget: SweepBudget): Promise<void> {
    const present = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (present === undefined) return;
    budget.removed(await removeOwnedPath(root, target, budget.now));
  }
  const pendingTrees = new Map<string, { collector: TreeCleanup }>();
  async function reclaimTree(root: string, target: string, eligible: () => Promise<boolean>, budget: SweepBudget, available = budget.available): Promise<boolean> {
    let pending = pendingTrees.get(target);
    if (pending === undefined) {
      const collector = await TreeCleanup.create(target);
      if (collector === undefined) return true;
      pending = { collector };
      pendingTrees.set(target, pending);
    }
    if (!await eligible()) return false;
    if (!await pending.collector.resume(root, eligible, budget, available)) return false;
    pendingTrees.delete(target); return true;
  }
  let pendingSdk: string | undefined;
  async function sweepExecSdk(budget: SweepBudget): Promise<void> {
    async function reclaim(directory: string): Promise<boolean> {
      const eligible = async (): Promise<boolean> => !scratch.isLive(path.basename(directory));
      if (!await eligible()) { pendingTrees.delete(path.join(directory, 'sdk')); return true; }
      if (!await reclaimTree(execRoot, path.join(directory, 'sdk'), eligible, budget)) return false;
      if (budget.trigger === 'startup' && await releasedAt(directory) === undefined) {
        await atomicWriteFile(path.join(directory, 'released'), budget.now.toISOString(), { mode: 0o600, fsync: true });
      }
      return true;
    }
    if (pendingSdk !== undefined) {
      if (!await reclaim(pendingSdk)) {
        if (budget.trigger === 'startup') throw new Error('retention_startup_incomplete');
        return;
      }
      pendingSdk = undefined;
    }
    for await (const entry of entries('exec-sdk', execRoot, budget)) {
      if (!TOKEN.test(entry.name) || !entry.isDirectory() || scratch.isLive(entry.name)) continue;
      const directory = path.join(execRoot, entry.name);
      if (!await reclaim(directory)) {
        pendingSdk = directory;
        if (budget.trigger === 'startup') throw new Error('retention_startup_incomplete');
        return;
      }
    }
  }

  let runtimeCleanup: { collector: RuntimeCleanup; released: number } | undefined;
  async function sweepRuntime(budget: SweepBudget): Promise<void> {
    const available = budget.available;
    async function resume(): Promise<boolean> {
      const pending = runtimeCleanup!;
      const eligible = async (): Promise<boolean> => !scratch.isLive(path.basename(pending.collector.target))
        && await releasedAt(pending.collector.target) === pending.released
        && budget.now.getTime() - pending.released >= config.ttlMs['exec-runtime'];
      try {
        if (!await eligible() || await pending.collector.resume(execRoot, eligible, budget, available)) { runtimeCleanup = undefined; return true; }
        return false;
      } catch (error) { runtimeCleanup = undefined; throw error; }
    }
    if (runtimeCleanup !== undefined && !await resume()) return;
    for await (const entry of entries('exec-runtime', execRoot, { ...budget, available })) {
      if (!TOKEN.test(entry.name) || !entry.isDirectory() || scratch.isLive(entry.name)) continue;
      const directory = path.join(execRoot, entry.name), released = await releasedAt(directory);
      if (released === undefined || budget.now.getTime() - released < config.ttlMs['exec-runtime']) continue;
      const collector = await RuntimeCleanup.create(directory);
      if (collector === undefined) continue;
      runtimeCleanup = { collector, released };
      if (!await resume()) return;
    }
  }
  let pendingDaemon: string | undefined;
  async function sweepDaemon(budget: SweepBudget): Promise<void> {
    async function reclaim(target: string): Promise<boolean> {
      const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (stat === undefined) {
        if (!await existingDirectory(daemonRoot)) throw new Error('retention_runtime_root_invalid');
        pendingTrees.delete(target); return true;
      }
      const mtimeMs = stat.mtimeMs;
      return reclaimTree(daemonRoot, target, async () => budget.now.getTime() - mtimeMs >= config.ttlMs['daemon-temp'], budget);
    }
    if (pendingDaemon !== undefined) {
      if (!await reclaim(pendingDaemon)) return;
      pendingDaemon = undefined;
    }
    for await (const entry of entries('daemon-temp', daemonRoot, budget)) {
      if (!entry.isDirectory() || !/^(?:diag|credential|prepare)-[A-Za-z0-9]{6}$/u.test(entry.name)) continue;
      const target = path.join(daemonRoot, entry.name), stat = await fs.lstat(target);
      if (budget.now.getTime() - stat.mtimeMs >= config.ttlMs['daemon-temp'] && !await reclaim(target)) { pendingDaemon = target; return; }
    }
  }
  async function sweepReplicas(budget: SweepBudget): Promise<void> {
    const journal = options.journal(), identity = options.identity();
    if (journal === undefined || identity === undefined) return;
    for await (const agent of entries('durable-replica', replicas, budget)) {
      if (!agent.isDirectory() || !/^[a-f0-9]{64}$/u.test(agent.name)) continue;
      const root = path.join(replicas, agent.name);
      for await (const entry of entries('durable-replica', root, budget)) {
        if (!entry.isFile() || !entry.name.startsWith('durable-') || !entry.name.endsWith('.sqlite') || entry.name.endsWith('.lock.sqlite')) continue;
        const encoded = entry.name.slice(8, -7), taskId = decodeURIComponent(encoded);
        if (encodeURIComponent(taskId) !== encoded) throw new Error('retention_replica_identity_invalid');
        const task = await journal.readTask(taskId, identity);
        if (task === undefined || !(task.localState.startsWith('terminal:') || task.localState === 'interrupted')) continue;
        const file = path.join(root, entry.name);
        let lock: { release(): void };
        try { lock = await acquireReplicaLock(file, 'retention'); }
        catch { continue; } // Lock helper deliberately coalesces locked/invalid; both remain protected.
        await withRelease(async () => {
          let bytes = 0;
          for (const candidate of [file, `${file}-wal`, `${file}-shm`]) bytes += (await measureTree(candidate, budget.now)).bytes;
          await resetReplica(file); budget.removed(bytes);
        }, () => lock.release());
        await fs.rm(`${file}.lock.sqlite`, { force: true });
      }
    }
  }
  async function sweepJournal(budget: SweepBudget): Promise<void> {
    const journal = options.journal();
    if (journal === undefined) return;
    const cutoff = new Date(budget.now.getTime() - config.ttlMs['confirmed-journal']);
    const tasks = await journal.listPrunableConfirmedTasks(cutoff, budget.remaining());
    for (const taskId of tasks) {
      if (!budget.available()) break;
      if (await journal.pruneConfirmedJournalTask(taskId, cutoff)) budget.removed(0);
    }
  }
  async function sweepPreparation(budget: SweepBudget): Promise<void> {
    const service = options.preparation();
    if (service === undefined) return;
    const result = await service.collectExpired(budget.now.getTime(), budget.remaining());
    for (let index = 0; index < result.artifactsRemoved + result.recordsRemoved; index++) budget.removed(index === 0 ? result.bytesReclaimed : 0);
  }
  async function sweepHome(id: 'reader-run' | 'agent-result' | 'home-temp' | 'session-ledger' | 'terminal-evidence' | 'codex-session-store', budget: SweepBudget): Promise<void> {
    const manager = options.home;
    if (manager === undefined) return;
    const root = path.join(manager.layout.hostRootInput(), 'agents');
    // A removed Agent home drops its walk.
    if (id === 'codex-session-store') for (const home of [...codexWalks.keys()]) if (!await existingDirectory(home)) await dropCodexWalk(home);
    for await (const entry of entries(id, root, budget)) {
      if (!entry.isDirectory()) continue;
      await manager.withIdleHomeLease(entry.name, async home => {
        // Complete authority is read under this lease using the original pass's
        // soft budget. Only deletion gets a fresh 250ms window; references are
        // never cached across passes or used when the scan is incomplete.
        const referenced = id === 'reader-run'
          ? await options.handoffs!.readerRunReferences(home, authorityBudget(budget).available)
          : undefined;
        if (id === 'reader-run' && referenced === undefined) return;
        const deadline = performance.now() + 250;
        const homeBudget: SweepBudget = { ...budget, available: () => { if (performance.now() >= deadline) { budget.truncate(); return false; } return budget.available(); } };
        if (referenced !== undefined) {
          const runsRoot = path.join(home, '.byok', 'runs');
          const candidates = selectReaderRuns({ runsRoot, active: new Set(), referenced,
            nowMs: budget.now.getTime(), maxAgeMs: config.ttlMs['reader-run'],
            entries: entries('reader-run', runsRoot, homeBudget),
            pending: [...pendingTrees.keys()],
          });
          for await (const { dir } of candidates) {
            if (!homeBudget.available()) break;
            // Candidate policy is recomputed under each new idle lease. The original mtime
            // survives our partial unlinks; otherwise they would restart the run's TTL.
            await reclaimTree(runsRoot, dir, async () => true, budget, homeBudget.available);
          }
        } else if (id === 'agent-result') {
          const results = path.join(home, AGENT_RESULT_DIRECTORY);
          await pruneAgentResults({ resultsRoot: results, entries: entries('agent-result', results, homeBudget),
            nowMs: budget.now.getTime(), maxAgeMs: config.ttlMs['agent-result'],
            remove: async file => { if (!homeBudget.available()) return false; await remove(home, file, budget); return true; },
          });
        } else if (id === 'codex-session-store') {
          // An execution holds its home lease from admission to the end of the session, so the idle-home
          // lease rules out a running or resuming task, and each age is read under it.
          const ledgers = path.join(home, '.byok', 'runtime-sessions');
          const ledgerTtlMs = config.ttlMs['session-ledger'];
          // A ledger entry may be written after the rollout's last write (a terminal record after close), and
          // it must not name a thread that is gone. The ledger file name is derived from the thread id.
          async function ledgerHolds(name: string): Promise<boolean> {
            const stat = await fs.lstat(path.join(ledgers, sessionFileName('codex', codexThreadIdFromRolloutName(name)!))).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
            return stat !== undefined && budget.now.getTime() - stat.mtimeMs < ledgerTtlMs;
          }
          // The walk visits only the Codex date folders (YYYY/MM/DD under each store root), so what an Agent
          // creates elsewhere is never read. A pass resumes the home's stack of folders and the retained cursor
          // of the folder it stopped in; entries() refuses a folder or ancestor that is not canonical. The state
          // is dropped when the walk ends or a folder's identity fails, and a restart starts over.
          const codex = path.join(home, '.byok', 'codex');
          let walk = codexWalks.get(home);
          if (walk === undefined) { walk = { pending: ['archived_sessions', 'sessions'].map(name => path.join(codex, name)) }; codexWalks.set(home, walk); }
          try {
            while (homeBudget.available()) {
              const directory = walk.current ?? walk.pending.pop();
              if (directory === undefined) { await dropCodexWalk(home); break; }
              walk.current = directory;
              const depth = path.relative(codex, directory).split(path.sep).length - 1;
              // entries() checks the budget before it reads each entry, so an entry it yields is always finished here.
              for await (const child of entries(id, directory, homeBudget)) {
                if (child.isDirectory()) { if (depth < 3 && (depth === 0 ? /^\d{4}$/u : /^\d{2}$/u).test(child.name)) walk.pending.push(path.join(directory, child.name)); continue; }
                if (depth !== 3 || !child.isFile() || !isCodexRolloutFileName(child.name)) continue;
                const file = path.join(directory, child.name);
                const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
                if (stat?.isFile() === true && budget.now.getTime() - stat.mtimeMs >= config.ttlMs['codex-session-store'] && !await ledgerHolds(child.name)) await remove(home, file, budget);
              }
              if (cursors.has(`${id}\0${directory}`)) break;
              walk.current = undefined;
            }
          } catch (error) { await dropCodexWalk(home); throw error; }
        } else if (id === 'session-ledger' || id === 'terminal-evidence') {
          // Every ledger and terminal append holds an execution lease, so the idle-home lease rules out a concurrent writer.
          const ledgers = path.join(home, '.byok', 'runtime-sessions');
          await pruneByLastWrite({ directory: ledgers, entries: entries(id, ledgers, homeBudget),
            match: id === 'session-ledger' ? isAgentSessionLedgerName : isAgentTaskTerminalName,
            nowMs: budget.now.getTime(),
            maxAgeMs: name => agentSessionFileTtlMs(name, config.ttlMs['session-ledger'], config.ttlMs['terminal-evidence']),
            remove: async file => { if (!homeBudget.available()) return false; await remove(home, file, budget); return true; },
          });
        } else {
          async function visit(directory: string, internal: boolean): Promise<void> {
            for await (const child of entries('home-temp', directory, homeBudget)) {
              const file = path.join(directory, child.name);
              if (child.isDirectory() && !internal && (directory === path.join(home, 'notes') || directory.startsWith(`${path.join(home, 'notes')}${path.sep}`))) { await visit(file, internal); continue; }
              if (!child.isFile() || !(HOME_TEMP.test(child.name) || (internal && /^agent-home-projection\.json\.\d+-\d+\.tmp$/u.test(child.name)))) continue;
              const stat = await fs.lstat(file);
              if (budget.now.getTime() - stat.mtimeMs >= config.ttlMs['home-temp'] && homeBudget.available()) await remove(home, file, budget);
            }
          }
          await visit(home, false); await visit(path.join(home, 'notes'), false); await visit(path.join(home, '.byok'), true);
        }
      });
    }
  }
  async function sweepSkills(budget: SweepBudget): Promise<void> {
    for (const dataDir of config.skillPackDataDirs) {
      const root = skillPacksRoot(dataDir);
      if (!await existingDirectory(root) || !budget.available()) continue;
      let gate;
      try { gate = await acquirePathMutationGate({ scope: 'skill-pack-store', targetPath: root }); }
      catch (error) { if (error instanceof PathMutationGateBusyError) continue; throw error; }
      await withRelease(async () => {
        for await (const entry of entries('skill-pack-old', root, budget)) {
          if (!entry.isDirectory()) continue;
          const pack = await readInstalledSkillPack(dataDir, entry.name);
          if (pack === undefined) continue;
          const packRoot = path.dirname(pack.directory);
          for await (const entry of entries('skill-pack-old', packRoot, budget)) {
            const directory = path.join(packRoot, entry.name);
            if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name) || directory === pack.directory) continue;
            const stat = await fs.lstat(directory);
            if (budget.now.getTime() - stat.mtimeMs >= config.ttlMs['skill-pack-old']) await remove(packRoot, directory, budget);
          }
        }
      }, () => gate.release());
    }
  }
  async function sweepPiSessions(budget: SweepBudget): Promise<void> {
    if (piSessionDir === undefined) return;
    let rebinding;
    try { rebinding = await acquirePiSessionRebinding(); }
    catch (error) { if (error instanceof PathMutationGateBusyError) return; throw error; }
    const releaseFailures: unknown[] = [];
    const release = async (gate: { release(): Promise<void> }) => {
      try { await gate.release(); } catch (error) { releaseFailures.push(error); }
    };
    try {
    // A fresh launch holds discovery until it knows and leases its real session id.
    // Resumes take their session lease before validating the home handoff. Both
    // gates are directory-scoped across daemons and standalone adapters.
    await pruneByLastWrite({ directory: piSessionDir, entries: entries('pi-session-dir', piSessionDir, budget), match: isPiSessionFileName,
      nowMs: budget.now.getTime(), maxAgeMs: config.ttlMs['pi-session-dir'],
      remove: async file => {
        const sessionRef = piSessionRefFromFileName(path.basename(file));
        if (sessionRef === undefined) return true;
        let discovery;
        try { discovery = await acquirePiSessionDiscovery(piSessionDir); }
        catch (error) { if (error instanceof PathMutationGateBusyError) return true; throw error; }
        let operationFailed = false;
        try {
          let session;
          try { session = await acquirePiSessionRetention(piSessionDir, sessionRef); }
          catch (error) { if (error instanceof PathMutationGateBusyError) return true; throw error; }
          let writer;
          try { writer = await acquirePiSessionWriter(file); }
          catch (error) {
            await release(session);
            if (error instanceof PathMutationGateBusyError && releaseFailures.length === 0) return true;
            throw error;
          }
          try {
            // Selection happened before the gates; a completed turn may have refreshed the file.
            const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
            if (stat?.isFile() && !stat.isSymbolicLink() && budget.now.getTime() - stat.mtimeMs >= config.ttlMs['pi-session-dir']) {
              // Native resume matches header.id, not the suffix. Preserve a
              // renamed/reused file whose admission identity is ambiguous.
              const handle = await fs.open(file, 'r');
              let headerId: unknown;
              try {
                const buffer = Buffer.alloc(4096);
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                const text = buffer.subarray(0, bytesRead).toString('utf8');
                if (bytesRead < stat.size && !text.includes('\n')) return true;
                const firstLine = text.split('\n', 1)[0]!;
                try {
                  const header = JSON.parse(firstLine);
                  if (!header) return true; // Native discovery also skips parsed falsy prefix values.
                  if (header.type === 'session') headerId = header.id;
                }
                catch {
                  // Native discovery skips blank/malformed prefix lines. This
                  // bounded read cannot prove the later header identity.
                  if (stat.size > 0) return true;
                }
              } finally { await handle.close(); }
              if (typeof headerId !== 'string' || headerId === sessionRef) await remove(piSessionDir, file, budget);
            }
          } finally { await release(writer); await release(session); }
        } catch (error) { operationFailed = true; throw error; }
        finally { await release(discovery); if (!operationFailed && releaseFailures.length) throw releaseFailures.shift(); }
        return true;
      },
    });
    } catch (error) {
      await release(rebinding);
      throw withGateReleaseFailures(error, releaseFailures);
    }
    await release(rebinding);
    if (releaseFailures.length) throw withGateReleaseFailures(releaseFailures[0], releaseFailures.slice(1));
  }
  async function sweepAgySessions(budget: SweepBudget): Promise<void> {
    if (agySessionStore === undefined) return;
    const nowMs = budget.now.getTime(), maxAgeMs = config.ttlMs['agy-session-store'];
    const conversations = path.join(agySessionStore, 'conversations');
    await pruneByLastWrite({ directory: conversations, entries: entries('agy-session-store', conversations, budget), match: isAgyConversationFileName, nowMs, maxAgeMs,
      remove: async file => {
        const sessionRef = path.basename(file, '.db');
        let lease;
        try { lease = await acquireAgySessionRetention(agySessionStore, sessionRef); }
        catch (error) { if (error instanceof PathMutationGateBusyError) return true; throw error; }
        await withRelease(async () => {
          // Selection happened before the gate; a turn that finished since may have refreshed the file.
          const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
          if (stat !== undefined && nowMs - stat.mtimeMs >= maxAgeMs) for (const target of agySessionPaths(agySessionStore, sessionRef)) await remove(agySessionStore, target, budget);
        }, () => lease.release());
        return true;
      },
    });
    // Neither names a session: `implicit` is keyed by its own ids and each process writes one log.
    for (const directory of ['implicit', 'log'].map(name => path.join(agySessionStore, name))) {
      await pruneByLastWrite({ directory, entries: entries('agy-session-store', directory, budget), match: () => true, nowMs, maxAgeMs,
        remove: async file => { await remove(agySessionStore, file, budget); return true; } });
    }
  }
  const sweep: Record<ExpiringClassId, (budget: SweepBudget) => Promise<void>> = {
    'exec-sdk': sweepExecSdk, 'exec-runtime': sweepRuntime, 'daemon-temp': sweepDaemon, 'durable-replica': sweepReplicas,
    'confirmed-journal': sweepJournal, 'input-preparation': sweepPreparation, 'skill-pack-old': sweepSkills,
    'reader-run': budget => sweepHome('reader-run', budget), 'agent-result': budget => sweepHome('agent-result', budget),
    'home-temp': budget => sweepHome('home-temp', budget), 'session-ledger': budget => sweepHome('session-ledger', budget),
    'terminal-evidence': budget => sweepHome('terminal-evidence', budget), 'pi-session-dir': sweepPiSessions,
    'agy-session-store': sweepAgySessions, 'codex-session-store': budget => sweepHome('codex-session-store', budget),
  };

  let measurement: Promise<Map<RetentionClassId, ClassUsage>> | undefined;
  async function collectUsage(): Promise<Map<RetentionClassId, ClassUsage>> {
    const now = clock(), all = [...EXPIRING_CLASS_IDS, ...PROTECTED_CLASS_IDS];
    const result = new Map<RetentionClassId, ClassUsage>(all.map(classId => [classId,
      { classId, protected: PROTECTED_CLASS_IDS.includes(classId as typeof PROTECTED_CLASS_IDS[number]), measured: false, truncated: false, bytes: 0, entries: 0, oldestAgeMs: null }]));
    const currentSkills = new Set<string>();
    // Host-owned roots can hold any number of entries, so one walk stops at a bound
    // and reports lower bounds instead of failing measurement and latching emergency.
    const limit = options.usageScanLimit ?? 65_536;
    let scanned = 0, exhausted = false;
    const admit = (): boolean => { if (scanned >= limit) exhausted = true; else scanned++; return !exhausted; };
    for (const root of config.skillPackDataDirs) {
      if (exhausted) break;
      const directory = await fs.opendir(skillPacksRoot(root)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (directory === undefined) continue;
      for await (const entry of directory) {
        if (!admit()) break;
        if (!entry.isDirectory()) continue;
        const pack = await readInstalledSkillPack(root, entry.name);
        if (pack !== undefined) currentSkills.add(pack.directory);
      }
    }
    const homes = options.home === undefined ? undefined : path.join(options.home.layout.hostRootInput(), 'agents');
    const roots = [...new Set([storeDir, scratch.root, ...config.skillPackDataDirs.map(skillPacksRoot), homes, piSessionDir, agySessionStore].filter((root): root is string => root !== undefined))];
    const topRoots = roots.filter(root => !roots.some(other => other !== root && inside(other, root)));
    const replicaStates = new Map<string, Promise<boolean>>();
    async function classify(file: string, stat: Stats): Promise<RetentionClassId> {
      if (piSessionDir !== undefined && inside(piSessionDir, file)) return 'pi-session-dir';
      if (agySessionStore !== undefined && inside(agySessionStore, file)) return 'agy-session-store';
      if (inside(execRoot, file)) return file.includes(`${path.sep}sdk${path.sep}`) ? 'exec-sdk' : file.includes(`${path.sep}runtime${path.sep}`) ? 'exec-runtime' : 'store-authority';
      if (inside(daemonRoot, file)) return 'daemon-temp';
      if (inside(replicas, file)) {
        const pieces = path.relative(replicas, file).split(path.sep);
        const name = pieces[1]?.replace(/-(?:wal|shm)$/u, '');
        const journal = options.journal(), identity = options.identity();
        if (pieces.length !== 2 || !/^[a-f0-9]{64}$/u.test(pieces[0]!) || name === undefined || !name.startsWith('durable-') || !name.endsWith('.sqlite') || name.endsWith('.lock.sqlite') || journal === undefined || identity === undefined) return 'durable-replica-live';
        const encoded = name.slice(8, -7), taskId = decodeURIComponent(encoded);
        if (encodeURIComponent(taskId) !== encoded) throw new Error('retention_replica_identity_invalid');
        let terminal = replicaStates.get(taskId);
        if (terminal === undefined) { terminal = journal.readTask(taskId, identity).then(task => task !== undefined && (task.localState.startsWith('terminal:') || task.localState === 'interrupted')); replicaStates.set(taskId, terminal); }
        return await terminal ? 'durable-replica' : 'durable-replica-live';
      }
      if (inside(path.join(storeDir, 'quarantine'), file)) return 'quarantine';
      if (inside(path.join(storeDir, 'owned-processes'), file)) return 'owned-processes';
      if (path.dirname(file) === storeDir && /^daemon\.db(?:-wal|-shm)?$/u.test(path.basename(file))) return 'journal';
      if (inside(path.join(storeDir, 'input-preparation'), file)) return 'input-preparation';
      for (const dataDir of config.skillPackDataDirs) {
        const root = skillPacksRoot(dataDir);
        if (inside(root, file)) {
          const parts = path.relative(root, file).split(path.sep), revision = path.join(root, ...parts.slice(0, 2));
          return parts.length > 2 && /^[a-f0-9]{64}$/u.test(parts[1]!) && !currentSkills.has(revision) && [...currentSkills].some(current => path.dirname(current) === path.dirname(revision)) ? 'skill-pack-old' : 'skill-pack-current';
        }
      }
      if (homes !== undefined && inside(homes, file)) {
        const relative = path.relative(homes, file).split(path.sep).slice(1).join('/');
        if (relative.startsWith('.byok/runs/')) return 'reader-run';
        const name = path.basename(file);
        if (stat.isFile() && relative === `.byok/results/${name}` && (AGENT_RESULT_RECORD_NAME.test(name) || AGENT_RESULT_TEMP_NAME.test(name))) return 'agent-result';
        if (relative === '.byok/agent-home.lease') return 'agent-home-lease';
        if (stat.isFile() && relative === `.byok/runtime-sessions/${name}` && isAgentSessionLedgerName(name)) return 'session-ledger';
        if (stat.isFile() && relative === `.byok/runtime-sessions/${name}` && isAgentTaskTerminalName(name)) return 'terminal-evidence';
        if (HOME_TEMP.test(path.basename(file)) && !relative.startsWith('.byok/runtime-sessions/')) return 'home-temp';
        if (relative.startsWith('.byok/codex/')) return 'codex-session-store';
        return relative.startsWith('.byok/') ? 'byok-authority' : 'agent-content';
      }
      return 'store-authority';
    }
    async function walk(file: string): Promise<void> {
      const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (stat === undefined || !admit()) return;
      if (stat.isDirectory()) {
        const directory = await fs.opendir(file);
        for await (const entry of directory) { await walk(path.join(file, entry.name)); if (exhausted) break; }
      } else {
        const id = await classify(file, stat), previous = result.get(id)!;
        result.set(id, { ...previous, measured: true, bytes: previous.bytes + stat.size, entries: previous.entries + 1,
          oldestAgeMs: Math.max(previous.oldestAgeMs ?? 0, Math.max(0, now.getTime() - stat.mtimeMs)) });
      }
    }
    // An unfinished top root maps to whether the walk entered it before stopping.
    const unfinished = new Map<string, boolean>();
    for (const root of topRoots) {
      const before = scanned;
      if (!exhausted) await walk(root);
      if (exhausted) unfinished.set(root, scanned > before);
    }
    for (const id of all) {
      // confirmed-journal counts journal rows, not walked files. Exec residue that
      // matches no exec class is store authority even when scratch is outside the store.
      const covered = id === 'confirmed-journal' ? [] : id === 'store-authority' ? [storeDir, scratch.root] : authority(id).roots;
      const related = topRoots.filter(root => covered.some(other => inside(root, other) || inside(other, root)));
      const truncated = related.some(root => unfinished.has(root));
      const unreached = truncated && related.every(root => unfinished.get(root) === false);
      // Empty SDK-owned classes were measured too; external unconfigured scopes and unreached roots stay explicit.
      const previous = result.get(id)!;
      result.set(id, { ...previous, truncated, measured: !unreached && (previous.measured || !['agent-content', 'byok-authority', 'agent-home-lease', 'runtime-session-external', 'confirmed-journal'].includes(id)) });
    }
    const journal = options.journal();
    if (journal !== undefined) { const usage = await journal.measureUsage();
      for (const field of ['journalBytes','quarantineBytes','journalEntries','confirmedEntries'] as const) if (!Number.isSafeInteger(usage[field]) || usage[field] < 0) throw new Error('retention_journal_usage_invalid');
      if (usage.oldestConfirmedAt !== undefined && !Number.isFinite(Date.parse(usage.oldestConfirmedAt))) throw new Error('retention_journal_usage_invalid');
      result.set('confirmed-journal', { classId: 'confirmed-journal', protected: false, measured: true, truncated: false,
      bytes: 0, entries: usage.confirmedEntries, oldestAgeMs: usage.oldestConfirmedAt === undefined ? null : Math.max(0, now.getTime() - Date.parse(usage.oldestConfirmedAt)) }); }
    return result;
  }
  const measure = async (id: RetentionClassId): Promise<ClassUsage> => (await (measurement ??= collectUsage())).get(id)!;
  function authority(id: RetentionClassId): ClassAuthority {
    const expiring = EXPIRING_CLASS_IDS.includes(id as ExpiringClassId);
    const homeScoped = ['reader-run','agent-result','home-temp','session-ledger','agent-content','byok-authority','agent-home-lease','terminal-evidence','codex-session-store'].includes(id);
    const ttlMs = expiring ? config.ttlMs[id as ExpiringClassId] : undefined;
    const replicaScoped = id === 'durable-replica' || id === 'durable-replica-live';
    const skillScoped = id === 'skill-pack-old' || id === 'skill-pack-current';
    const roots = id === 'exec-sdk' || id === 'exec-runtime' ? [execRoot]
      : id === 'daemon-temp' ? [daemonRoot] : replicaScoped ? [replicas]
      : homeScoped ? (options.home === undefined ? [] : [path.join(options.home.layout.hostRootInput(), 'agents')])
      : skillScoped ? config.skillPackDataDirs.map(skillPacksRoot)
      : id === 'pi-session-dir' ? (piSessionDir === undefined ? [] : [piSessionDir])
      : id === 'agy-session-store' ? (agySessionStore === undefined ? [] : [agySessionStore])
      : id === 'runtime-session-external' ? []
      : id === 'input-preparation' ? [path.join(storeDir, 'input-preparation')]
      : id === 'quarantine' ? [path.join(storeDir, 'quarantine')]
      : id === 'owned-processes' ? [path.join(storeDir, 'owned-processes')] : [storeDir];
    const maxEntries = id === 'reader-run' ? AGENT_HOME_READER_RUN_MAX_RETAINED : id === 'agent-result' ? AGENT_RESULT_MAX_RETAINED : undefined;
    return Object.freeze({ roots: Object.freeze(roots), owner: ['agent-content', 'runtime-session-external'].includes(id) ? 'host' : 'sdk',
      scope: homeScoped ? 'agent-home' : replicaScoped ? 'replica' : ['pi-session-dir', 'agy-session-store', 'runtime-session-external'].includes(id) ? 'host' : 'store',
      bound: ttlMs === undefined ? PROTECTED_CLASS_BOUNDS[id as ProtectedClassId]
        : Object.freeze({ kind: 'ttl' as const, ttlMs, ...(maxEntries === undefined ? {} : { maxEntries }) }) });
  }
  let lastCompactionMs: number | undefined;
  const registry = new RetentionRegistry([
    ...EXPIRING_CLASS_IDS.map(id => ({ id, authority: authority(id), measure: () => measure(id), sweep: async (budget: SweepBudget) => { measurement = undefined; await sweep[id](classBudget(id, budget)); } })),
    ...PROTECTED_CLASS_IDS.map(id => ({ id, authority: authority(id), measure: () => measure(id) })),
  ], async () => { await Promise.all([...cursors.values()].map(cursor => cursor.close())); cursors.clear(); measurement = undefined; },
    () => { measurement = undefined; }, async (budget, underPressure) => {
      const journal = options.journal();
      const interval = underPressure ? 300_000 : 3_600_000;
      if (journal !== undefined && (lastCompactionMs === undefined || budget.now.getTime() - lastCompactionMs >= interval)) {
        await journal.compact({ checkpoint: 'passive', incrementalVacuumPages: 64 });
        lastCompactionMs = budget.now.getTime();
      }
    });
  return registry;
}
