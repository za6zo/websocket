# Za6Zo WebSocket Service - Production Deployment Guide

**Updated**: November 29, 2025

---

## Production Configuration

### Environment Variables

**Current Production URLs**:
```env
NODE_ENV=production
API_URL=https://admin.za6zo.cloud
WEBSOCKET_URL=wss://ws.za6zo.cloud
WS_PORT=8080
HTTP_PORT=8090
```

### DNS Configuration Required

You need to set up DNS records for:

1. **Admin Panel**: `admin.za6zo.cloud` → Points to Dokploy server
2. **WebSocket Service**: `ws.za6zo.cloud` → Points to Dokploy server

---

## Dokploy Deployment Steps

### 1. Create WebSocket Application in Dokploy

**In Dokploy Dashboard**:

1. Go to **Applications** → **Create New Application**
2. **Name**: `za6zo-websocket`
3. **Type**: Docker Compose or Node.js Application
4. **Repository**: `https://github.com/za6zo/za6zo_admin.git` (or websocket repo)
5. **Branch**: `main`
6. **Build Path**: `websocket/`

### 2. Configure Environment Variables

**In Dokploy Application Settings** → **Environment Variables**:

```env
NODE_ENV=production
WS_PORT=8080
HTTP_PORT=8090
API_URL=https://admin.za6zo.cloud
WEBSOCKET_URL=wss://ws.za6zo.cloud
JWT_SECRET=1037f095063e3c724d78e2aac84320e2be1aed08f31aaf5bae60dab9f80d1e2c0b8d56e87a547f590e64820af818499e565d4dc2834c05e8c54c818a1f8c9bc1
EXPO_ACCESS_TOKEN=
FCM_SERVER_KEY=
```

⚠️ **IMPORTANT**: The `JWT_SECRET` MUST match your admin panel's JWT secret!

### 3. Configure Ports

**Expose Ports**:
- Container Port: `8080` (WebSocket)
- Container Port: `8090` (HTTP Health Check)

**Port Mapping**:
- Host Port: `8080` → Container Port: `8080`
- Host Port: `8090` → Container Port: `8090`

### 4. Set Up Domain/SSL

**Option A - Dokploy Proxy** (Recommended):
1. In Application Settings → **Domains**
2. Add domain: `ws.za6zo.cloud`
3. Enable **SSL/TLS** (Let's Encrypt)
4. Dokploy will automatically configure reverse proxy

**Option B - Manual Nginx**:
```nginx
# WebSocket upstream
upstream websocket_backend {
    server localhost:8080;
}

# HTTPS WebSocket (wss://)
server {
    listen 443 ssl http2;
    server_name ws.za6zo.cloud;

    ssl_certificate /etc/letsencrypt/live/ws.za6zo.cloud/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ws.za6zo.cloud/privkey.pem;

    location / {
        proxy_pass http://websocket_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}

# HTTP to HTTPS redirect
server {
    listen 80;
    server_name ws.za6zo.cloud;
    return 301 https://$server_name$request_uri;
}
```

### 5. Deploy

1. Click **Deploy** in Dokploy
2. Monitor build logs
3. Check deployment status

---

## Verification

### Test WebSocket Connection

```bash
# Test WebSocket endpoint
wscat -c wss://ws.za6zo.cloud

# Expected: Connection established
# Send test message:
{"type": "ping"}

# Expected response:
{"type": "pong"}
```

### Test HTTP Health Check

```bash
# Health check endpoint
curl https://ws.za6zo.cloud:8090/health

# Expected response:
{
  "status": "ok",
  "timestamp": "2025-11-29T...",
  "uptime": 12345,
  "connections": {
    "total": 0,
    "active": 0
  }
}
```

### Test from Admin Panel

```bash
# Test notification service
curl -X POST https://admin.za6zo.cloud/api/notifications/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "userId": 1,
    "type": "test",
    "message": "Test notification"
  }'

# Should trigger WebSocket notification to connected clients
```

---

## Admin Panel Configuration

Update your admin panel `.env` to point to production WebSocket:

**File**: `za6zo_admin/.env.production`

```env
# WebSocket Configuration
NEXT_PUBLIC_WEBSOCKET_URL=wss://ws.za6zo.cloud
WEBSOCKET_NOTIFICATION_URL=https://ws.za6zo.cloud:8090
```

**Or in Dokploy** (for za6zo_admin application):

Add environment variables:
```env
NEXT_PUBLIC_WEBSOCKET_URL=wss://ws.za6zo.cloud
WEBSOCKET_NOTIFICATION_URL=https://ws.za6zo.cloud:8090
```

---

## Docker Compose (Alternative Deployment)

**File**: `websocket/docker-compose.prod.yml`

```yaml
version: '3.8'

services:
  websocket:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: za6zo-websocket
    restart: unless-stopped
    ports:
      - "8080:8080"
      - "8090:8090"
    environment:
      - NODE_ENV=production
      - WS_PORT=8080
      - HTTP_PORT=8090
      - API_URL=https://admin.za6zo.cloud
      - WEBSOCKET_URL=wss://ws.za6zo.cloud
      - JWT_SECRET=${JWT_SECRET}
    networks:
      - za6zo-network
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8090/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

networks:
  za6zo-network:
    external: true
```

**Deploy with**:
```bash
cd websocket
docker-compose -f docker-compose.prod.yml up -d
```

---

## Monitoring

### Check WebSocket Logs

```bash
# Dokploy
# View logs in Dokploy dashboard

# Docker Compose
docker logs -f za6zo-websocket

# Expected logs:
# ✅ WebSocket server listening on port 8080
# ✅ HTTP server listening on port 8090
# ✅ Bridge server initialized
# ✅ Notification service ready
```

### Monitor Connections

```bash
# Check active connections
curl https://ws.za6zo.cloud:8090/stats

# Response:
{
  "connections": {
    "total": 42,
    "drivers": 12,
    "riders": 30
  },
  "uptime": 86400,
  "memory": {
    "used": "45 MB",
    "total": "512 MB"
  }
}
```

---

## Troubleshooting

### WebSocket Connection Fails

**Check**:
1. DNS resolves to correct IP: `nslookup ws.za6zo.cloud`
2. Port 8080 is open: `telnet ws.za6zo.cloud 8080`
3. SSL certificate is valid: `curl -I https://ws.za6zo.cloud`
4. WebSocket upgrade works: Check browser console

**Common Issues**:
- ❌ **Certificate error**: Ensure SSL is configured for `ws.za6zo.cloud`
- ❌ **Connection refused**: Check firewall allows port 8080
- ❌ **502 Bad Gateway**: WebSocket service not running

### JWT Authentication Fails

**Check**:
1. JWT_SECRET matches between admin panel and WebSocket
2. Token format is correct: `Authorization: Bearer <token>`
3. Token not expired

**Fix**:
```bash
# Get JWT_SECRET from admin panel
cd ../za6zo_admin
cat .env | grep JWT_SECRET

# Update WebSocket .env to match
cd ../websocket
# Update JWT_SECRET in .env or Dokploy environment variables
```

### High Memory Usage

**Check**:
```bash
# Monitor memory
docker stats za6zo-websocket

# If high, restart service
docker restart za6zo-websocket
```

**Optimize**:
- Add connection limits in `websocket/server.js`
- Enable connection pooling
- Add rate limiting

---

## Security Checklist

- [ ] SSL/TLS enabled (wss:// not ws://)
- [ ] JWT_SECRET is strong and matches admin panel
- [ ] Firewall configured (only ports 8080, 8090 open)
- [ ] Environment variables not committed to Git
- [ ] Regular security updates applied
- [ ] Rate limiting enabled
- [ ] CORS configured properly
- [ ] Monitoring and alerts set up

---

## Scaling (Future)

### Load Balancing

For high traffic, use multiple WebSocket instances:

```nginx
upstream websocket_cluster {
    ip_hash;  # Sticky sessions for WebSocket
    server websocket1:8080;
    server websocket2:8080;
    server websocket3:8080;
}
```

### Redis for Pub/Sub

Use Redis for message broadcasting across instances:

```javascript
// In websocket/server.js
const redis = require('redis');
const publisher = redis.createClient();
const subscriber = redis.createClient();

// Broadcast to all instances
publisher.publish('notifications', JSON.stringify(message));
```

---

## Current Production Setup

✅ **Admin Panel**: https://admin.za6zo.cloud
✅ **WebSocket Service**: wss://ws.za6zo.cloud
✅ **Environment**: Production
✅ **Ports**: 8080 (WS), 8090 (HTTP)
✅ **JWT Secret**: Configured

**Status**: Ready for deployment 🚀

---

## Support

- **Logs**: Check Dokploy dashboard or `docker logs`
- **Health**: https://ws.za6zo.cloud:8090/health
- **Stats**: https://ws.za6zo.cloud:8090/stats
