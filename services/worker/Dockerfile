FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Worker needs exiftool + qpdf for metadata removal/rewrite
# Debian package that provides `exiftool` is `libimage-exiftool-perl`
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini qpdf libimage-exiftool-perl \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

RUN useradd -m -u 10001 appuser
USER appuser

ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","src/worker.js"]
