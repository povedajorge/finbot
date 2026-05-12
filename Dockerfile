FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p data/images auth_info_baileys
EXPOSE 3000
CMD ["node", "src/server.js"]
