# Desktop release hosting

`releases.tracinator.com` — the S3 + CloudFront bucket that hosts the Tauri
updater's `latest.json` manifest and signed installers. This is what
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
merges the new platform's entry into `latest.json`, and invalidates
CloudFront for it. Run once per target OS you're releasing for. See the
script's own header comments for the full sequence and guardrails
(re-publish protection, etc.).

## Building the bundled runtime

```
infra/scripts/build_desktop_runtime.sh <target-triple>
```

Downloads a standalone Python build, builds a `tracinator` wheel, downloads
an offline wheelhouse for the target platform, and zips it into
`src-tauri/resources/runtime-<target>.zip` — what the app's first-run
bootstrap (`src-tauri/src/lib.rs`) unpacks. Requires `tracinator/ui/dist` to
already exist (`cd tracinator/ui && npm run build` first).
