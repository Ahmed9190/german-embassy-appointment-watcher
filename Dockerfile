# Use a Debian-based Node.js image for better compatibility with Puppeteer/Chromium
FROM node:23.11.0-bookworm-slim

# Install necessary dependencies for Puppeteer/Chromium
# These packages are generally required for headless Chromium to run
# Running update in a separate step to ensure package lists are fresh
RUN apt-get update

# Install the required packages
RUN apt-get install -y \
  chromium \
  fonts-liberation \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libatspi2.0-0 \
  libcairo2 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libexpat1 \
  libfontconfig1 \
  libgbm1 \
  libgdk-pixbuf-2.0-0 \
  libglib2.0-0 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libpango-1.0-0 \
  libpangocairo-1.0-0 \
  libstdc++6 \
  libx11-6 \
  libx11-xcb1 \
  libxcb1 \
  libxcomposite1 \
  libxcursor1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxi6 \
  libxrandr2 \
  libxrender1 \
  libxtst6 \
  ca-certificates \
  fonts-wqy-zenhei \
  --no-install-recommends && \
  rm -rf /var/lib/apt/lists/* # Clean up apt lists to reduce image size

# Set environment variable so Puppeteer skips downloading Chromium
# We are using the system-installed Chromium from apt
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install
COPY . .

CMD ["npm", "start"]
