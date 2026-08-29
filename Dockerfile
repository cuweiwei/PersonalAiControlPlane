FROM node:22.19.0-bookworm-slim

WORKDIR /app
COPY package.json ./
COPY package-lock.json ./
RUN npm ci --omit=dev
COPY apps ./apps
COPY packages ./packages
COPY schemas ./schemas
COPY scripts ./scripts

ENV NODE_ENV=production
ENV PAI_PORT=9085
USER node
EXPOSE 9085
CMD ["node", "--experimental-strip-types", "apps/orchestrator/src/index.ts"]
