#!/bin/sh
# Build the happy-server image from upstream slopus/happy (packages/happy-server)
# at the commit pinned in UPSTREAM_SHA. Optional local patches in patches/*.patch
# are applied with `git apply` — keep that directory empty unless upstream lacks a fix.
#
# Usage: ./build-upstream.sh            # builds happy-server:upstream-<short sha>
#        UPSTREAM_DIR=/path ./build-upstream.sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
sha=$(tr -d '[:space:]' < "$here/UPSTREAM_SHA")
short=$(printf '%s' "$sha" | cut -c1-7)
dir=${UPSTREAM_DIR:-/root/happy-upstream}
tag="happy-server:upstream-$short"

if [ ! -d "$dir/.git" ]; then
    git clone --filter=blob:none https://github.com/slopus/happy.git "$dir"
fi
git -C "$dir" fetch --quiet origin
git -C "$dir" reset --quiet --hard
git -C "$dir" clean --quiet -fdx
git -C "$dir" checkout --quiet --detach "$sha"

for p in "$here"/patches/*.patch; do
    [ -e "$p" ] || continue
    echo "applying $(basename "$p")"
    git -C "$dir" apply "$p"
done

docker build -f "$dir/Dockerfile.server" -t "$tag" "$dir"
echo "built $tag"
echo "compose expects: image: $tag  (docker-compose.yml)"
