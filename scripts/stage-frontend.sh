#!/usr/bin/env bash
set -euo pipefail

# Assembles the deployable frontend in $FRONTEND_STAGING: a copy of html/ with
# sw.js stamped and the source-only README.txt files removed. html/ itself is
# never modified.
#
# Usage: scripts/stage-frontend.sh

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Also defined in deploy-frontend.sh; keep them in sync.
FRONTEND_STAGING="target/frontend-staging"

rm -rf "$FRONTEND_STAGING"
mkdir -p "$FRONTEND_STAGING"
cp -R html/. "$FRONTEND_STAGING"

# Stamp sw.js: SHELL_ASSETS from the canonical list in shell-assets.txt, and
# ASSET_VERSION as a content hash of those assets so the browser sees a changed
# service worker whenever any shell asset changes.
shell_assets=()
while read -r asset; do
    if [ -n "$asset" ] && [ "${asset:0:1}" != "#" ]; then
        shell_assets+=("$asset")
    fi
done < html/shell-assets.txt
[ "${#shell_assets[@]}" -gt 0 ] || { echo "html/shell-assets.txt lists no assets" >&2; exit 1; }
hash=$(cd "$FRONTEND_STAGING" && cat "${shell_assets[@]#/}" | shasum -a 256 | cut -c1-16)
assets_js=$(printf '"%s", ' "${shell_assets[@]}")
sed -i '' -e "s|^const ASSET_VERSION = .*|const ASSET_VERSION = \"$hash\";|" \
          -e "s|^const SHELL_ASSETS = .*|const SHELL_ASSETS = [${assets_js%, }];|" \
    "$FRONTEND_STAGING/sw.js"
grep -q "const ASSET_VERSION = \"$hash\";" "$FRONTEND_STAGING/sw.js" \
    || { echo "failed to stamp ASSET_VERSION into sw.js" >&2; exit 1; }
grep -qF '"/index.html"' "$FRONTEND_STAGING/sw.js" \
    || { echo "failed to stamp SHELL_ASSETS into sw.js" >&2; exit 1; }

# The per-directory README.txt files document the sources; they are not served.
find "$FRONTEND_STAGING" -name README.txt -delete
