FROM node:20-slim

WORKDIR /app

# Instala dependencias primero (mejor cache de capas)
COPY package*.json ./
RUN npm ci --omit=dev

# Copia el resto del código
COPY . .

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "app.js"]
