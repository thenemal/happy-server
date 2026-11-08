# Final portal image: the Expo web export from upstream's Dockerfile.webapp
# builder stage (built by ../build-portal.sh), served by Caddy with the relay
# URL injected as window.__HAPPY_CONFIG__.
ARG WEB_BUILDER
FROM ${WEB_BUILDER} AS web

FROM caddy:2.10-alpine
ARG HAPPY_CONFIG_JSON
COPY --from=web /repo/packages/happy-app/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile
RUN test -n "$HAPPY_CONFIG_JSON" \
 && grep -q '<head>' /srv/index.html \
 && sed -i "s|<head>|<head><script>window.__HAPPY_CONFIG__=${HAPPY_CONFIG_JSON};</script>|" /srv/index.html \
 && grep -q '__HAPPY_CONFIG__' /srv/index.html \
 && caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
