FROM oven/bun:1.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.4
WORKDIR /app
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=8080 TRUST_PROXY=1
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json tsconfig*.json ./
COPY server ./server
COPY shared ./shared
COPY src ./src
EXPOSE 8080
CMD ["bun", "server/index.ts"]
