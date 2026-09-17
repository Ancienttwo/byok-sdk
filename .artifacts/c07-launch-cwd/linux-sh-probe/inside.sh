#!/bin/sh
# runs inside the container; $1 = sh binary to probe
set -eu
SH="$1"; LABEL="$2"
W=/work; B=/tmp/probe-$LABEL; mkdir -p $B/agenthome "$B/trusted" "$B/-weird dir" $B/spawner
cd $B/spawner && bun build --compile $W/target.ts --outfile $B/target >/dev/null 2>&1
printf 'console.log("PRELOADED-INJECTION");\n' > $B/agenthome/preload.js
printf 'preload = ["%s/agenthome/preload.js"]\n' "$B" > $B/agenthome/bunfig.toml
printf 'echo TRAP-SOURCED >&2\n' > $B/trap.sh
echo "SH_IDENTITY $(readlink -f "$SH") $(stat -c '%U:%G %a' "$(readlink -f "$SH")") $("$SH" -c 'echo ${BASH_VERSION:-nobash} ${KSH_VERSION:-} ' 2>/dev/null) $(readlink -f "$SH" | xargs -I{} sh -c '{} --version 2>&1 | head -1 || true')"
cd $B/spawner && bun run $W/spawn.ts "$SH" $B/target $B/agenthome "$B/trusted" "$B/-weird dir" $B/trap.sh
