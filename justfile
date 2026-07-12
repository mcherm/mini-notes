# Requires: cargo-lambda (cargo install cargo-lambda), AWS CLI, just
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
    cargo lambda build --release --arm64 --lambda-dir {{LAMBDA_DIR}} --package {{LAMBDA}}

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

[private]
_deploy LAMBDA:
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
deploy-frontend:
    #!/usr/bin/env bash
    set -euo pipefail
    sentinel="{{SENTINELS}}/deploy-frontend-{{STAGE}}"
    if [ -f "$sentinel" ] && [ -z "$(find html -type f -newer "$sentinel")" ]; then
        echo "deploy-frontend-{{STAGE}}: already up to date"
        exit 0
    fi
    dist_id="{{ if STAGE == "prod" { CF_DIST_ID_prod } else { CF_DIST_ID_dev } }}"
    aws s3 sync html/ s3://mini-notes-frontend-{{STAGE}}/ --delete
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
