FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY apps/mcp/package.json apps/mcp/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/openclaw-adapter/package.json packages/openclaw-adapter/package.json
COPY packages/mcp-service/package.json packages/mcp-service/package.json
COPY packages/decision-runtime-mcp/package.json packages/decision-runtime-mcp/package.json
COPY apps/mcp apps/mcp
COPY packages/contracts packages/contracts
COPY packages/openclaw-adapter packages/openclaw-adapter
COPY packages/mcp-service packages/mcp-service
COPY packages/decision-runtime-mcp packages/decision-runtime-mcp

RUN npm ci
RUN npx tsc -b --force packages/contracts packages/openclaw-adapter packages/mcp-service packages/decision-runtime-mcp apps/mcp
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV MCP_TRANSPORT=streamable-http
WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/mcp/package.json ./apps/mcp/package.json
COPY --from=build /app/apps/mcp/dist ./apps/mcp/dist
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/openclaw-adapter/package.json ./packages/openclaw-adapter/package.json
COPY --from=build /app/packages/openclaw-adapter/dist ./packages/openclaw-adapter/dist
COPY --from=build /app/packages/mcp-service/package.json ./packages/mcp-service/package.json
COPY --from=build /app/packages/mcp-service/dist ./packages/mcp-service/dist
COPY --from=build /app/packages/decision-runtime-mcp/package.json ./packages/decision-runtime-mcp/package.json
COPY --from=build /app/packages/decision-runtime-mcp/dist ./packages/decision-runtime-mcp/dist

USER node
EXPOSE 3001
CMD ["node", "apps/mcp/dist/server.js"]
