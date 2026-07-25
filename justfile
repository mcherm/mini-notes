# Requires: cargo-lambda (cargo install cargo-lambda), cross (cargo install cross),
#           a running Docker daemon, AWS CLI, just
# https://www.cargo-lambda.info/  •  https://just.systems/
#
# To add a lambda: add build-<name>, zip-<name>, and deploy-<name> recipes
# (delegating to the _build/_zip/_deploy helpers), and add them to the
# `build`, `zip`, and `deploy-lambdas` aggregate recipes below.

LAMBDA_DIR := "target/lambda"
STAGE      := env_var_or_default("STAGE", "dev")
SENTINELS  := "target/.sentinels"

# CloudFront distribution ids, per stage.
CF_DIST_ID_dev  := "EE5QH6UGUBU5G"
CF_DIST_ID_prod := "ELFIR4781UMJC"

# List available recipes (default when run with no arguments).
default:
    @just --list

# ── Build ─────────────────────────────────────────────────────────────────────

# Build all lambdas.
build: build-api-v1 build-job-heartbeat

# Build the api-v1 lambda.
build-api-v1: (_build "api-v1")

# Build the job-heartbeat lambda.
build-job-heartbeat: (_build "job-heartbeat")

[private]
_build LAMBDA:
    #!/usr/bin/env bash
    set -euo pipefail
    # We build with `--compiler cross`, which compiles inside a Linux container
    # (via cross-rs + Docker) using a native C toolchain. This is required because
    # the default zig cross-compiler fails to archive aws-lc-sys's C crypto library
    # (the AWS SDK's TLS backend), producing an empty .a and link errors. Preconditions
    # are detected here and reported together so a missing setup fails fast and clearly.
    missing=0
    if ! command -v cross >/dev/null 2>&1; then
        echo "• 'cross' is not installed — install it with:  cargo install cross" >&2
        missing=1
    fi
    if ! docker info >/dev/null 2>&1; then
        echo "• Docker daemon isn't reachable — the build runs inside a Linux container." >&2
        echo "  Start Docker (Docker Desktop, colima, …) and re-run." >&2
        missing=1
    fi
    if [ "$missing" -ne 0 ]; then
        echo "Cannot run the container-based Lambda build until the above are resolved." >&2
        exit 1
    fi
    cargo lambda build --release --arm64 --lambda-dir {{LAMBDA_DIR}} --package {{LAMBDA}} --compiler cross

# ── Zip ───────────────────────────────────────────────────────────────────────

# Package all lambdas for Lambda.
zip: zip-api-v1 zip-job-heartbeat

# Package the api-v1 lambda for Lambda.
zip-api-v1: (_zip "api-v1")

# Package the job-heartbeat lambda for Lambda.
zip-job-heartbeat: (_zip "job-heartbeat")

[private]
_zip LAMBDA: (_build LAMBDA)
    zip -j {{LAMBDA_DIR}}/{{LAMBDA}}/bootstrap.zip {{LAMBDA_DIR}}/{{LAMBDA}}/bootstrap

# ── Deploy ────────────────────────────────────────────────────────────────────

# Deploy everything (lambdas + frontend) for STAGE (default dev; STAGE=prod for prod).
deploy: deploy-lambdas deploy-frontend

# Deploy all lambdas for STAGE.
deploy-lambdas: deploy-api-v1 deploy-job-heartbeat

# Deploy the api-v1 lambda for STAGE (skips if sources are unchanged).
deploy-api-v1: (_deploy "api-v1")

# Deploy the job-heartbeat lambda for STAGE (skips if sources are unchanged).
deploy-job-heartbeat: (_deploy "job-heartbeat")

# Fail fast (before touching AWS) if the project environment wasn't sourced.
# `source ./aws/env.sh` sets AWS_PROFILE=mini-notes; without it, deploys hit the
# wrong account and fail with a confusing "Function not found".
[private]
_check-aws-env:
    #!/usr/bin/env bash
    if [ "${AWS_PROFILE:-}" != "mini-notes" ]; then
        echo "AWS_PROFILE is not 'mini-notes' (currently: '${AWS_PROFILE:-<unset>}')." >&2
        echo "Deploys would target the wrong AWS account. First run:  source ./aws/env.sh" >&2
        exit 1
    fi

[private]
_deploy LAMBDA: _check-aws-env
    #!/usr/bin/env bash
    set -euo pipefail
    sentinel="{{SENTINELS}}/deploy-{{LAMBDA}}-{{STAGE}}"
    sources=(lambdas/{{LAMBDA}}/src lambdas/{{LAMBDA}}/Cargo.toml lambdas/common/src lambdas/common/Cargo.toml)
    if [ -f "$sentinel" ] && [ -z "$(find "${sources[@]}" -type f -newer "$sentinel")" ]; then
        echo "deploy-{{LAMBDA}}-{{STAGE}}: already up to date"
        exit 0
    fi
    just _zip {{LAMBDA}}
    aws lambda update-function-code \
        --function-name mini-notes-{{LAMBDA}}-{{STAGE}} \
        --zip-file fileb://{{LAMBDA_DIR}}/{{LAMBDA}}/bootstrap.zip \
        --architectures arm64
    mkdir -p "{{SENTINELS}}"
    touch "$sentinel"

# Deploy the static frontend for STAGE (skips if html/ is unchanged).
deploy-frontend: _check-aws-env
    #!/usr/bin/env bash
    set -euo pipefail
    sentinel="{{SENTINELS}}/deploy-frontend-{{STAGE}}"
    if [ -f "$sentinel" ] && [ -z "$(find html -type f -newer "$sentinel")" ]; then
        echo "deploy-frontend-{{STAGE}}: already up to date"
        exit 0
    fi
    dist_id="{{ if STAGE == "prod" { CF_DIST_ID_prod } else { CF_DIST_ID_dev } }}"

    # Stage the deploy under target/ so html/ (sources only) is never mutated,
    # then stamp sw.js: SHELL_ASSETS from the canonical list in shell-assets.txt,
    # and ASSET_VERSION as a content hash of those assets so the browser sees a
    # changed service worker whenever any shell asset changes.
    staging="target/frontend-staging"
    rm -rf "$staging"
    mkdir -p "$staging"
    cp -R html/. "$staging"
    shell_assets=($(grep -v '^#' html/shell-assets.txt || true))
    [ "${#shell_assets[@]}" -gt 0 ] || { echo "html/shell-assets.txt lists no assets" >&2; exit 1; }
    hash=$(cd "$staging" && cat "${shell_assets[@]#/}" | shasum -a 256 | cut -c1-16)
    assets_js=$(printf '"%s", ' "${shell_assets[@]}")
    sed -i '' -e "s|^const ASSET_VERSION = .*|const ASSET_VERSION = \"$hash\";|" \
              -e "s|^const SHELL_ASSETS = .*|const SHELL_ASSETS = [${assets_js%, }];|" \
        "$staging/sw.js"
    grep -q "const ASSET_VERSION = \"$hash\";" "$staging/sw.js" \
        || { echo "failed to stamp ASSET_VERSION into sw.js" >&2; exit 1; }
    grep -qF '"/index.html"' "$staging/sw.js" \
        || { echo "failed to stamp SHELL_ASSETS into sw.js" >&2; exit 1; }

    # Upload in two passes to set Cache-Control: no-cache on exactly the files
    # the service worker never serves from its cache: sw.js itself, the HTML
    # pages, and the online-only pages' assets. Everything else keeps default
    # headers. (--exclude also protects those files from --delete in pass one.)
    no_cache_patterns=("sw.js" "*.html" "admin.*" "reset-password.*")
    exclude_no_cache=()
    include_no_cache=()
    for pattern in "${no_cache_patterns[@]}"; do
        exclude_no_cache+=(--exclude "$pattern")
        include_no_cache+=(--include "$pattern")
    done
    aws s3 sync "$staging/" s3://mini-notes-frontend-{{STAGE}}/ --delete "${exclude_no_cache[@]}"
    aws s3 sync "$staging/" s3://mini-notes-frontend-{{STAGE}}/ --cache-control no-cache \
        --exclude "*" "${include_no_cache[@]}"
    aws cloudfront create-invalidation \
        --distribution-id "$dist_id" \
        --paths "/*"
    mkdir -p "{{SENTINELS}}"
    touch "$sentinel"

# ── Test ──────────────────────────────────────────────────────────────────────

# Run the test suite.
test:
    cargo test

# ── Misc ──────────────────────────────────────────────────────────────────────

# Remove build artifacts and deploy sentinels.
clean:
    cargo clean
    rm -rf {{SENTINELS}}
