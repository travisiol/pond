# The whole game in one container: the ocean's server, which also serves
# the built page. Build from the REPOSITORY ROOT, not from server/:
#
#   docker build -f server/Dockerfile -t pond .
#   docker run -p 8962:8962 -v pond-data:/data -e CHAIN=off -e DEV_FAUCET=true pond
#
# The root is the context because the server imports the shared simulation
# from ../web/src/shared by relative path (one ocean, not two), and because
# the page is built here too so the two can never drift apart.

# ── 1. The page: a static export of web/ ─────────────────────────────────
FROM node:24-alpine AS page
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
# Left empty on purpose: a page with no configured server talks to the
# origin it was served from, which is this very container. Set them only
# when the page is hosted elsewhere and must find the server, or to tell
# the page which Arena contract takes deposits.
ARG NEXT_PUBLIC_GAME_SERVER=
ARG NEXT_PUBLIC_GAME_ARENA=
ARG NEXT_PUBLIC_GAME_URL=
ENV NEXT_PUBLIC_GAME_SERVER=$NEXT_PUBLIC_GAME_SERVER \
    NEXT_PUBLIC_GAME_ARENA=$NEXT_PUBLIC_GAME_ARENA \
    NEXT_PUBLIC_GAME_URL=$NEXT_PUBLIC_GAME_URL
RUN npm run build

# ── 2. The server, with the page next to it ──────────────────────────────
FROM node:24-alpine
WORKDIR /app

# The shared simulation the server runs (rules, sim, bots, protocol, snapshot, names, geometry).
COPY web/src/shared ./web/src/shared
# The page, ready to serve.
COPY --from=page /app/web/out ./web/out

# Server dependencies first, so a code change does not reinstall them.
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund

COPY server/src ./server/src
COPY server/tsconfig.json ./server/

WORKDIR /app/server

# The ledger lives on a volume: mount /data or every restart forgets who is owed what.
ENV NODE_ENV=production \
    PORT=8962 \
    DB_PATH=/data/frenzy.sqlite \
    STATIC_DIR=/app/web/out
VOLUME ["/data"]
EXPOSE 8962

CMD ["npx", "tsx", "src/index.ts"]
