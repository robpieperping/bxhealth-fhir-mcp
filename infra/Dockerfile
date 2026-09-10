# bxhealth-fhir-mcp image. Build from the repo root:
#   docker build -f infra/Dockerfile -t bxhealth-fhir-mcp .
#
# The image defaults to MCP_TRANSPORT=http because that is the only mode a
# gateway can proxy; stdio remains available by overriding the env var.
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV MCP_TRANSPORT=http
ENV PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
EXPOSE 3000
# Numeric, not "node": Kubernetes verifies runAsNonRoot from the UID and
# cannot resolve a user name inside the image.
USER 1000:1000
CMD ["node", "dist/index.js"]
