FROM node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532 AS build
RUN npm install --global pnpm@11.8.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile
COPY src ./src
COPY verify ./verify
COPY public ./public
COPY scripts ./scripts
RUN pnpm run build

FROM node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532
WORKDIR /app
# Zero runtime dependencies. No compiler or issuer source in the runtime image.
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY claim-types ./claim-types
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3011
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3011)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/server.js"]
