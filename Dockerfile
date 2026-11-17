# ---- Stage 1: build ----------------------------------------------------
# Has dev dependencies (TypeScript, Prisma CLI) needed only to compile.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- Stage 2: run ------------------------------------------------------
# Only compiled JS and production dependencies: smaller and safer image.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
# Never run as root inside the container.
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health/live || exit 1
CMD ["node", "dist/server.js"]
