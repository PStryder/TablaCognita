FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server/ server/
COPY shared/ shared/
COPY editor/ editor/

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server/index.js", "--transport", "http", "--port", "8080"]
