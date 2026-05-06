# Example image only. The service assumes gsd is available in the same runtime.
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* tsconfig.json ./
RUN npm install

COPY src ./src
COPY README.md .
COPY .env.example .
COPY .dockerignore .

RUN npm run build \
  && npm prune --omit=dev

CMD ["node", "dist/index.js"]
