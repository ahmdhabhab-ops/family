# syntax=docker/dockerfile:1
FROM node:20-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:4000/healthz || exit 1

CMD ["node", "src/index.js"]
