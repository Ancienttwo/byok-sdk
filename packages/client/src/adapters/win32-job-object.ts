import { loadSdkKoffiAsset } from '../sdk-native-assets-runtime';
/**
 * Windows kill-on-close Job Object ownership for owned runtime process trees.
 *
 * `adapters/process-tree.ts` can terminate a tree the daemon still controls.
 * It cannot terminate one the daemon is no longer around to sweep: Windows
 * never re-parents orphans, so descendants of a daemon that died (crash,
 * SIGKILL, OOM) are unreachable to any later `taskkill /T`. A Job Object with
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` moves that guarantee into the kernel —
 * ONE job is created per owned tree, its root is assigned to it right after
 * spawn, and the daemon keeps the job handle open until disposal has proved
 * that tree gone. When the daemon's last handle to a job goes away — for ANY
 * reason, including a daemon death the daemon cannot observe, which closes
 * every handle it holds at once — Windows terminates every process in that
 * job, so every live owned tree dies with the daemon.
 *
 * Why one job per tree and not one per daemon: an EMPTY job becomes, at its
 * first assignment, a nested child of whatever job its first process is in at
 * that moment. A Node or Bun runtime root assigns ITSELF to a fresh
 * kill-on-close job of its own at its first spawn (libuv's global job), and
 * the assignment here can land after that, because it follows an asynchronous
 * module load. A shared daemon job could therefore nest under one root's
 * private job, and every later assignment then fails with
 * ERROR_INVALID_PARAMETER (87) once that root exits. A fresh job per tree can
 * only ever nest under its OWN root's chain, which accepts a live root in
 * every state.
 *
 * Fail-closed, no degraded path. `koffi` is an `optionalDependencies` entry of
 * this package precisely because npm has no other per-platform install
 * mechanism; the runtime rule, not the manifest field, carries the hardness.
 * A missing module, a NULL handle, or a zero return from any of the four Win32
 * calls throws {@link Win32JobObjectFailure} carrying the `GetLastError()`
 * code, and the caller refuses to publish a run handle. Nothing here retries
 * and nothing degrades to an unbacked tree.
 *
 * POSIX never loads this module: `process-tree.ts` reaches it through a
 * dynamic `import()` taken only on the win32 branch, and `koffi` itself is
 * imported only inside {@link loadBindings}. `__tests__/win32-job-object.test.ts`
 * asserts that isolation from a real non-win32 subprocess.
 *
 * Signatures follow kernel32's documented ABI and mirror the binding table in
 * deepseek-harness `sandbox-windows-acl` (`src/ffi.ts`), whose layout constants
 * were verified against the real Windows headers by its own ABI probe.
 */

/** LimitFlags bit: every process in the job dies when the last job handle closes. */
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
/** JOBOBJECTINFOCLASS value for JOBOBJECT_EXTENDED_LIMIT_INFORMATION. */
const JobObjectExtendedLimitInformation = 9;
/** sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) on x64. */
const JOBOBJECT_EXTENDED_LIMIT_SIZE = 144;
/** LimitFlags offset inside JOBOBJECT_EXTENDED_LIMIT_INFORMATION (BasicLimitInformation@0 + PerProcessUserTimeLimit@0 + PerJobUserTimeLimit@8). */
const JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET = 16;
/** PROCESS_SET_QUOTA: the access right AssignProcessToJobObject requires on the target. */
const PROCESS_SET_QUOTA = 0x0100;
/** PROCESS_TERMINATE: required alongside PROCESS_SET_QUOTA so the job can actually kill the process. */
const PROCESS_TERMINATE = 0x0001;

/** The two rights an owned runtime root must be opened with to join the job. */
const OWNED_PROCESS_ACCESS = PROCESS_SET_QUOTA | PROCESS_TERMINATE;

/**
 * A Win32 HANDLE as koffi 3 hands it back: a BigInt address, or null/0n for
 * failure. Deliberately opaque — nothing here does pointer arithmetic, and a
 * concrete numeric type would invite it.
 */
export type Win32Handle = unknown;

/** The steps a job assignment can fail at, in the order they are attempted. */
export type Win32JobObjectStep =
  | 'loadKoffi'
  | 'CreateJobObjectW'
  | 'SetInformationJobObject'
  | 'OpenProcess'
  | 'AssignProcessToJobObject';

export interface Win32JobObjectFailureInput {
  step: Win32JobObjectStep;
  reason: string;
  /** The `GetLastError()` code read immediately after the failing call. Absent only when the failure happened before any Win32 call (module load). */
  win32Code?: number;
}

/**
 * Start-time precondition failure of the win32 job-object backstop.
 *
 * Module-local by design. `RuntimeExecutionFailure` is the adapter boundary's
 * terminal control value and is frozen, so it cannot carry `win32Code`; this
 * failure is a transport-level precondition that each client folds into its
 * OWN existing exit-error channel, which is what the adapter boundary already
 * classifies. Nothing new is exported from the package index.
 */
export class Win32JobObjectFailure extends Error {
  readonly step: Win32JobObjectStep;
  readonly win32Code: number | undefined;

  constructor(input: Win32JobObjectFailureInput, options?: ErrorOptions) {
    super(input.reason, options);
    this.name = 'Win32JobObjectFailure';
    this.step = input.step;
    this.win32Code = input.win32Code;
  }
}

/** Narrowing guard usable across the two independently bundled package entries. */
export function isWin32JobObjectFailure(value: unknown): value is Win32JobObjectFailure {
  return value instanceof Error && value.name === 'Win32JobObjectFailure';
}

/**
 * The kernel32 calls the backstop needs. An interface, not a hard-wired koffi
 * table, so the branch is exercisable from POSIX with a recording fake — the
 * same DI convention `process-tree.ts` uses for `platform`/`spawnFn`/`killFn`.
 */
export interface JobObjectBindings {
  /** `HANDLE CreateJobObjectW(LPSECURITY_ATTRIBUTES, LPCWSTR)` — both NULL for an unnamed, default-security job. */
  createJobObjectW(attributes: Win32Handle, name: string | null): Win32Handle;
  /** `BOOL SetInformationJobObject(HANDLE, JOBOBJECTINFOCLASS, LPVOID, DWORD)`. */
  setInformationJobObject(job: Win32Handle, infoClass: number, info: Buffer, infoLength: number): number;
  /** `HANDLE OpenProcess(DWORD, BOOL, DWORD)`. */
  openProcess(desiredAccess: number, inheritHandle: number, pid: number): Win32Handle;
  /** `BOOL AssignProcessToJobObject(HANDLE, HANDLE)`. */
  assignProcessToJobObject(job: Win32Handle, process: Win32Handle): number;
  /** `BOOL CloseHandle(HANDLE)`. */
  closeHandle(handle: Win32Handle): number;
  /** `DWORD GetLastError()`. */
  getLastError(): number;
}

/** Minimal structural view of koffi 3's default export — enough to bind kernel32, and no more. */
interface KoffiLibrary {
  func(convention: string, name: string, result: unknown, args: unknown[]): (...args: never[]) => unknown;
}
interface KoffiModule {
  load(path: string): KoffiLibrary;
  pointer(type: string): unknown;
}

/** True for every NULL shape koffi may hand back (null, undefined, 0n, 0). */
function isNullHandle(value: Win32Handle): boolean {
  return value === null || value === undefined || value === 0n || value === 0;
}

const installedBindings = Symbol('installed');
const cachedBindings = new Map<string | symbol, JobObjectBindings>();

/**
 * Resolve the kernel32 binding table, importing `koffi` on first use only.
 *
 * The import is dynamic and lives here alone so that merely importing
 * `process-tree.ts` — which every adapter does, on every platform — never
 * pulls a native addon into the process.
 */
export async function loadBindings(nativeAssetRoot?: string): Promise<JobObjectBindings> {
  const key = nativeAssetRoot === undefined ? installedBindings : nativeAssetRoot;
  const cached = cachedBindings.get(key);
  if (cached !== undefined) return cached;

  let koffi: KoffiModule;
  try {
    const imported = nativeAssetRoot === undefined
      ? (await import('koffi')) as unknown as { default?: KoffiModule }
      : loadSdkKoffiAsset(nativeAssetRoot) as { default?: KoffiModule };
    koffi = (imported.default ?? imported) as KoffiModule;
  } catch (cause) {
    throw new Win32JobObjectFailure({
      step: 'loadKoffi',
      reason: nativeAssetRoot === undefined ? 'win32 runtime process ownership requires the koffi optional dependency, which could not be loaded' : 'win32 runtime process ownership requires valid SDK native assets at the configured root',
    }, { cause });
  }

  const kernel32 = koffi.load('kernel32.dll');
  const PVOID = koffi.pointer('void');
  const bind = (name: string, result: unknown, args: unknown[]): never =>
    kernel32.func('__stdcall', name, result, args) as never;

  const bindings: JobObjectBindings = {
    createJobObjectW: bind('CreateJobObjectW', PVOID, [PVOID, 'str16']),
    setInformationJobObject: bind('SetInformationJobObject', 'int', [PVOID, 'int', PVOID, 'uint32']),
    openProcess: bind('OpenProcess', PVOID, ['uint32', 'int', 'uint32']),
    assignProcessToJobObject: bind('AssignProcessToJobObject', 'int', [PVOID, PVOID]),
    closeHandle: bind('CloseHandle', 'int', [PVOID]),
    getLastError: bind('GetLastError', 'uint32', []),
  };
  cachedBindings.set(key, bindings);
  return bindings;
}

/** Build the extended-limit payload that makes the job kill-on-close. */
function killOnCloseLimitInformation(): Buffer {
  const information = Buffer.alloc(JOBOBJECT_EXTENDED_LIMIT_SIZE);
  information.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET);
  return information;
}

/**
 * Create one tree's kill-on-close job. A job whose limit could not be set is
 * closed — an unlimited job would be a silent downgrade to no backstop at all.
 */
function createTreeJob(bindings: JobObjectBindings): Win32Handle {
  const job = bindings.createJobObjectW(null, null);
  if (isNullHandle(job)) {
    throw new Win32JobObjectFailure({
      step: 'CreateJobObjectW',
      reason: 'win32 runtime process ownership could not create the tree kill-on-close job object',
      win32Code: bindings.getLastError(),
    });
  }

  const information = killOnCloseLimitInformation();
  if (bindings.setInformationJobObject(job, JobObjectExtendedLimitInformation, information, information.length) === 0) {
    const win32Code = bindings.getLastError();
    bindings.closeHandle(job);
    throw new Win32JobObjectFailure({
      step: 'SetInformationJobObject',
      reason: 'win32 runtime process ownership could not make the tree job object kill-on-close',
      win32Code,
    });
  }
  return job;
}

/**
 * One tree's job, owned by the daemon. `release()` closes the job handle,
 * which TERMINATES whatever is still in the job: call it only once disposal
 * has proved the tree gone. Never released, it is closed by the kernel when
 * the daemon exits — the backstop itself.
 */
export interface OwnedTreeJob {
  release(): void;
}

export interface AssignOwnedProcessToJobOptions {
  nativeAssetRoot?: string;
  /** DI seam — defaults to the lazily loaded real kernel32 table. */
  bindings?: JobObjectBindings;
}

/**
 * Create a kill-on-close job for one owned runtime tree and assign its root.
 *
 * Every failure throws {@link Win32JobObjectFailure} naming the step and
 * carrying the Win32 error code; the job it created is closed first, which is
 * harmless because no process was assigned to it. The process handle is
 * opened solely to make the assignment and is closed in a `finally` — the JOB
 * holds the process afterwards, not this handle.
 */
export async function assignOwnedProcessToJob(pid: number, options?: AssignOwnedProcessToJobOptions): Promise<OwnedTreeJob> {
  const bindings = options?.bindings ?? (await loadBindings(options?.nativeAssetRoot));
  const job = createTreeJob(bindings);

  const processHandle = bindings.openProcess(OWNED_PROCESS_ACCESS, 0, pid);
  if (isNullHandle(processHandle)) {
    const win32Code = bindings.getLastError();
    bindings.closeHandle(job);
    throw new Win32JobObjectFailure({
      step: 'OpenProcess',
      reason: `win32 runtime process ownership could not open process ${pid} for job assignment`,
      win32Code,
    });
  }

  try {
    if (bindings.assignProcessToJobObject(job, processHandle) === 0) {
      const win32Code = bindings.getLastError();
      bindings.closeHandle(job);
      throw new Win32JobObjectFailure({
        step: 'AssignProcessToJobObject',
        reason: `win32 runtime process ownership could not assign process ${pid} to its tree kill-on-close job object`,
        win32Code,
      });
    }
  } finally {
    bindings.closeHandle(processHandle);
  }

  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      bindings.closeHandle(job);
    },
  };
}
