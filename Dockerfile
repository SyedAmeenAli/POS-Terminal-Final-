FROM node:22-alpine AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /app

# Workspace install: one root lockfile covers both the backend and web/.
FROM base AS dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/
RUN pnpm install --frozen-lockfile

FROM dependencies AS build

# No drizzle.config.ts here — this repo does not own the schema
# (docs/architecture.md constraint 1). Copying it would break the build.
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# Build the till UI into the same image, so one URL serves both API and app
# and there is no cross-origin request to configure.
#
# BUG FOUND 2026-09-16: VITE_API_BASE defaults to "/api"
# (web/src/api/client.ts) — a Vite dev-proxy convention. This is the SAME
# origin/root deployment the comment above describes: routes are mounted at
# "/cashiers", "/orders" etc. with no "/api" prefix at all (see
# src/api/routes/*.routes.ts). Without this set, every fetch the built
# frontend makes goes to a path that does not exist and 404s — the till UI
# loaded, but no catalogue, no cashier list, no shift, no sale could ever
# go through. client.ts's own comment already said to "build with
# VITE_API_BASE=''" for this exact shape; nothing in the build ever did.
ENV VITE_API_BASE=""
COPY web ./web
RUN pnpm --filter pos-terminal-web build

FROM base AS runtime

ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist

# THE ENTRYPOINT THE CMD NAMES MUST EXIST IN THE IMAGE.
#
# Cheap, and it catches the failure that has already cost this project two
# deploys. web/Dockerfile records it: a build that produced a container with no
# working start command failed the Cloud Run startup probe, Cloud Run kept
# traffic on the OLD revision, and the deploy reported failure while the site
# stayed up serving the previous bundle — which is exactly the shape of failure
# nobody notices.
#
# tsc's output layout follows tsconfig, so a rootDir or outDir change moves
# this path without any compiler error. Asserting it here turns a silent bad
# deploy into a failed image build.
RUN test -f dist/src/index.js \
  || (echo "FAIL: dist/src/index.js is missing — the CMD below would start nothing." >&2; \
      echo "      tsc output layout follows tsconfig; check rootDir/outDir." >&2; \
      exit 1)

CMD ["node", "dist/src/index.js"]
