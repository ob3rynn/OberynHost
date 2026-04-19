FROM node:20-bookworm AS build-base

WORKDIR /opt/storefront/backend

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash python3 make g++ ca-certificates curl gnupg procps \
    && rm -rf /var/lib/apt/lists/*

COPY backend/package.json backend/package-lock.json ./

FROM build-base AS prod-deps
RUN npm ci --omit=dev --build-from-source

FROM build-base AS dev-deps
RUN npm ci --build-from-source

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/var/lib/oberynhost/storefront/storefront.sqlite3

WORKDIR /app

COPY --from=prod-deps /opt/storefront/backend/node_modules ./backend/node_modules
COPY backend ./backend
COPY frontend ./frontend

RUN mkdir -p /var/lib/oberynhost/storefront

WORKDIR /app/backend

EXPOSE 3000

CMD ["node", "server.js"]

FROM node:20-bookworm AS devtools

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    STOREFRONT_WORKSPACE=/workspace/apps/storefront \
    NODE_ENV=development

WORKDIR /opt/storefront/backend

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash python3 make g++ ca-certificates curl gnupg procps \
    && mkdir -p /usr/share/keyrings \
    && curl -fsSL https://packages.stripe.dev/api/security/keypair/stripe-cli-gpg/public \
        | gpg --dearmor -o /usr/share/keyrings/stripe.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/stripe.gpg] https://packages.stripe.dev/stripe-cli-debian-local stable main" \
        > /etc/apt/sources.list.d/stripe.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends stripe \
    && rm -rf /var/lib/apt/lists/*

COPY --from=dev-deps /opt/storefront/backend/node_modules ./node_modules
COPY backend/package.json backend/package-lock.json ./
COPY docker/devtools-entrypoint.sh /usr/local/bin/storefront-dev-entrypoint

RUN chmod +x /usr/local/bin/storefront-dev-entrypoint \
    && npx playwright install --with-deps chromium

WORKDIR /workspace/apps/storefront/backend

ENTRYPOINT ["storefront-dev-entrypoint"]
CMD ["npm", "run", "dev:server"]
