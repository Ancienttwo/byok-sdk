#!/usr/bin/env bash
set -euo pipefail

# templates/packaging/bun/build.sh
#
# Reference recipe: compile a BYOK SDK launcher entry point into a single
# native executable via `bun build --compile`. This is the "bun-compile"
# half of the M3-K packageability guarantee -- see
# examples/packaging/launcher.ts for what the entry point actually does and
# why, and templates/packaging/bun/README.md for the full copy-paste guide.
#
# Usage:
#   templates/packaging/bun/build.sh <entry.ts> <output-dir>
#
# Produces "<output-dir>/launcher-bun" (or "launcher-bun.exe" on Windows).
#
# Requires `bun` on PATH (or $BUN_BIN pointing at it). No other bundling
# step is needed -- unlike the Node SEA recipe, bun's --compile already
# understands ESM + `import.meta.resolve` natively, so @byok/client's dist
# (ESM, "type": "module") is compiled as-is.

ENTRY="${1:?usage: build.sh <entry.ts> <output-dir>}"
OUT_DIR="${2:?usage: build.sh <entry.ts> <output-dir>}"
mkdir -p "$OUT_DIR"

OS="${RUNNER_OS:-}"
if [ -z "$OS" ]; then
  case "$(uname -s)" in
    Darwin) OS=macOS ;;
    MINGW*|MSYS*|CYGWIN*) OS=Windows ;;
    *) OS=Linux ;;
  esac
fi

if [ "$OS" = "Windows" ]; then
  OUT_BIN="$OUT_DIR/launcher-bun.exe"
else
  OUT_BIN="$OUT_DIR/launcher-bun"
fi

BUN="${BUN_BIN:-bun}"
echo "==> $BUN build --compile $ENTRY -> $OUT_BIN"
"$BUN" build "$ENTRY" --compile --outfile "$OUT_BIN"
echo "==> built $OUT_BIN"
