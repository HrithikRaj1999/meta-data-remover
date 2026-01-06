FROM node:20-bookworm-slim

# exiftool + qpdf are required for metadata manipulation and rewrite
RUN apt-get update && apt-get install -y exiftool qpdf && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
CMD ["node","src/worker.js"]
