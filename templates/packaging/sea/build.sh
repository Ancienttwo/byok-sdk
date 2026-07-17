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
# Why bundle to CommonJS first: @byok/client ships ESM ("type": "module"),
# and its pi adapter's resolve-bin.ts calls `import.meta.resolve(...)` at
# runtime (packages/client/src/adapters/pi/resolve-bin.ts). A Node SEA's
# injected main script must be a single, fully self-contained file --
# module loading does not read from the filesystem at SEA runtime (only
# Node builtins resolve), so every dependency has to already be inlined.
# esbuild's CJS output rewrites `import.meta` into a plain `{}` with no
# `.resolve()` method; calling it then throws an ordinary catchable
# TypeError, which resolve-bin.ts's existing try/catch already treats as
# "resolution failed, fall back to PATH" -- empirically confirmed (see the
# README) to degrade exactly like a genuinely-absent optionalDependency
# would. Node also has a native `"mainFormat": "module"` SEA config for an
# ESM main script, preserving real `import.meta.resolve` semantics, but it
# was NOT reliably functional on Node 22.22.3 (the version this was built
# against) as of this writing -- see the README's "why CJS, not ESM" note.
# This recipe uses the battle-tested CJS path so it actually works on the
# Node versions this SDK targets (engines.node >=20).

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

# Default to `pnpm exec esbuild`: esbuild is only a *transitive* dependency
# here (pulled in by tsup, not listed directly in any package.json), and
# pnpm's default strict node_modules layout does not reliably hoist a
# transitive bin's shim to a fixed, predictable node_modules/.bin path --
# empirically confirmed to vary between a locally-accumulated install and a
# clean `pnpm install --frozen-lockfile` checkout (e.g. in CI). `pnpm exec`
# resolves any bin reachable from the workspace's own dependency graph
# regardless of hoisting, so it's the robust default within this repo. Set
# ESBUILD_BIN to a concrete path/command if you've copied this recipe into a
# non-pnpm project (npm/yarn) or have esbuild installed some other way.
if [ -n "${ESBUILD_BIN:-}" ]; then
  ESBUILD_CMD=("$ESBUILD_BIN")
else
  ESBUILD_CMD=(pnpm exec esbuild)
fi
echo "==> bundling $ENTRY to a single CommonJS file (${ESBUILD_CMD[*]})"
"${ESBUILD_CMD[@]}" "$ENTRY" --bundle --platform=node --format=cjs --outfile="$BUNDLE"

echo "==> generating SEA blob"
cat > "$SEA_CONFIG" <<EOF
{
  "main": "$BUNDLE",
  "output": "$BLOB",
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
npx --yes postject "$OUT_BIN" NODE_SEA_BLOB "$BLOB" "${POSTJECT_ARGS[@]}"

if [ "$OS" = "macOS" ]; then
  echo "==> re-signing (ad-hoc, macOS)"
  codesign --sign - "$OUT_BIN"
fi
# Windows: signing is optional (signtool, needs a real certificate) --
# Node's docs note the unsigned binary is still runnable. Left to the
# product's own release pipeline; out of scope here (Decision-6).

echo "==> built $OUT_BIN"
