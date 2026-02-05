# Stage 1: Install dependencies and build
FROM node:20-slim AS builder
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Copy workspace config first for better layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/server/package.json packages/server/tsconfig.json ./packages/server/

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/shared/src ./packages/shared/src
COPY packages/server/src ./packages/server/src

# Build (shared first, then server — Turborepo handles ordering)
RUN pnpm run build --filter=@buildq/server...

# Stage 2: Production image
FROM node:20-slim
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Create non-root user
RUN groupadd -r buildq && useradd -r -g buildq -m buildq

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy compiled output
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/server/dist ./packages/server/dist

# Create data directory with correct ownership
RUN mkdir -p /data && chown buildq:buildq /data
VOLUME /data

# Switch to non-root user
USER buildq

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

ENV NODE_ENV=production
ENV STORAGE_DIR=/data
ENV PORT=3000

CMD ["node", "packages/server/dist/index.js"]
