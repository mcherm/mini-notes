#!/usr/bin/env bash
set -euo pipefail

# Stages the static frontend, uploads it to the mini-notes-frontend-$STAGE bucket,
# and invalidates the CloudFront cache. Skips the deploy if html/ is unchanged
# since the last one.
#
# Usage: scripts/deploy-frontend.sh
# Requires: AWS_PROFILE and STAGE, set by `source ./aws/env.sh`.

cd "$(dirname "${BASH_SOURCE[0]}")/.."
source scripts/lib/check-deploy-env.sh

# Also defined in stage-frontend.sh; keep them in sync.
FRONTEND_STAGING="target/frontend-staging"

# Also defined in deploy-lambda.sh and the justfile (`clean`); keep them in sync.
SENTINELS="target/.sentinels"

# CloudFront distribution ids, per stage.
CF_DIST_ID_dev="EE5QH6UGUBU5G"
CF_DIST_ID_prod="ELFIR4781UMJC"

sentinel="$SENTINELS/deploy-frontend-$STAGE"
if [ -f "$sentinel" ] && [ -z "$(find html -type f -newer "$sentinel")" ]; then
    echo "deploy-frontend-$STAGE: already up to date"
    exit 0
fi
if [ "$STAGE" = "prod" ]; then
    dist_id="$CF_DIST_ID_prod"
else
    dist_id="$CF_DIST_ID_dev"
fi

scripts/stage-frontend.sh

# Upload in two passes to set Cache-Control: no-cache on every file that can
# be fetched outside the service worker's cache: sw.js itself, the HTML
# pages, and all scripts and stylesheets (the online-only pages load shared
# ones from the network). Images and the manifest keep default headers.
# (--exclude also protects those files from --delete in pass one.)
no_cache_patterns=("sw.js" "*.html" "*.js" "*.css")
exclude_no_cache=()
include_no_cache=()
for pattern in "${no_cache_patterns[@]}"; do
    exclude_no_cache+=(--exclude "$pattern")
    include_no_cache+=(--include "$pattern")
done
aws s3 sync "$FRONTEND_STAGING/" "s3://mini-notes-frontend-$STAGE/" --delete "${exclude_no_cache[@]}"
aws s3 sync "$FRONTEND_STAGING/" "s3://mini-notes-frontend-$STAGE/" --cache-control no-cache \
    --exclude "*" "${include_no_cache[@]}"
aws cloudfront create-invalidation \
    --distribution-id "$dist_id" \
    --paths "/*"
mkdir -p "$SENTINELS"
touch "$sentinel"
