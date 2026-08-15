#!/usr/bin/env bash
set -euo pipefail

# templates/packaging/sea/build.sh
#
# Reference recipe: bundle a BYOK SDK launcher entry point into a single
# Node.js "Single Executable Application" (SEA) binary -- the manual
# sea-config.json -> blob -> postject-inject flow documented at
# https://nodejs.org/api/single-executable-applications.html. This is the
# "Node-SEA" half of the M3-K packageability guarantee -- see
# examples/packaging/launcher.ts for what the entry point actually does and
# why, and templates/packaging/sea/README.md for the full copy-paste guide
# and the empirically-confirmed macOS gotcha this script works around.
#
# Usage:
#   templates/packaging/sea/build.sh <entry.ts> <output-dir>
#
# Produces "<output-dir>/launcher-sea" (or "launcher-sea.exe" on Windows).
#
# Why bundle to CommonJS first: @byok-sdk/client ships ESM ("type": "module"),
# while a Node SEA's injected main script must be a single, fully
# self-contained file. Node also has a native `"mainFormat": "module"` SEA config for an
# ESM main script, preserving real `import.meta.resolve` semantics, but it
# was NOT reliably functional on Node 22.22.3 (the version this was built
# against) as of this writing -- see the README's "why CJS, not ESM" note.
# This recipe uses the battle-tested CJS path so it actually works on the
# Node versions this SDK targets (engines.node >=22.22.0).

ENTRY="${1:?usage: build.sh <entry.ts> <output-dir>}"
OUT_DIR="${2:?usage: build.sh <entry.ts> <output-dir>}"
mkdir -p "$OUT_DIR"

BUNDLE="$OUT_DIR/launcher-bundled.cjs"
BLOB="$OUT_DIR/sea-prep.blob"
SEA_CONFIG="$OUT_DIR/sea-config.json"

OS="${RUNNER_OS:-}"
if [ -z "$OS" ]; then
  case "$(uname -s)" in
    Darwin) OS=macOS ;;
    MINGW*|MSYS*|CYGWIN*) OS=Windows ;;
    *) OS=Linux ;;
  esac
fi

if [ "$OS" = "Windows" ]; then
  OUT_BIN="$OUT_DIR/launcher-sea.exe"
else
  OUT_BIN="$OUT_DIR/launcher-sea"
fi

# Resolve esbuild, in order:
#   1. $ESBUILD_BIN, if the caller set one explicitly.
#   2. The launcher's own package-local node_modules/.bin/esbuild -- this
#      recipe's own examples/packaging lists `esbuild` as a direct
#      devDependency for exactly this reason: Bun materializes a deterministic
#      .bin shim next to the entry point. If you copy this recipe, add `esbuild`
#      as a devDependency of your own launcher's package.json the same way.
ENTRY_DIR="$(cd "$(dirname "$ENTRY")" && pwd)"
if [ -n "${ESBUILD_BIN:-}" ]; then
  ESBUILD_CMD=("$ESBUILD_BIN")
elif [ -x "$ENTRY_DIR/node_modules/.bin/esbuild" ]; then
  ESBUILD_CMD=("$ENTRY_DIR/node_modules/.bin/esbuild")
else
  echo "FAIL: esbuild is unavailable; install it as a direct devDependency or set ESBUILD_BIN" >&2
  exit 1
fi
echo "==> bundling $ENTRY to a single CommonJS file (${ESBUILD_CMD[*]})"
"${ESBUILD_CMD[@]}" "$ENTRY" --bundle --platform=node --format=cjs --outfile="$BUNDLE"

# On Windows, node.exe reads sea-config.json's "main"/"output" values
# through its own native file APIs, NOT through git-bash's MSYS path
# emulation -- unlike a path passed as a bare argv token (which git-bash
# auto-translates for a recognized native exe), a path embedded as JSON
# *text* is just a string to Node, so a git-bash-style "/tmp/..." path here
# fails with "Cannot read main script ...: no such file or directory" --
# empirically confirmed while building this recipe. Convert to a native
# Windows path (backslashes) via `cygpath -w`, then double the backslashes
# so the result is valid JSON string content.
json_path() {
  local p="$1"
  if [ "$OS" = "Windows" ] && command -v cygpath >/dev/null 2>&1; then
    p="$(cygpath -w "$p")"
  fi
  printf '%s' "${p//\\/\\\\}"
}

echo "==> generating SEA blob"
cat > "$SEA_CONFIG" <<EOF
{
  "main": "$(json_path "$BUNDLE")",
  "output": "$(json_path "$BLOB")",
  "disableExperimentalSEAWarning": true
}
EOF
node --experimental-sea-config "$SEA_CONFIG"

echo "==> copying node executable"
if [ "$OS" = "Windows" ]; then
  # cp on a symlinked/managed node.exe can be unreliable on Windows; Node's
  # own docs recommend this fs-based copy instead.
  node -e "require('fs').copyFileSync(process.execPath, process.argv[1])" "$OUT_BIN"
else
  cp "$(command -v node)" "$OUT_BIN"
fi
# Package-manager-owned Node executables can be installed read-only (for
# example Homebrew uses mode 0555). `cp` preserves that mode on macOS, while
# postject must open the copied executable for writing. Only make the disposable
# output copy owner-writable; never mutate the source Node installation.
chmod u+w "$OUT_BIN"

if [ "$OS" = "macOS" ]; then
  echo "==> stripping existing code signature (macOS)"
  codesign --remove-signature "$OUT_BIN"
fi

echo "==> injecting the blob with postject"
POSTJECT_ARGS=(--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2)
if [ "$OS" = "macOS" ]; then
  # REQUIRED on macOS: without this exact flag, postject still "succeeds"
  # but the resulting binary segfaults (SIGSEGV, exit 139) with ZERO
  # output before a single line of JS runs -- empirically confirmed while
  # building this recipe (official Node.js docs also specify this flag for
  # the macOS injection command; it's easy to miss since every other
  # platform's command omits it).
  POSTJECT_ARGS+=(--macho-segment-name NODE_SEA)
fi
# Pin postject as a direct devDependency rather than downloading a tool while
# the build is running. Products copying this recipe must pin the same tool or
# provide an explicit POSTJECT_BIN.
POSTJECT_BIN="${POSTJECT_BIN:-$ENTRY_DIR/node_modules/.bin/postject}"
if [ ! -x "$POSTJECT_BIN" ]; then
  echo "FAIL: postject is unavailable; install postject@1.0.0-alpha.6 directly or set POSTJECT_BIN" >&2
  exit 1
fi
"$POSTJECT_BIN" "$OUT_BIN" NODE_SEA_BLOB "$BLOB" "${POSTJECT_ARGS[@]}"

if [ "$OS" = "macOS" ]; then
  echo "==> re-signing (ad-hoc, macOS)"
  codesign --sign - "$OUT_BIN"
fi
# Windows: signing is optional (signtool, needs a real certificate) --
# Node's docs note the unsigned binary is still runnable. Left to the
# product's own release pipeline; out of scope here (Decision-6).

echo "==> built $OUT_BIN"
