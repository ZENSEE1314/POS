FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
# pglite is a dev/test engine; production uses Postgres via pg
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production
EXPOSE 3500
CMD ["node", "src/server.ts"]
