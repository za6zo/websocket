# ============================================
# Za6Zo WebSocket Services - Dockerfile
# Runs both WebSocket Server and Bridge
# ============================================

FROM node:18-alpine

LABEL maintainer="Za6Zo Team"
LABEL description="Za6Zo WebSocket Server and Bridge for Real-Time Communications"

# Create app directory
WORKDIR /app

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 websocket

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --only=production && \
    npm cache clean --force

# Copy application files
COPY websocket-server.js ./
COPY websocket-bridge.js ./
COPY start-services.js ./
COPY push-notification.js ./
COPY logger.js ./

# Copy module directories
COPY config/ ./config/
COPY handlers/ ./handlers/
COPY utils/ ./utils/
COPY notifications/ ./notifications/
COPY routes/ ./routes/

# Create directory for push notification service (if needed)
RUN mkdir -p lib/services

# Change ownership to non-root user
RUN chown -R websocket:nodejs /app

# Switch to non-root user
USER websocket

# Expose ports
# 8080 - WebSocket Server
# 8090 - WebSocket Bridge HTTP API
EXPOSE 8080 8090

# Environment variables with defaults
ENV NODE_ENV=production
ENV WS_PORT=8080
ENV HTTP_PORT=8090

# Health check on bridge HTTP endpoint (using wget which is built into alpine)
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8090/health || exit 1

# Start both services
CMD ["node", "start-services.js"]

# ============================================
# Build: docker build -t za6zo-websocket .
# Run: docker run -p 8080:8080 -p 8090:8090 za6zo-websocket
# ============================================
