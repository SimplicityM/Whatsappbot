# =====================================================
#        TAGTHEMALL PRODUCTION DOCKERFILE
# =====================================================

FROM node:18-bullseye-slim

# Set working directory
WORKDIR /app

# Install only minimal required system packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    tzdata \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency files first (better layer caching)
COPY package*.json ./

# Install production dependencies only
RUN npm install --omit=dev

# Copy application code
COPY . .

# Create required directories
RUN mkdir -p ./media ./logs

# Set environment
ENV NODE_ENV=production

# Expose worker port
EXPOSE 3000

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

CMD ["node", "worker.js"]