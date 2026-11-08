#!/bin/sh
# Build the self-hosted Happy web portal image (#3).
#
# The web client (packages/happy-app) was deleted upstream in e46a907d
# (2026-11-05), so it is pinned in WEB_SHA to its last commit and is frozen.
# Uses upstream's own Dockerfile.webapp (builder stage) at that commit, then
# portal/Dockerfile copies the export into Caddy with __HAPPY_CONFIG__ injected.
#
# Usage: ./build-portal.sh             # builds happy-portal:web-<short sha>
#        UPSTREAM_DIR=/path ./build-portal.sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
sha=$(tr -d '[:space:]' < "$here/WEB_SHA")
short=$(printf '%s' "$sha" | cut -c1-7)
dir=${UPSTREAM_DIR:-/root/happy-upstream}
server_url=${HAPPY_SERVER_URL_PUBLIC:-https://home8.compagnie-lily.org}
builder="happy-portal-build:$short"
tag="happy-portal:web-$short"

if [ ! -d "$dir/.git" ]; then
    git clone --filter=blob:none https://github.com/slopus/happy.git "$dir"
fi
git -C "$dir" fetch --quiet origin
git -C "$dir" reset --quiet --hard
git -C "$dir" clean --quiet -fdx
git -C "$dir" checkout --quiet --detach "$sha"

docker build -f "$dir/Dockerfile.webapp" --target builder \
    --build-arg HAPPY_SERVER_URL="$server_url" \
    --build-arg HAPPY_BUILD_COMMIT_SHA="$sha" \
    -t "$builder" "$dir"

docker build -f "$here/portal/Dockerfile" \
    --build-arg WEB_BUILDER="$builder" \
    --build-arg HAPPY_CONFIG_JSON="{\"serverUrl\":\"$server_url\",\"disableAnalytics\":true}" \
    -t "$tag" "$here/portal"

# The builder image is several GB of node_modules; only the final image is needed.
docker image rm "$builder" >/dev/null
echo "built $tag"
echo "compose expects: image: $tag  (docker-compose.yml, service portal)"
