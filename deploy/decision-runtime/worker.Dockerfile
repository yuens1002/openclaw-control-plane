FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/runtime-auth/package.json packages/runtime-auth/package.json
COPY packages/db/package.json packages/db/package.json
COPY apps/worker apps/worker
COPY packages/contracts packages/contracts
COPY packages/runtime-auth packages/runtime-auth
COPY packages/db packages/db

RUN npm ci
RUN npx tsc -b --force packages/contracts packages/runtime-auth packages/db apps/worker
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/runtime-auth/package.json ./packages/runtime-auth/package.json
COPY --from=build /app/packages/runtime-auth/dist ./packages/runtime-auth/dist
COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/migrations ./packages/db/migrations

USER node
EXPOSE 8788
CMD ["node", "apps/worker/dist/index.js"]
