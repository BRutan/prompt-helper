FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json vite.config.ts index.html ./
COPY vite.tokenizer.config.mjs ./
COPY src ./src
RUN npm install --no-audit --no-fund && npm run build

FROM caddy:2-alpine
RUN apk add --no-cache nodejs
COPY Caddyfile /etc/caddy/Caddyfile
COPY upload-server.mjs /opt/prompt-helper/upload-server.mjs
COPY --from=build /app/dist /usr/share/caddy
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1/ && wget -q -O /dev/null http://127.0.0.1:8081/upload/health || exit 1

# Caddy serves the SPA and proxies API calls; Node streams uploads to the shared mount.
CMD ["/bin/sh", "-c", "node /opt/prompt-helper/upload-server.mjs & exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile"]
