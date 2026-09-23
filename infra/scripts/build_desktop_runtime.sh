#!/usr/bin/env bash
# Builds src-tauri/resources/runtime-<target>.zip: a private Python
# (python-build-standalone) plus an offline wheelhouse for tracinator itself
# and its `dependencies` from pyproject.toml — what the desktop shell's
# first-run bootstrap
# (src-tauri/src/lib.rs) unzips and `pip install --no-index --target`s into
# the app data dir, so end users need no preinstalled Python. This does NOT
# touch the *traced-code* interpreter (tracinator/server/app.py's
# resolve_python_executable) — that's a separate, already-shipped concern.
#
# --platform/--only-binary guarantee the wheelhouse matches the *target*
# platform regardless of the build host's own OS/arch (same technique
# build_lambda.sh already uses for the Lambda zip) — so both runtimes can be
# built from one machine, same as that script's cross-platform wheel pulls.
#
# Output is named per-target (not a fixed runtime.zip) so building one
# platform never clobbers the other's already-built archive — both can sit
# in resources/ side by side. tauri.linux.conf.json / tauri.windows.conf.json
# each list their own platform's archive under `bundle.resources`, and
# bootstrap.rs's runtime_resource_path() looks up the matching per-platform
# name at runtime — so exactly one lands inside each platform's actual
# installer, chosen automatically by `tauri build` itself. (An earlier
# version relied on the map form of `bundle.resources` to rename the archive
# to a fixed "runtime.zip" inside the bundle, but that rename silently didn't
# apply in the Windows MSI/WiX bundle, so bootstrap.rs now resolves the real
# per-platform name directly instead.)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESOURCES_DIR="$REPO_ROOT/src-tauri/resources"
BUILD_DIR="$REPO_ROOT/build/desktop-runtime"

# Pinned python-build-standalone release (github.com/astral-sh/python-build-standalone).
# "install_only_stripped" = no debug symbols, ~3x smaller than "install_only";
# confirmed on 20260814 to still ship a working pip.
PBS_TAG="20260814"
PBS_PY_VERSION="3.12.14"

TARGET="${1:-linux-x86_64}"
case "$TARGET" in
  linux-x86_64)
    PBS_TRIPLE="x86_64-unknown-linux-gnu"
    PIP_PLATFORM="manylinux2014_x86_64"
    PYTHON_REL="python/bin/python3"
    ;;
  windows-x86_64)
    PBS_TRIPLE="x86_64-pc-windows-msvc"
    PIP_PLATFORM="win_amd64"
    PYTHON_REL="python/python.exe"
    ;;
  *)
    echo "Usage: build_desktop_runtime.sh [linux-x86_64|windows-x86_64]" >&2
    exit 1
    ;;
esac

ZIP_PATH="$RESOURCES_DIR/runtime-${TARGET}.zip"

PBS_ASSET="cpython-${PBS_PY_VERSION}+${PBS_TAG}-${PBS_TRIPLE}-install_only_stripped.tar.gz"
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${PBS_ASSET}"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR" "$RESOURCES_DIR"

echo "==> Downloading interpreter ($TARGET): $PBS_ASSET"
curl -sL -o "$BUILD_DIR/interpreter.tar.gz" "$PBS_URL"
tar xzf "$BUILD_DIR/interpreter.tar.gz" -C "$BUILD_DIR"
test -f "$BUILD_DIR/$PYTHON_REL" || { echo "Extracted interpreter missing $PYTHON_REL" >&2; exit 1; }

DIST_DIR="$REPO_ROOT/tracinator/ui/dist"
if [ ! -f "$DIST_DIR/index.html" ]; then
  echo "tracinator/ui/dist is missing (no index.html) — run \`npm run build\` in" >&2
  echo "tracinator/ui/ first. pyproject.toml only bundles ui/dist into the wheel" >&2
  echo "if it already exists when this script builds it; skipping this ships an" >&2
  echo "app with no frontend to serve (a bare {\"detail\":\"Not Found\"} at runtime)." >&2
  exit 1
fi

echo "==> Building tracinator wheel"
python3 -m pip install --quiet --upgrade build
python3 -m build --quiet --wheel --outdir "$BUILD_DIR/wheelhouse" "$REPO_ROOT"

echo "==> Downloading offline wheelhouse for $PIP_PLATFORM"
# Resolves dependencies straight off the tracinator wheel just built above
# (found via --find-links, no name list duplicated here) so this can't drift
# from pyproject.toml's `dependencies` the way a hardcoded package list did.
python3 -m pip download \
  --platform "$PIP_PLATFORM" \
  --implementation cp \
  --python-version 3.12 \
  --only-binary=:all: \
  --find-links "$BUILD_DIR/wheelhouse" \
  --dest "$BUILD_DIR/wheelhouse" \
  tracinator

# Can only execute the interpreter we just extracted when it matches the
# build host (e.g. the windows-x86_64 target can't run here on Linux) — the
# wheel resolution above already caught any dependency-availability
# mismatches regardless, so a cross-built archive still fails loudly if
# something's missing, just not via this extra execution check.
if [ "$TARGET" = "linux-x86_64" ] && [ "$(uname -s)" = "Linux" ]; then
  echo "==> Verifying the offline install actually works (no network, no system Python)"
  rm -rf "$BUILD_DIR/verify-site-packages"
  "$BUILD_DIR/$PYTHON_REL" -m pip install --quiet --no-index \
    --find-links "$BUILD_DIR/wheelhouse" \
    --target "$BUILD_DIR/verify-site-packages" \
    tracinator
  rm -rf "$BUILD_DIR/verify-site-packages"
fi

echo "==> Zipping $(basename "$ZIP_PATH")"
rm -f "$ZIP_PATH"
(cd "$BUILD_DIR" && zip -qr "$ZIP_PATH" python wheelhouse)

echo "Built $ZIP_PATH ($(du -h "$ZIP_PATH" | cut -f1))"
