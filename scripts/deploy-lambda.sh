#!/usr/bin/env bash
set -euo pipefail

# Builds, packages, and uploads one lambda to mini-notes-<LAMBDA>-$STAGE.
# Skips the deploy if the lambda's sources are unchanged since the last one.
#
# Usage: scripts/deploy-lambda.sh LAMBDA     (e.g. api-v1)
# Requires: AWS_PROFILE and STAGE, set by `source ./aws/env.sh`.

cd "$(dirname "${BASH_SOURCE[0]}")/.."
source scripts/lib/check-deploy-env.sh

[ $# -eq 1 ] || { echo "Usage: $0 LAMBDA" >&2; exit 1; }
LAMBDA="$1"

# Also defined in build-lambda.sh and package-lambda.sh; keep them in sync.
LAMBDA_DIR="target/lambda"

# Also defined in deploy-frontend.sh and the justfile (`clean`); keep them in sync.
SENTINELS="target/.sentinels"

sentinel="$SENTINELS/deploy-$LAMBDA-$STAGE"
sources=("lambdas/$LAMBDA/src" "lambdas/$LAMBDA/Cargo.toml" lambdas/common/src lambdas/common/Cargo.toml)
if [ -f "$sentinel" ] && [ -z "$(find "${sources[@]}" -type f -newer "$sentinel")" ]; then
    echo "deploy-$LAMBDA-$STAGE: already up to date"
    exit 0
fi
scripts/package-lambda.sh "$LAMBDA"
aws lambda update-function-code \
    --function-name "mini-notes-$LAMBDA-$STAGE" \
    --zip-file "fileb://$LAMBDA_DIR/$LAMBDA/bootstrap.zip" \
    --architectures arm64
mkdir -p "$SENTINELS"
touch "$sentinel"
