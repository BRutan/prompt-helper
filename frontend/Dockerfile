FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm install --no-audit --no-fund && npm run build

FROM nginx:1.27-alpine
RUN apk add --no-cache nodejs
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY upload-server.mjs /opt/prompt-helper/upload-server.mjs
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1/ && wget -q -O /dev/null http://127.0.0.1:8081/upload/health || exit 1

# Nginx serves Vite; Node only streams raw uploads into the shared data mount.
CMD ["/bin/sh", "-c", "node /opt/prompt-helper/upload-server.mjs & exec nginx -g 'daemon off;'"]
