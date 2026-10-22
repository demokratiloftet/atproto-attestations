FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
RUN npm install --global pnpm@11.8.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY vendor ./vendor
RUN pnpm install --frozen-lockfile
COPY src ./src
COPY verify ./verify
COPY public ./public
COPY scripts ./scripts
RUN pnpm run build && pnpm prune --prod
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
WORKDIR /app
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
RUN mkdir /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=3013 PILOT_CONFIG_FILE=/config/pilot.json
EXPOSE 3013
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:3013/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","dist/src/pilot/server.js"]
