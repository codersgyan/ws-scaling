FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

EXPOSE 8080

CMD ["node", "--max-old-space-size=512", "index.js"]
