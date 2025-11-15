FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# Persistência de sessão Baileys
VOLUME ["/app/baileys_auth"]
EXPOSE 3030
CMD ["node", "index.js"]
