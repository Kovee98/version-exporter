# The build stage always runs on the CI runner's native platform; its output (JS plus pure-JS
# dependencies) is copied unchanged into each target platform's image, so no QEMU emulation is needed.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine

ENV NODE_ENV=production
ENV CONFIG_FILE=/etc/version-exporter/config.json
ENV PORT=9090
WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/src ./dist/src
USER node

EXPOSE 9090
CMD ["node", "dist/src/server.js"]