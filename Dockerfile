FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build

FROM node:22-alpine

ENV NODE_ENV=production
ENV CONFIG_FILE=/etc/version-exporter/config.json
ENV PORT=9090
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build --chown=node:node /app/dist/src ./dist/src
USER node

EXPOSE 9090
CMD ["node", "dist/src/server.js"]
