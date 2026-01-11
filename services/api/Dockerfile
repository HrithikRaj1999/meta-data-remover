FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# tini = proper SIGTERM handling in Kubernetes
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# run as non-root
RUN useradd -m -u 10001 appuser
USER appuser

EXPOSE 4000
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","src/server.js"]
