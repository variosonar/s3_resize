FROM node:18-alpine

WORKDIR /usr/src/app

COPY package.json .
COPY yarn.lock .

RUN yarn --silent

COPY src src
COPY .env-sample .env

ENV NODE_PATH=src

EXPOSE 3000
CMD ["node", "--max-old-space-size=512", "src/index.js"]
