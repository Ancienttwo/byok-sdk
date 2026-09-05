/**
 * Windows kill-on-close Job Object ownership for owned runtime process trees.
 *
 * `adapters/process-tree.ts` can terminate a tree the daemon still controls.
 * It cannot terminate one the daemon is no longer around to sweep: Windows
 * never re-parents orphans, so descendants of a daemon that died (crash,
 * SIGKILL, OOM) are unreachable to any later `taskkill /T`. A Job Object with
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` moves that guarantee into the kernel —
 * ONE job is created per daemon process, every owned runtime root is assigned
 * to it right after spawn, and the job handle is deliberately never closed.
 * When the daemon's last handle to it goes away — for ANY reason, including a
 * kill the daemon cannot observe — Windows terminates every process in the
 * job.
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

let cachedBindings: JobObjectBindings | undefined;

/**
 * Resolve the kernel32 binding table, importing `koffi` on first use only.
 *
 * The import is dynamic and lives here alone so that merely importing
 * `process-tree.ts` — which every adapter does, on every platform — never
 * pulls a native addon into the process.
 */
export async function loadBindings(): Promise<JobObjectBindings> {
  if (cachedBindings !== undefined) return cachedBindings;

  let koffi: KoffiModule;
  try {
    const imported = (await import('koffi')) as unknown as { default?: KoffiModule };
    koffi = (imported.default ?? imported) as KoffiModule;
  } catch (cause) {
    throw new Win32JobObjectFailure({
      step: 'loadKoffi',
      reason: 'win32 runtime process ownership requires the koffi optional dependency, which could not be loaded',
    }, { cause });
  }

  const kernel32 = koffi.load('kernel32.dll');
  const PVOID = koffi.pointer('void');
  const bind = (name: string, result: unknown, args: unknown[]): never =>
    kernel32.func('__stdcall', name, result, args) as never;

  cachedBindings = {
    createJobObjectW: bind('CreateJobObjectW', PVOID, [PVOID, 'str16']),
    setInformationJobObject: bind('SetInformationJobObject', 'int', [PVOID, 'int', PVOID, 'uint32']),
    openProcess: bind('OpenProcess', PVOID, ['uint32', 'int', 'uint32']),
    assignProcessToJobObject: bind('AssignProcessToJobObject', 'int', [PVOID, PVOID]),
    closeHandle: bind('CloseHandle', 'int', [PVOID]),
    getLastError: bind('GetLastError', 'uint32', []),
  };
  return cachedBindings;
}

/**
 * The daemon-wide job, keyed by the binding table that created it.
 *
 * Keyed rather than a bare module variable for one reason that is not test
 * convenience: the job's lifetime is the lifetime of the handles the table
 * owns, so a different table is a different job by construction. In
 * production exactly one table is ever cached, hence exactly one job.
 */
const jobsByBindings = new WeakMap<JobObjectBindings, Win32Handle>();

/** Build the extended-limit payload that makes the job kill-on-close. */
function killOnCloseLimitInformation(): Buffer {
  const information = Buffer.alloc(JOBOBJECT_EXTENDED_LIMIT_SIZE);
  information.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET);
  return information;
}

/**
 * Get (or create, once) the daemon-wide kill-on-close job.
 *
 * The returned handle is never closed on purpose: closing it is exactly what
 * terminates the tree, so it stays open for the daemon's whole lifetime and is
 * released by the kernel when the process object goes away. A job whose limit
 * could not be set is closed and NOT cached — an unlimited job would be a
 * silent downgrade to no backstop at all.
 */
function daemonJob(bindings: JobObjectBindings): Win32Handle {
  const existing = jobsByBindings.get(bindings);
  if (existing !== undefined) return existing;

  const job = bindings.createJobObjectW(null, null);
  if (isNullHandle(job)) {
    throw new Win32JobObjectFailure({
      step: 'CreateJobObjectW',
      reason: 'win32 runtime process ownership could not create the daemon kill-on-close job object',
      win32Code: bindings.getLastError(),
    });
  }

  const information = killOnCloseLimitInformation();
  if (bindings.setInformationJobObject(job, JobObjectExtendedLimitInformation, information, information.length) === 0) {
    const win32Code = bindings.getLastError();
    bindings.closeHandle(job);
    throw new Win32JobObjectFailure({
      step: 'SetInformationJobObject',
      reason: 'win32 runtime process ownership could not make the daemon job object kill-on-close',
      win32Code,
    });
  }

  jobsByBindings.set(bindings, job);
  return job;
}

export interface AssignOwnedProcessToJobOptions {
  /** DI seam — defaults to the lazily loaded real kernel32 table. */
  bindings?: JobObjectBindings;
}

/**
 * Assign one owned runtime root to the daemon-wide kill-on-close job.
 *
 * Every failure throws {@link Win32JobObjectFailure} naming the step and
 * carrying the Win32 error code. The process handle is opened solely to make
 * the assignment and is closed in a `finally`, including on the failure path —
 * the JOB holds the process afterwards, not this handle.
 */
export async function assignOwnedProcessToJob(pid: number, options?: AssignOwnedProcessToJobOptions): Promise<void> {
  const bindings = options?.bindings ?? (await loadBindings());
  const job = daemonJob(bindings);

  const processHandle = bindings.openProcess(OWNED_PROCESS_ACCESS, 0, pid);
  if (isNullHandle(processHandle)) {
    throw new Win32JobObjectFailure({
      step: 'OpenProcess',
      reason: `win32 runtime process ownership could not open process ${pid} for job assignment`,
      win32Code: bindings.getLastError(),
    });
  }

  try {
    if (bindings.assignProcessToJobObject(job, processHandle) === 0) {
      throw new Win32JobObjectFailure({
        step: 'AssignProcessToJobObject',
        reason: `win32 runtime process ownership could not assign process ${pid} to the daemon kill-on-close job object`,
        win32Code: bindings.getLastError(),
      });
    }
  } finally {
    bindings.closeHandle(processHandle);
  }
}
