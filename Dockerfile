FROM node:20-alpine

RUN apk add --no-cache wget

WORKDIR /app

# install deps separately for better layer caching
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./

ENV NODE_ENV=production
# Force Node DNS resolution to prefer IPv4 so outbound calls to api.taqnyat.sa
# use the VPS public IPv4 (whitelisted at Taqnyat) instead of the VPS IPv6.
ENV NODE_OPTIONS=--dns-result-order=ipv4first
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "server.js"]
