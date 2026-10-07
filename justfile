# Requires: a running Docker daemon, AWS CLI, just
#           (plus a host Rust toolchain, for `just test-rust` and `just lint-rust`,
#           Biome (https://biomejs.dev/), for `just lint-web`, and
#           ShellCheck (https://www.shellcheck.net/), for `just lint-scripts`)
# https://just.systems/
#
# To add a lambda: add build-<name>, zip-<name>, and deploy-<name> recipes
# (delegating to the _build/_zip/_deploy helpers), and add them to the
# `build`, `zip`, and `deploy-lambdas` aggregate recipes below.

# Also defined in scripts/deploy-lambda.sh and scripts/deploy-frontend.sh; keep them in sync.
SENTINELS := "target/.sentinels"

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
    scripts/build-lambda.sh {{LAMBDA}}

# ── Zip ───────────────────────────────────────────────────────────────────────

# Package all lambdas for Lambda.
zip: zip-api-v1 zip-job-heartbeat

# Package the api-v1 lambda for Lambda.
zip-api-v1: (_zip "api-v1")

# Package the job-heartbeat lambda for Lambda.
zip-job-heartbeat: (_zip "job-heartbeat")

[private]
_zip LAMBDA:
    scripts/package-lambda.sh {{LAMBDA}}

# ── Deploy ────────────────────────────────────────────────────────────────────

# Deploy everything (lambdas + frontend) for STAGE (requires `source ./aws/env.sh`; STAGE=prod for prod).
deploy: deploy-lambdas deploy-frontend

# Deploy all lambdas for STAGE.
deploy-lambdas: deploy-api-v1 deploy-job-heartbeat

# Deploy the api-v1 lambda for STAGE (skips if sources are unchanged).
deploy-api-v1: (_deploy "api-v1")

# Deploy the job-heartbeat lambda for STAGE (skips if sources are unchanged).
deploy-job-heartbeat: (_deploy "job-heartbeat")

[private]
_deploy LAMBDA:
    scripts/deploy-lambda.sh {{LAMBDA}}

# Deploy the static frontend for STAGE (skips if html/ is unchanged).
deploy-frontend:
    scripts/deploy-frontend.sh

# Assemble the deployable frontend (stamped sw.js) in target/frontend-staging, without deploying.
stage-frontend:
    scripts/stage-frontend.sh

# ── Test ──────────────────────────────────────────────────────────────────────

# Run every test suite.
test: test-rust test-js

# Run the Rust test suite.
test-rust:
    cargo test

# Run the JavaScript test suite (requires node; no npm packages are used).
test-js:
    #!/usr/bin/env bash
    set -euo pipefail
    # The glob is quoted so that node expands it rather than the shell: handing node
    # a bare directory makes it treat the directory itself as a single test file.
    node --test "tests/**/*.test.mjs"

# ── Lint ──────────────────────────────────────────────────────────────────────

# Run every static checker.
lint: lint-rust lint-web lint-scripts

# Run clippy on all Rust code (including tests); warnings fail the check.
lint-rust:
    cargo clippy --workspace --all-targets -- -D warnings

# Run Biome on the JavaScript, CSS, and HTML (requires biome); warnings fail the check.
lint-web:
    biome lint --error-on-warnings --max-diagnostics=none html tests

# Run ShellCheck on the scripts in scripts/ (requires shellcheck); any finding fails the check.
lint-scripts:
    shellcheck scripts/*.sh scripts/lib/*.sh

# ── Misc ──────────────────────────────────────────────────────────────────────

# Remove build artifacts and deploy sentinels.
clean:
    cargo clean
    rm -rf {{SENTINELS}}
