# Correct, stable base image for Puppeteer + WhatsApp Web
FROM node:18-bullseye-slim

# Install required system dependencies for Chromium (Puppeteer)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgcc1 \
    libgconf-2-4 \
    libgdk-pixbuf2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
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
    libxss1 \
    libxtst6 \
    ca-certificates \
    fonts-liberation \
    libappindicator1 \
    libnss3 \
    lsb-release \
    xdg-utils \
    wget \
    gnome-keyring && \
    rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package manifests first for caching
COPY package*.json ./

# Install Node dependencies
RUN npm install

# Copy entire project
COPY . .

# Create directories required by the bot
RUN mkdir -p ./sessions ./media ./auth

# Environment variables
ENV NODE_ENV=production
ENV COMMAND_PREFIX=!
ENV MAX_SESSIONS=1000
ENV WHATSAPP_SESSION_DATA_PATH=./sessions

# Expose port if server or webhook uses it
EXPOSE 3000

# DEFAULT START COMMAND
# ⚠ You MUST override this in Render depending on service type
# Worker: node worker.js
# Web service: node server.js
# Bot only: node bot.js
CMD ["node", "bot.js"]
