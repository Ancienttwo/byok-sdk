// Runs with a clean cwd (no bunfig). Spawns the target under different bootstraps.
const [sh, target, agentHome, trusted, weirdTrusted, trapFile] = process.argv.slice(2);
const classes = [" a b ", "\ttab", "x\ny", '"dq"', "'sq'", "$HOME", "`id`", "*", "-n", "--", "", "\\back", "a;b", "a&&b", "~", "ü漢", "%s"];
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");
type R = { code: number | null; signal: string | null; lines: string[]; pid: number };
async function run(cmd: string[], opts: { cwd: string; env?: Record<string, string>; kill?: boolean }): Promise<R> {
  const p = Bun.spawn(cmd, { cwd: opts.cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...(opts.env ?? {}) }, stdout: "pipe", stderr: "pipe" });
  let killed = false;
  const outP = new Response(p.stdout).text();
  const errP = new Response(p.stderr).text();
  if (opts.kill) { await Bun.sleep(400); p.kill("SIGTERM"); killed = true; }
  const code = await p.exited;
  const out = await outP; const err = await errP;
  return { code: p.signalCode ? null : code, signal: p.signalCode ?? null, lines: (out + (err ? "\nSTDERR " + err.trim() : "")).split("\n").filter(Boolean), pid: p.pid };
}
const parse = (r: R) => { const l = r.lines.find((x) => x.startsWith("TARGET ")); return l ? JSON.parse(l.slice(7)) : null; };
const results: Record<string, unknown> = { sh, spawnerPid: process.pid };
const boot = (script: string, cwd: string, ...args: string[]) => [sh, "-c", script, cwd, target, ...args];
const S1 = 'cd -- "$0" && exec "$@"';
const S2 = 'cd -- "$0" && exec -- "$@"';
const S3 = 'cd "$0" && exec "$@"';

// B baseline: direct start from agent home => injection expected
{ const r = await run([target, ...classes], { cwd: agentHome }); results.baseline = { injected: r.lines.includes("PRELOADED-INJECTION"), cwd: parse(r)?.cwd, code: r.code }; }
// C bootstrap S1
for (const [name, script] of [["S1", S1], ["S2", S2], ["S3", S3]] as const) {
  const r = await run(boot(script, trusted, ...classes), { cwd: agentHome });
  const t = parse(r);
  results[`bootstrap_${name}`] = { injected: r.lines.includes("PRELOADED-INJECTION"), cwd: t?.cwd, cwdOk: t?.cwd === trusted, argvIdentical: JSON.stringify(t?.argvHex) === JSON.stringify(classes.map(hex)), pidIsSpawned: t?.pid === r.pid, ppidIsSpawner: t?.ppid === process.pid, code: r.code, lines: t ? undefined : r.lines };
}
// weird trusted dir (spaces + leading dash) with S1 and S3
for (const [name, script] of [["S1", S1], ["S3", S3]] as const) {
  const r = await run(boot(script, weirdTrusted, "x"), { cwd: agentHome });
  const t = parse(r);
  results[`weirdcwd_${name}`] = { cwd: t?.cwd, cwdOk: t?.cwd === weirdTrusted, code: r.code, lines: t ? undefined : r.lines };
}
// D negative control: trusted = agentHome => injection must reproduce
{ const r = await run(boot(S1, agentHome, "x"), { cwd: agentHome }); results.negative_control = { injected: r.lines.includes("PRELOADED-INJECTION"), cwd: parse(r)?.cwd }; }
// F exit code + signal
{ const r = await run(boot(S1, trusted, "x"), { cwd: agentHome, env: { PROBE_EXIT: "42" } }); results.exit_code = { code: r.code, signal: r.signal }; }
{ const r = await run(boot(S1, trusted, "x"), { cwd: agentHome, env: { PROBE_SLEEP: "1" }, kill: true }); const t = parse(r); results.signal = { code: r.code, signal: r.signal, targetPidIsSpawned: t?.pid === r.pid }; }
// G env traps
{
  const env = { ENV: trapFile, BASH_ENV: trapFile, CDPATH: agentHome + ":" + trusted, IFS: "x", SHELLOPTS: "xtrace", PS4: "$(echo PS4-TRAP >&2)", PROBE_MARK: "m1" };
  const r = await run(boot(S1, trusted, ...classes), { cwd: agentHome, env });
  const t = parse(r);
  results.env_traps = { injected: r.lines.includes("PRELOADED-INJECTION"), trapSourced: r.lines.some((l) => l.includes("TRAP-SOURCED") || l.includes("PS4-TRAP")), cwdOk: t?.cwd === trusted, argvIdentical: JSON.stringify(t?.argvHex) === JSON.stringify(classes.map(hex)), markPassed: t?.mark === "m1", lines: r.lines.filter((l) => !l.startsWith("TARGET ")) };
  // relative cwd with CDPATH: documents why the implementation must pass an absolute realpath
  const rel = await run(boot(S1, trusted.split("/").pop()!, "x"), { cwd: "/", env: { CDPATH: agentHome } });
  results.cdpath_relative_negative = { cwd: parse(rel)?.cwd, code: rel.code, lines: parse(rel) ? undefined : rel.lines };
}
console.log(JSON.stringify(results, null, 2));
