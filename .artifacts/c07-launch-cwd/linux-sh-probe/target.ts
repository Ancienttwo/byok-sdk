const out = {
  pid: process.pid,
  ppid: process.ppid,
  cwd: process.cwd(),
  argvHex: process.argv.slice(2).map((a) => Buffer.from(a, "utf8").toString("hex")),
  mark: process.env.PROBE_MARK ?? null,
};
console.log("TARGET " + JSON.stringify(out));
if (process.env.PROBE_SLEEP) {
  setTimeout(() => {}, 30_000);
} else {
  process.exit(Number(process.env.PROBE_EXIT ?? "0"));
}
