#!/usr/bin/env bash
# Builds and publishes what mxm.sebastianlopez.me serves now that the site
# lives at mxmstudio.work.
#
#   deploy/old-domain/build.sh <dist of the last build published there>
#   CLOUDFLARE_ACCOUNT_ID=<Sebastián's account> npx wrangler@4 deploy   (from this directory)
#
# The input is a full site build, not an empty folder: a tab left open on
# the old address keeps asking for its hashed scripts, workers and ffmpeg
# pieces, and it must still get them. Only three files change on top:
#   index.html  the "moved" page (any route lands on it: SPA fallback)
#   moved.js    carries localStorage to the new address (web/src/migrate.ts)
#   sw.js       clears the old app's caches and unregisters itself
# public/_headers comes along with the build, so the page runs under the
# same CSP; that is why the script is a file and not inline.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="${1:?usage: build.sh <path to a built web/dist>}"
[ -f "$src/index.html" ] && [ -f "$src/_headers" ] || {
  echo "$src is not a site build (no index.html or _headers)" >&2
  exit 1
}
rm -rf "$here/dist"
cp -R "$src" "$here/dist"
cp "$here/index.html" "$here/moved.js" "$here/sw.js" "$here/dist/"
echo "ready: $here/dist"
