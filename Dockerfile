# Node.js 26 is the Active LTS release line. The base image is pinned by
# digest, so every build starts from exactly the same bytes; Dependabot opens
# a pull request when a newer image is published.

# ---- Stage 1: build ----------------------------------------------------
# Has dev dependencies (TypeScript, Prisma CLI) needed only to compile.
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS build
WORKDIR /app
# Git hooks are for developers' machines, not for image builds.
ENV HUSKY=0
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- Stage 2: migrate --------------------------------------------------
# A one-off job that applies database migrations, then exits.
# Used by docker compose (service "migrate") and in real deploys
# before the new API version starts. It needs the Prisma CLI, a dev
# dependency, so it keeps the build stage's node_modules. It is published
# too, so it gets the same hardening as the runtime image: the latest
# Alpine security fixes, and no root user.
FROM build AS migrate
RUN apk upgrade --no-cache
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

# ---- Stage 3: production dependencies only -----------------------------
# --omit=optional also drops packages that are only *optional* peers of a
# production dependency. The big one is the Prisma CLI (with Prisma Studio):
# @prisma/client lists it as an optional peer, so --omit=dev alone keeps it.
# The app only needs the generated client at runtime: this takes
# node_modules from about 357 MB to 107 MB.
FROM build AS prod-deps
RUN npm prune --omit=dev --omit=optional

# ---- Stage 4: run ------------------------------------------------------
# Only compiled JS and production dependencies: smaller and safer image.
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Hardening: install the latest Alpine security fixes, then remove npm,
# npx, corepack and yarn. The app never installs anything at runtime, and
# every tool left in the image is one more thing that can have a
# vulnerability. (apk itself stays: only root can use it, and the app never
# runs as root. Deleting its database would also hide the Alpine packages
# from vulnerability scanners like Trivy.)
RUN apk upgrade --no-cache \
  && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
# Never run as root inside the container.
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health/live || exit 1
CMD ["node", "dist/server.js"]
