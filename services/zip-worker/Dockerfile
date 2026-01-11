FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

RUN useradd -m -u 10001 appuser
USER appuser

ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","src/worker.js"]
