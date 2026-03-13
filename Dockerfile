# Stage 1: build
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

RUN npm ci --omit=dev

# Stage 2: runtime
FROM node:22-alpine

RUN apk add --no-cache dumb-init

RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

RUN mkdir -p /app/data && chown -R app:app /app/data

USER app

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD pgrep -f "node dist/index.js" > /dev/null || exit 1

LABEL org.opencontainers.image.title="csvtaggingai"
LABEL org.opencontainers.image.description="VMware to Vision One tag synchronization"
LABEL org.opencontainers.image.source="https://github.com/trendmicro/csvtaggingai"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
