# Desktop release hosting

`releases.tracinator.com` — the S3 + CloudFront bucket that hosts the Tauri
updater's per-platform manifests (`linux-x86_64/latest.json`,
`windows-x86_64/latest.json`) and signed installers. This is what
`src-tauri/tauri.conf.json`'s `plugins.updater.endpoints` points at, and
what `infra/scripts/publish_release.sh` uploads to. **Not yet deployed** —
`publish_release.sh` has never been run end to end (see its header comment).

This is the only infra this repo owns. The public demo site
(`tracinator.com`, its Terraform, and its Lambda/S3/CloudFront) lives in the
separate `tracinator-site` repo — see that repo's own `infra/README.md`.

## Cross-repo dependency

`environments/releases/main.tf` looks up `tracinator.com`'s Route53 zone
with a live `data "aws_route53_zone"` call rather than creating one — that
zone is created by `tracinator-site`'s `demo` environment. This is a plain
AWS API lookup, not Terraform remote state, so it works fine from a
separate repo/state as long as both target the same AWS account — but
`tracinator-site`'s `demo` environment must be applied (its `dns` module,
specifically) before this one, or the lookup fails.

## One-time setup

State is local (`environments/releases/backend.tf`), gitignored — same
caveat as the site repo's `demo` environment: fine solo, switch to a remote
backend before more than one person/machine applies it.

1. Fill in `environments/releases/terraform.tfvars` (`domain_name`, `aws_region`).
2. `terraform -chdir=environments/releases init`
3. `terraform -chdir=environments/releases apply`
4. Generate an updater signing keypair (`npx tauri signer generate`, from
   `tracinator/ui`) if one doesn't already exist. The public half goes into
   `src-tauri/tauri.conf.json`'s `plugins.updater.pubkey`; keep the private
   half (`src-tauri/updater_signing.key*`, gitignored) somewhere durable —
   losing it means every future release needs a new keypair, and every
   existing install stops trusting new updates until it's manually
   reinstalled with the new one.

## Publishing a release

```
TAURI_SIGNING_PRIVATE_KEY=...                                \
RELEASES_CLOUDFRONT_DISTRIBUTION_ID=<cloudfront_distribution_id output> \
infra/scripts/publish_release.sh
```

Builds the frontend (non-demo mode) and the signed Tauri bundle for the
current OS, uploads the installer(s) to `s3://releases.tracinator.com/v$VERSION/`,
writes that platform's own `<platform>/latest.json`, and invalidates
CloudFront for it. Run once per target OS you're releasing for. Each
platform's manifest is independent, so publishing one never changes what
the other platform's users are offered. See the
script's own header comments for the full sequence and guardrails
(re-publish protection, etc.).

## Testing a release end to end

A throwaway copy of the stack at `releases-test.tracinator.com`, kept in its
own Terraform workspace so it never touches production's state. Builds made
for it use `src-tauri/tauri.test.conf.json`, which only swaps the updater
endpoint, so `tauri.conf.json` stays pointed at production.

1. From `infra/`, deploy the test stack and note its `cloudfront_distribution_id`:
   ```
   terraform -chdir=environments/releases workspace new test
   terraform -chdir=environments/releases apply -var subdomain=releases-test
   ```
2. From the repo root, build and install the "old" version with the test
   config. Signing is required here too (`createUpdaterArtifacts` is on).
   The updater only updates an AppImage on Linux (run it directly, not the
   `.deb`) and the NSIS `-setup.exe` on Windows:
   ```
   cd tracinator/ui && npm run build && \
   TAURI_SIGNING_PRIVATE_KEY=... npx tauri build --config ../../src-tauri/tauri.test.conf.json
   ```
   Copy the installer somewhere else before the next step's build, and
   delete `src-tauri/target/release/bundle`, so the publish step can't pick
   up this older build's files.
3. From the repo root, bump `version` in `src-tauri/tauri.conf.json` and
   publish to the test stack:
   ```
   RELEASES_BUCKET=releases-test.tracinator.com                  \
   RELEASES_CLOUDFRONT_DISTRIBUTION_ID=<test distribution id>     \
   TAURI_EXTRA_CONFIG=src-tauri/tauri.test.conf.json              \
   TAURI_SIGNING_PRIVATE_KEY=...                                  \
   infra/scripts/publish_release.sh
   ```
4. Launch the installed old version: it should offer the update, and
   "Restart to update" should come back on the new version.
5. From `infra/`, tear down. The bucket must be emptied first, since
   Terraform won't delete a non-empty one. Then switch back so later
   applies hit production:
   ```
   aws s3 rm s3://releases-test.tracinator.com --recursive
   terraform -chdir=environments/releases destroy -var subdomain=releases-test
   terraform -chdir=environments/releases workspace select default
   terraform -chdir=environments/releases workspace delete test
   ```
   Then revert the `version` bump.

## Building the bundled runtime

```
infra/scripts/build_desktop_runtime.sh <target-triple>
```

Downloads a standalone Python build, builds a `tracinator` wheel, downloads
an offline wheelhouse for the target platform, and zips it into
`src-tauri/resources/runtime-<target>.zip` — what the app's first-run
bootstrap (`src-tauri/src/lib.rs`) unpacks. Requires `tracinator/ui/dist` to
already exist (`cd tracinator/ui && npm run build` first).
