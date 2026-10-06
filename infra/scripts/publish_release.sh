#!/usr/bin/env bash
# Builds, signs, and publishes a desktop app release for the CURRENT
# platform only. Tauri installers can't be reliably cross-compiled — on the
# WSL2 + native Windows dual-boot setup this machine has, run this once
# from each side to cover both platforms.
# Each platform has its own manifest, $PLATFORM_KEY/latest.json, matching
# the {{target}}-{{arch}} endpoint in tauri.conf.json's
# plugins.updater.endpoints. A run only ever writes its own platform's
# manifest. A shared manifest would have a single top-level "version" for
# every platform, so publishing one platform first would offer the other's
# users a version whose entry still pointed at their old installer.
#
# NOT YET RUN END TO END — infra/environments/releases hasn't been applied
# yet, and this hasn't been exercised against a real build. Written to the
# same standard as the rest of infra/scripts/, but treat the first real run
# as a trial: watch its output, don't assume it's silently correct.
#
# Requires:
# - TAURI_SIGNING_PRIVATE_KEY (or _PATH) + optionally _PASSWORD — see
#   `npx tauri signer generate`'s output; this is the update-signing
#   keypair the Tauri updater uses to verify a downloaded release is
#   authentic.
# - RELEASES_CLOUDFRONT_DISTRIBUTION_ID — the cloudfront_distribution_id
#   output from infra/environments/releases, once that has been applied.
# - AWS credentials for the same account as the rest of infra/.
#
# Optional, for a throwaway test stack (see infra/README.md, "Testing a
# release end to end"):
# - RELEASES_BUCKET — defaults to releases.tracinator.com. The bucket is
#   named after its domain, so this also sets the installer URLs written
#   into the manifest.
# - TAURI_EXTRA_CONFIG — a Tauri config file merged over tauri.conf.json at
#   build time (`tauri build --config`), e.g. src-tauri/tauri.test.conf.json
#   to point the built app's updater at the test stack instead of production.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUCKET="${RELEASES_BUCKET:-releases.tracinator.com}"

: "${TAURI_SIGNING_PRIVATE_KEY:?Set this or TAURI_SIGNING_PRIVATE_KEY_PATH — see \`npx tauri signer generate\`}"
: "${RELEASES_CLOUDFRONT_DISTRIBUTION_ID:?Set this to the cloudfront_distribution_id output from infra/environments/releases}"

case "$(uname -s)" in
  Linux*) PLATFORM_KEY="linux-x86_64" ;;
  MINGW*|MSYS*|CYGWIN*) PLATFORM_KEY="windows-x86_64" ;;
  *) echo "Unsupported build platform: $(uname -s)" >&2; exit 1 ;;
esac

echo "==> Building frontend"
(cd "$REPO_ROOT/tracinator/ui" && npm run build)

echo "==> Building + signing the desktop app ($PLATFORM_KEY)"
TAURI_BUILD_ARGS=()
if [ -n "${TAURI_EXTRA_CONFIG:-}" ]; then
  # Resolved now, since the build runs from the repo root and a relative
  # path would otherwise point somewhere else.
  EXTRA_CONFIG_PATH="$(cd "$(dirname "$TAURI_EXTRA_CONFIG")" && pwd)/$(basename "$TAURI_EXTRA_CONFIG")"
  [ -f "$EXTRA_CONFIG_PATH" ] || { echo "TAURI_EXTRA_CONFIG not found: $TAURI_EXTRA_CONFIG" >&2; exit 1; }
  # VERSION below is read from tauri.conf.json alone, so an override that
  # changed it would publish a manifest that disagrees with the build.
  if node -e 'process.exit("version" in require(process.argv[1]) ? 0 : 1)' "$EXTRA_CONFIG_PATH"; then
    echo "$TAURI_EXTRA_CONFIG sets \"version\" — set it in src-tauri/tauri.conf.json instead." >&2
    exit 1
  fi
  echo "==> Merging $TAURI_EXTRA_CONFIG over tauri.conf.json"
  TAURI_BUILD_ARGS+=(--config "$EXTRA_CONFIG_PATH")
fi
# Run from the repo root: the Tauri CLI only searches the current folder and
# below for src-tauri/tauri.conf.json, so starting it from tracinator/ui
# fails with "Couldn't recognize the current folder as a Tauri project".
# The CLI is installed only in tracinator/ui/node_modules, so it's called by
# path rather than through npx.
(cd "$REPO_ROOT" && tracinator/ui/node_modules/.bin/tauri build "${TAURI_BUILD_ARGS[@]}")

# Relative, not "$REPO_ROOT/...": in Git Bash that's a /c/... path, and
# Git Bash doesn't convert paths embedded in a JS string, so Windows Node
# can't resolve it. This means the script must be run from the repo root.
VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
BUNDLE_DIR="$REPO_ROOT/src-tauri/target/release/bundle"

# Tauri only emits a .sig next to the specific bundle format its updater
# supports per platform (AppImage on Linux, NSIS/MSI zip on Windows) — deb/
# rpm/etc. from bundle.targets: "all" are regular installers the updater
# never touches, so this naturally ignores them without hardcoding which
# formats got built.
SIG_FILE="$(find "$BUNDLE_DIR" -iname "*.sig" | head -1)"
if [ -z "$SIG_FILE" ]; then
  echo "No .sig file found under $BUNDLE_DIR — is createUpdaterArtifacts: true in tauri.conf.json, and did signing actually run?" >&2
  exit 1
fi
ARTIFACT_FILE="${SIG_FILE%.sig}"
SIGNATURE="$(cat "$SIG_FILE")"

RELEASE_PREFIX="v${VERSION}"
ARTIFACT_KEY="${RELEASE_PREFIX}/$(basename "$ARTIFACT_FILE")"

# Guards against re-running with a forgotten version bump, which would
# silently overwrite this platform's already-published artifacts for this
# version. Checked per-platform (not per-prefix) since Linux and Windows
# intentionally publish into the same v$VERSION/ prefix — see header.
if aws s3api head-object --bucket "$BUCKET" --key "$ARTIFACT_KEY" >/dev/null 2>&1; then
  echo "s3://$BUCKET/$ARTIFACT_KEY already exists — $PLATFORM_KEY was already published for version $VERSION. Bump \"version\" in src-tauri/tauri.conf.json before publishing again." >&2
  exit 1
fi

echo "==> Uploading all installer artifacts for this platform to s3://$BUCKET/$RELEASE_PREFIX/"
aws s3 cp "$BUNDLE_DIR" "s3://$BUCKET/$RELEASE_PREFIX/" --recursive --exclude "*" \
  --include "*.AppImage" --include "*.deb" --include "*.rpm" \
  --include "*.msi" --include "*.exe" \
  --include "*.tar.gz" --include "*.tar.gz.sig" \
  --include "*.zip" --include "*.zip.sig"

MANIFEST_KEY="$PLATFORM_KEY/latest.json"
MANIFEST_TMP="$(mktemp)"
trap 'rm -f "$MANIFEST_TMP"' EXIT

# Written fresh every time, never merged: this manifest only ever describes
# this platform's newest release.
# Passed as env vars rather than interpolated into the JS source directly —
# SIGNATURE in particular shouldn't be pasted into a script string just
# because it happens to be base64 today.
MANIFEST_OUT="$MANIFEST_TMP" VERSION="$VERSION" \
PLATFORM_KEY="$PLATFORM_KEY" SIGNATURE="$SIGNATURE" \
ARTIFACT_URL="https://$BUCKET/$ARTIFACT_KEY" \
node -e '
const fs = require("fs");
const manifest = {
  version: process.env.VERSION,
  notes: "",
  pub_date: new Date().toISOString(),
  platforms: {
    [process.env.PLATFORM_KEY]: {
      signature: process.env.SIGNATURE,
      url: process.env.ARTIFACT_URL,
    },
  },
};
fs.writeFileSync(process.env.MANIFEST_OUT, JSON.stringify(manifest, null, 2));
'

echo "==> Publishing $MANIFEST_KEY"
aws s3 cp "$MANIFEST_TMP" "s3://$BUCKET/$MANIFEST_KEY"

echo "==> Invalidating CloudFront cache for /$MANIFEST_KEY"
aws cloudfront create-invalidation \
  --distribution-id "$RELEASES_CLOUDFRONT_DISTRIBUTION_ID" \
  --paths "/$MANIFEST_KEY"

echo "Published $VERSION for $PLATFORM_KEY."
