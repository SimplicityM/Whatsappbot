# =====================================================
#        TAGTHEMALL PRODUCTION DOCKERFILE
# =====================================================

FROM node:22-alpine

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Set working directory
WORKDIR /app

# Install minimal runtime dependencies
RUN apk add --no-cache \
    dumb-init \
    tzdata \
    ca-certificates

# Copy dependency files first (better caching)
COPY package*.json ./

# Install production dependencies only
RUN npm install --omit=dev

# Copy application code
COPY . .

# Create required directories
RUN mkdir -p ./media ./logs && \
    chown -R appuser:appgroup /app

# Set environment
ENV NODE_ENV=production

# Switch to non-root user (security best practice)
USER appuser

# Expose worker port
EXPOSE 3000

# Proper signal handling
ENTRYPOINT ["dumb-init", "--"]

CMD ["node", "worker/worker.js"]