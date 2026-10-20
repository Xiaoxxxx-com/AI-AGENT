# 构建阶段只装生产依赖，镜像更小
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json ./
RUN pnpm install --prod --config.confirmModulesPurge=false

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json tsconfig.json ./
RUN pnpm install
COPY src ./src
RUN pnpm run build && pnpm prune --prod

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
