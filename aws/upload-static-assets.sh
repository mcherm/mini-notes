#!/usr/bin/env bash
set -euo pipefail

# Uploads the contents of html/ to the S3 frontend bucket for the current STAGE.
# Source aws/env.sh before running this script.

BUCKET="mini-notes-frontend-${STAGE}"

aws s3 sync html/ "s3://${BUCKET}/" --delete

echo ""
echo "Static assets uploaded to s3://${BUCKET}/"
