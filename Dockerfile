FROM node:22.19.0-bookworm-slim AS web-build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY apps/control-web ./apps/control-web
RUN npm run build:web

FROM node:22.19.0-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY apps ./apps
COPY packages ./packages
COPY schemas ./schemas
COPY scripts ./scripts
COPY --from=web-build /app/dist/control-web ./dist/control-web

ENV NODE_ENV=production
ENV PAI_CONTROL_WEB_PORT=8080
ENV PAI_IDENTITY_PORT=9084
ENV PAI_PORT=9085
USER node
EXPOSE 8080 8081 9084 9085
CMD ["node", "--experimental-strip-types", "apps/control-plane/src/index.ts"]
