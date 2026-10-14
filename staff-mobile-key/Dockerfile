# One image for the platform services (simulator, backend + portal, connector). Development and pilot use.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=development
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/backend/package.json apps/backend/
COPY apps/simulator/package.json apps/simulator/
COPY apps/connector/package.json apps/connector/
COPY apps/portal/package.json apps/portal/
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY apps/backend apps/backend
COPY apps/simulator apps/simulator
COPY apps/connector apps/connector
COPY apps/portal apps/portal
COPY scripts scripts
COPY brand brand
COPY VERSION ./
RUN npm run build -w apps/portal
EXPOSE 4000 8443 8444 8090
CMD ["node", "--version"]
