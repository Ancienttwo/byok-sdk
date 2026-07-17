#!/usr/bin/env bash
set -euo pipefail

# templates/packaging/sea/smoke-test.sh
#
# Proves the M3-K packageability guarantee for the Node SEA path: builds
# examples/packaging/launcher.ts into a single Node SEA executable (via
# build.sh) and runs it twice from an isolated directory with no
# node_modules of its own (simulating "shipped to an end user's machine") --
#
#   1. with pi genuinely unreachable and no BYOK_PI_BIN set -- must exit 0
#      and report piDetect.present === false. This is the graceful-degrade
#      half of the guarantee: pi's optionalDependency import.meta.resolve
#      (packages/client/src/adapters/pi/resolve-bin.ts) must fail catchably
#      under a real single-file bundle, not crash the process.
#   2. with BYOK_PI_BIN pointing at a stub pi script -- must exit 0 and
#      report piDetect.present === true. This proves the override seam still
#      works correctly once bundled (pi is "picked up" when actually there).
#
# A crash on run 1 (any nonzero exit, or no BYOK_PACKAGING_PROBE marker line
# printed at all) is the CRITICAL escalation this recipe exists to catch --
# see examples/packaging/launcher.ts's header and
# packages/client/src/adapters/pi/resolve-bin.ts's doc comment for the
# hazard being proven against. It would mean the SDK's single hazardous
# resolution path (pi's) does not actually degrade the way the source
# already claims it does, once real bundling is involved.
#
# Usage: templates/packaging/sea/smoke-test.sh
#   (no args -- LAUNCHER_ENTRY / ESBUILD_BIN env vars override the defaults)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENTRY="${LAUNCHER_ENTRY:-$REPO_ROOT/examples/packaging/launcher.ts}"

# esbuild resolution (pnpm exec by default, or $ESBUILD_BIN override) is
# handled inside build.sh -- see its comments for why a plain `esbuild` on
# PATH can't be assumed here.

OS="${RUNNER_OS:-}"
if [ -z "$OS" ]; then
  case "$(uname -s)" in
    Darwin) OS=macOS ;;
    MINGW*|MSYS*|CYGWIN*) OS=Windows ;;
    *) OS=Linux ;;
  esac
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/byok-sea-smoke.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "==> building"
"$SCRIPT_DIR/build.sh" "$ENTRY" "$WORK_DIR/build"

if [ "$OS" = "Windows" ]; then
  BIN="$WORK_DIR/build/launcher-sea.exe"
else
  BIN="$WORK_DIR/build/launcher-sea"
fi

# Isolated run directory: copy the standalone executable out to a location
# with no node_modules of its own in its ancestor chain, so a genuinely
# absent optionalDependency can't be found by accident via disk resolution.
ISOLATED_DIR="$WORK_DIR/isolated-run"
mkdir -p "$ISOLATED_DIR"
RUN_BIN="$ISOLATED_DIR/$(basename "$BIN")"
cp "$BIN" "$RUN_BIN"
chmod +x "$RUN_BIN" 2>/dev/null || true

if [ "$OS" = "Windows" ]; then
  # NOT a .cmd/.bat here on purpose: pi-adapter.ts's detect() calls Node's
  # `child_process.execFile(bin.command, ['--version'])` with no
  # `shell: true` -- Windows can't CreateProcess a .cmd/.bat directly
  # without a shell, so execFile fails for one (silently degrading to
  # `present: false`, same symptom as "truly absent" -- empirically
  # confirmed while building this recipe: a .cmd stub here read as
  # indistinguishable from no stub at all). This is a real, pre-existing
  # execFile-without-shell limitation of pi-adapter.ts's own resolveBin
  # usage on Windows, orthogonal to bundling -- it would affect an
  # unbundled Windows run identically. A copy of `node.exe` is a genuine
  # .exe that responds to `--version` on stdout with exit 0, so it is a
  # fair stand-in for "a real pi binary" for this smoke's purposes.
  STUB="$WORK_DIR/stub-pi.exe"
  node -e "require('fs').copyFileSync(process.execPath, process.argv[1])" "$STUB"
else
  STUB="$WORK_DIR/stub-pi"
  cat > "$STUB" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "stub-pi 0.0.0-test" >&2
  exit 0
fi
echo "stub-pi: unsupported args: $*" >&2
exit 1
EOF
  chmod +x "$STUB"
fi

# BYOK_PI_BIN's value is read by the compiled binary's own native
# execFile() -- like sea-config.json's "main"/"output" (see build.sh), a
# git-bash-style "/tmp/..." path in an env var's *value* is not guaranteed
# to be translated the way a bare argv token passed to a recognized native
# exe is, so convert to a native Windows path defensively.
STUB_ENV_VALUE="$STUB"
if [ "$OS" = "Windows" ] && command -v cygpath >/dev/null 2>&1; then
  STUB_ENV_VALUE="$(cygpath -w "$STUB")"
fi

# $1=label $2=expected piDetect.present ("true"/"false") $3=output file $4=exit code
assert_probe() {
  local label="$1" expected_present="$2" out="$3" exit_code="$4"
  local line
  line="$(grep -m1 '^BYOK_PACKAGING_PROBE ' "$out" || true)"
  if [ "$exit_code" -ne 0 ] || [ -z "$line" ]; then
    echo "FAIL [$label]: exited $exit_code with no clean probe marker."
    echo "CRITICAL: pi resolution did not degrade catchably under Node SEA. Full output:"
    cat "$out"
    exit 1
  fi
  local json ok present
  json="${line#BYOK_PACKAGING_PROBE }"
  ok="$(node -e "console.log(JSON.parse(process.argv[1]).ok)" "$json")"
  present="$(node -e "console.log(JSON.parse(process.argv[1]).piDetect.present)" "$json")"
  if [ "$ok" != "true" ] || [ "$present" != "$expected_present" ]; then
    echo "FAIL [$label]: expected ok=true piDetect.present=$expected_present, got: $json"
    exit 1
  fi
  echo "PASS [$label]: piDetect.present=$present ($json)"
}

echo "==> scenario 1: pi absent (isolated dir, no BYOK_PI_BIN)"
OUT1="$WORK_DIR/out1.log"
EXIT1=0
( cd "$ISOLATED_DIR" && "./$(basename "$RUN_BIN")" ) >"$OUT1" 2>&1 || EXIT1=$?
assert_probe "pi-absent-degrades" "false" "$OUT1" "$EXIT1"

echo "==> scenario 2: BYOK_PI_BIN stub (pi picked up)"
OUT2="$WORK_DIR/out2.log"
EXIT2=0
( cd "$ISOLATED_DIR" && BYOK_PI_BIN="$STUB_ENV_VALUE" "./$(basename "$RUN_BIN")" ) >"$OUT2" 2>&1 || EXIT2=$?
assert_probe "pi-stub-picked-up" "true" "$OUT2" "$EXIT2"

echo "==> Node SEA packageability smoke: PASS"
