FROM node:22-alpine

WORKDIR /app/backend

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

ENV PORT=3000
ENV FRONTEND_DIR=/app/frontend
ENV DB_SQL_DIR=/app/database

EXPOSE 3000

CMD ["node", "src/server.js"]
