#!/usr/bin/env bash
set -euo pipefail

# Builds one lambda and packages it as $LAMBDA_DIR/<LAMBDA>/bootstrap.zip.
#
# Usage: scripts/package-lambda.sh LAMBDA    (e.g. api-v1)

cd "$(dirname "${BASH_SOURCE[0]}")/.."

[ $# -eq 1 ] || { echo "Usage: $0 LAMBDA" >&2; exit 1; }
LAMBDA="$1"

# Also defined in build-lambda.sh and deploy-lambda.sh; keep them in sync.
LAMBDA_DIR="target/lambda"

scripts/build-lambda.sh "$LAMBDA"
zip -j "$LAMBDA_DIR/$LAMBDA/bootstrap.zip" "$LAMBDA_DIR/$LAMBDA/bootstrap"
