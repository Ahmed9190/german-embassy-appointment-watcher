FROM node:23.11.0-alpine3.21

# Puppeteer يحتاج مكتبات معينة في alpine
RUN apk add --no-cache \
  chromium \
  nss \
  freetype \
  harfbuzz \
  ca-certificates \
  ttf-freefont \
  nodejs \
  yarn \
  udev \
  bash

# Set environment variable so Puppeteer skips downloading Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install
COPY . .

CMD ["npm", "start"]
