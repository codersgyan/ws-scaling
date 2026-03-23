FROM node:20-alpine

# Raise file descriptor limit inside the container
RUN ulimit -n 65535 || true

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

CMD ["node", "load-test.js"]
