FROM node:22-bookworm-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2
WORKDIR /app
# No runtime dependencies: signing, storage and verification use Node's own
# WebCrypto and SQLite, so there is no dependency tree to audit or update.
COPY package.json ./
COPY src ./src
COPY verify ./verify
COPY claim-types ./claim-types
COPY public ./public
# A fresh named volume inherits ownership from this path, so the unprivileged
# user can write the signing key and the database.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3011
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3011)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.mjs"]
