# One image, three roles (api / worker / mock-whatsapp) chosen by the container command.
FROM node:24-bookworm-slim

# Prisma's query engine needs OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first so this layer is cached when only source changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY test ./test
RUN npm run build

# Certificate PDFs live on a shared volume; run as the unprivileged node user.
RUN mkdir -p /data/certificates /tmp/certificates \
  && chown -R node:node /data/certificates /tmp/certificates /app
USER node

EXPOSE 3000 4000
CMD ["node", "dist/server.js"]
