#!/usr/bin/env bash
set -euo pipefail

# Builds one lambda as an arm64 Linux release binary and copies it to
# $LAMBDA_DIR/<LAMBDA>/bootstrap.
#
# Usage: scripts/build-lambda.sh LAMBDA      (e.g. api-v1)
# Requires: a running Docker daemon.

cd "$(dirname "${BASH_SOURCE[0]}")/.."

[ $# -eq 1 ] || { echo "Usage: $0 LAMBDA" >&2; exit 1; }
LAMBDA="$1"

# Also defined in package-lambda.sh and deploy-lambda.sh; keep them in sync.
LAMBDA_DIR="target/lambda"

# A container-only target dir keeps these Linux artifacts from colliding with the
# macOS ones that `cargo test` writes to target/; CARGO_HOME persists the registry.
CONTAINER_TARGET="target/container"

# The Lambda build runs in this image. Pinned to bullseye (glibc 2.31) because the
# provided.al2023 runtime has glibc 2.34 and glibc is not forward compatible: a newer
# base such as bookworm (2.36) compiles and deploys fine, then fails at Lambda init.
BUILD_IMAGE="rust:1-bullseye"

# The build runs inside an arm64 Linux container: the same CPU as this Mac and the
# same OS as Lambda, so it is an ordinary native build with no cross-compilation.
if ! docker info >/dev/null 2>&1; then
    echo "• Docker daemon isn't reachable — the build runs inside a Linux container." >&2
    echo "  Start Docker (OrbStack, Docker Desktop, colima, …) and re-run." >&2
    exit 1
fi
docker run --rm \
    --platform linux/arm64 \
    -v "$PWD":/work -w /work \
    -e CARGO_TARGET_DIR="/work/$CONTAINER_TARGET" \
    -e CARGO_HOME="/work/$CONTAINER_TARGET/cargo-home" \
    "$BUILD_IMAGE" \
    cargo build --release --package "$LAMBDA"
mkdir -p "$LAMBDA_DIR/$LAMBDA"
cp "$CONTAINER_TARGET/release/$LAMBDA" "$LAMBDA_DIR/$LAMBDA/bootstrap"
