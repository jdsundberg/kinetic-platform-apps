FROM node:22-alpine

WORKDIR /app

# Zero npm dependencies — pure Node.js built-ins, no build step.
# Just copy the source (node_modules/tests/screenshots/docs are .dockerignore'd).
COPY . .

# Runtime config — override in fly.toml [env] or via `fly secrets`
ENV PORT=3011
ENV KINETIC_URL=https://first.kinetics.com
# Kinetic often uses a self-signed cert; disable outbound TLS verification
ENV NODE_TLS_REJECT_UNAUTHORIZED=0

EXPOSE 3011

CMD ["node", "base/server.mjs"]
