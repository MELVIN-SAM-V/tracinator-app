#!/usr/bin/env bash
# Builds, signs, and publishes a desktop app release for the CURRENT
# platform only. Tauri installers can't be reliably cross-compiled — on the
# WSL2 + native Windows dual-boot setup this machine has, run this once
# from each side to cover both platforms.
# Merges into the existing releases.tracinator.com/latest.json instead of
# overwriting it, so publishing from one platform never wipes out the
# other's entry.
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
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUCKET="releases.tracinator.com"

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
(cd "$REPO_ROOT/tracinator/ui" && npx tauri build)

VERSION="$(node -p "require('$REPO_ROOT/src-tauri/tauri.conf.json').version")"
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

MANIFEST_TMP="$(mktemp)"
trap 'rm -f "$MANIFEST_TMP"' EXIT

if aws s3 cp "s3://$BUCKET/latest.json" "$MANIFEST_TMP" 2>/dev/null; then
  echo "==> Merging into existing latest.json"
else
  echo "==> No existing latest.json — starting a fresh manifest"
  echo '{"version":"","notes":"","pub_date":"","platforms":{}}' > "$MANIFEST_TMP"
fi

UPDATED_MANIFEST="$(mktemp)"
# Passed as env vars rather than interpolated into the JS source directly —
# SIGNATURE in particular shouldn't be pasted into a script string just
# because it happens to be base64 today.
MANIFEST_IN="$MANIFEST_TMP" MANIFEST_OUT="$UPDATED_MANIFEST" VERSION="$VERSION" \
PLATFORM_KEY="$PLATFORM_KEY" SIGNATURE="$SIGNATURE" \
ARTIFACT_URL="https://$BUCKET/$ARTIFACT_KEY" \
node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(process.env.MANIFEST_IN, "utf8"));
manifest.version = process.env.VERSION;
manifest.pub_date = new Date().toISOString();
manifest.platforms = manifest.platforms || {};
manifest.platforms[process.env.PLATFORM_KEY] = {
  signature: process.env.SIGNATURE,
  url: process.env.ARTIFACT_URL,
};
fs.writeFileSync(process.env.MANIFEST_OUT, JSON.stringify(manifest, null, 2));
'

echo "==> Publishing latest.json"
aws s3 cp "$UPDATED_MANIFEST" "s3://$BUCKET/latest.json"
rm -f "$UPDATED_MANIFEST"

echo "==> Invalidating CloudFront cache for /latest.json"
aws cloudfront create-invalidation \
  --distribution-id "$RELEASES_CLOUDFRONT_DISTRIBUTION_ID" \
  --paths "/latest.json"

echo "Published $VERSION for $PLATFORM_KEY."
