# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build
WORKDIR /src

RUN apt-get update \
    && apt-get install --no-install-recommends --yes g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

COPY . .
RUN npm ci
RUN npm run backend:bundle
# The browser app ships in the same image so it and the API share one origin.
RUN TURBO_TELEMETRY_DISABLED=1 npx turbo run build --filter=@pizza-bot/web

FROM node:24-bookworm-slim AS runtime-base

ENV NODE_ENV=production \
    PIZZA_DATA_ROOT=/var/lib/pizza-bot \
    PIZZA_HOST=0.0.0.0 \
    PIZZA_WEB_DIR=/opt/pizza-bot/web \
    PORT=8080

RUN groupadd --gid 10001 pizza-bot \
    && useradd --uid 10001 --gid pizza-bot --home-dir /var/lib/pizza-bot \
      --create-home --no-log-init --shell /usr/sbin/nologin pizza-bot \
    && chmod 0700 /var/lib/pizza-bot

WORKDIR /opt/pizza-bot
COPY --from=build /src/dist/backend/ ./
COPY --from=build /src/apps/web/dist/ ./web/

VOLUME ["/var/lib/pizza-bot"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/ping').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"]

CMD ["node", "start.mjs"]

FROM runtime-base AS runtime-with-browser

RUN apt-get update \
    && apt-get install --no-install-recommends --yes chromium \
    && rm -rf /var/lib/apt/lists/*

USER pizza-bot

FROM runtime-base AS runtime

USER pizza-bot
