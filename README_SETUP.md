# Za6Zo WebSocket Service - Setup Guide

**Updated**: November 29, 2025

---

## Quick Start

### Local Development

```bash
cd d:/Za6Zo/websocket

# 1. Install dependencies
npm install

# 2. Use development configuration (already set in .env)
# .env is configured for localhost

# 3. Start the service
npm start

# You should see:
# ✅ WebSocket server running on port 8080
# ✅ HTTP notification server running on port 8090
# ✅ WebSocket connected successfully
```

**Test the service**:
```bash
# In another terminal
curl http://localhost:8090/health

# Expected response:
{
  "status": "ok",
  "timestamp": "2025-11-29T...",
  "uptime": 123,
  "connections": {
    "total": 0,
    "active": 0
  }
}
```

---

## Configuration Files

### `.env` (Local Development) ✅ Current
```env
NODE_ENV=development
API_URL=http://localhost:3000
WEBSOCKET_URL=ws://localhost:8080
WS_PORT=8080
HTTP_PORT=8090
```

### `.env.production` (For Dokploy Deployment)
```env
NODE_ENV=production
API_URL=https://admin.za6zo.cloud
WEBSOCKET_URL=wss://ws.za6zo.cloud
WS_PORT=8080
HTTP_PORT=8090
```

---

## Understanding the Architecture

### Two Components Running Together

1. **WebSocket Server** (port 8080)
   - Real-time connections from drivers/riders
   - Handles live location updates
   - Manages trip notifications
   - Heartbeat monitoring

2. **Bridge Server** (port 8090)
   - HTTP endpoint for admin panel to send notifications
   - Connects to WebSocket server as a client
   - Forwards notifications to connected users
   - Health check endpoint

### How It Works

```
Mobile App (Driver/Rider)
    ↓ WebSocket Connection
    ↓
WebSocket Server :8080
    ↑
    ↑ Internal Connection
    ↑
Bridge Server :8090
    ↑ HTTP POST
    ↑
Admin Panel API (Next.js)
```

---

## Running in Different Modes

### Development Mode (Current)

```bash
# .env is already set for development
npm start

# Connects to:
# - API: http://localhost:3000
# - WebSocket: ws://localhost:8080
```

**Use this when**:
- Testing locally
- Developing new features
- Running admin panel on localhost:3000

### Production Mode (For Deployment)

**Option 1 - Using .env.production file**:
```bash
# Copy production config to .env
cp .env.production .env

# Start service
npm start
```

**Option 2 - Using environment variables** (Dokploy):
```bash
# Set in Dokploy dashboard
NODE_ENV=production
API_URL=https://admin.za6zo.cloud
WEBSOCKET_URL=wss://ws.za6zo.cloud
```

---

## Testing the Service

### 1. Check if Service is Running

```bash
# Health check
curl http://localhost:8090/health

# Stats
curl http://localhost:8090/stats
```

### 2. Test WebSocket Connection

**Using wscat** (install: `npm install -g wscat`):
```bash
wscat -c ws://localhost:8080

# After connection, send:
{"type": "identify", "payload": {"userId": "test-user", "role": "driver"}}

# Expected response:
{"type": "connected", "payload": {"userId": "test-user", ...}}
```

### 3. Send Test Notification

```bash
# Send notification via bridge
curl -X POST http://localhost:8090/notify \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "test-user",
    "type": "test",
    "title": "Test Notification",
    "message": "This is a test"
  }'
```

---

## Common Issues & Solutions

### Issue 1: "WebSocket error: 502"

**Symptom**:
```
[WS-BRIDGE ERROR] ❌ WebSocket error: Unexpected server response: 502
```

**Cause**: Trying to connect to production URL (`wss://ws.za6zo.cloud`) that doesn't exist yet

**Fix**: Use local development configuration
```bash
# Check .env has localhost URLs
cat .env | grep WEBSOCKET_URL
# Should show: WEBSOCKET_URL=ws://localhost:8080

# If shows production URL, update:
# WEBSOCKET_URL=ws://localhost:8080
```

### Issue 2: Port Already in Use

**Symptom**:
```
Error: listen EADDRINUSE: address already in use :::8080
```

**Fix**:
```bash
# Windows - Find and kill process on port 8080
netstat -ano | findstr :8080
taskkill /PID <PID> /F

# Or change port in .env
WS_PORT=8081
HTTP_PORT=8091
```

### Issue 3: Connection Refused

**Symptom**:
```
[WS-BRIDGE ERROR] ❌ WebSocket error: connect ECONNREFUSED
```

**Fix**: Make sure WebSocket server starts before bridge tries to connect
```bash
# The service automatically handles this with retry logic
# Wait a few seconds for reconnection attempts
```

### Issue 4: JWT Authentication Fails

**Symptom**: Clients can't authenticate

**Fix**: Ensure JWT_SECRET matches your admin panel
```bash
# Check admin panel JWT secret
cd ../za6zo_admin
cat .env | grep JWT_SECRET

# Update websocket .env to match
cd ../websocket
# Edit .env and set same JWT_SECRET
```

---

## Development Workflow

### Starting Everything

**Terminal 1 - Admin Panel**:
```bash
cd d:/Za6Zo/za6zo_admin
npm run dev
# Runs on http://localhost:3000
```

**Terminal 2 - WebSocket Service**:
```bash
cd d:/Za6Zo/websocket
npm start
# Runs on ws://localhost:8080 and http://localhost:8090
```

**Terminal 3 - Test Client** (optional):
```bash
wscat -c ws://localhost:8080
```

### Stopping Services

```bash
# Press Ctrl+C in each terminal
# Or close the terminals

# Services will shut down gracefully
```

---

## Deployment to Dokploy

### 1. Prepare for Deployment

```bash
# Use production configuration
cp .env.production .env
```

### 2. Create Dokploy Application

See [PRODUCTION_DEPLOYMENT.md](./PRODUCTION_DEPLOYMENT.md) for full instructions.

**Quick summary**:
1. Create new application: `za6zo-websocket`
2. Set repository and branch
3. Add environment variables from `.env.production`
4. Configure ports: 8080, 8090
5. Set domain: `ws.za6zo.cloud`
6. Enable SSL/TLS
7. Deploy

### 3. Verify Deployment

```bash
# Test health
curl https://ws.za6zo.cloud:8090/health

# Test WebSocket connection
wscat -c wss://ws.za6zo.cloud
```

---

## Environment Variable Reference

| Variable | Development | Production | Description |
|----------|------------|------------|-------------|
| `NODE_ENV` | `development` | `production` | Environment mode |
| `WS_PORT` | `8080` | `8080` | WebSocket server port |
| `HTTP_PORT` | `8090` | `8090` | HTTP bridge port |
| `API_URL` | `http://localhost:3000` | `https://admin.za6zo.cloud` | Admin panel URL |
| `WEBSOCKET_URL` | `ws://localhost:8080` | `wss://ws.za6zo.cloud` | WebSocket public URL |
| `JWT_SECRET` | (same as admin) | (same as admin) | Authentication secret |

---

## Logs & Monitoring

### Understanding Log Output

```
🚀 Starting Za6Zo WebSocket Services...
📍 Environment: development
[WS-SERVER] WebSocket server running on port 8080     ← Main server ready
[WS-BRIDGE] 🟢 WebSocket connected successfully       ← Bridge connected
[WS-SERVER] WebSocket connected: api-server           ← Client connected
[WS-SERVER] 💓 Heartbeat monitor started              ← Health checks active
```

### Log Prefixes

- `[WS-SERVER]` - WebSocket server (port 8080)
- `[WS-BRIDGE]` - Bridge server (port 8090)
- `[WS-SERVER ERROR]` - Server errors
- `[WS-BRIDGE ERROR]` - Bridge errors

---

## Current Status

✅ **Configuration**: Set for local development
✅ **Service**: Starts successfully
✅ **Ports**: 8080 (WebSocket), 8090 (HTTP)
✅ **Connection**: Bridge connects to server successfully
✅ **Ready**: For local development and testing

---

## Next Steps

### For Local Development
1. ✅ Service is running (use `npm start`)
2. Start admin panel on `localhost:3000`
3. Test with mobile apps or wscat
4. Monitor logs for any issues

### For Production Deployment
1. Review [PRODUCTION_DEPLOYMENT.md](./PRODUCTION_DEPLOYMENT.md)
2. Set up DNS for `ws.za6zo.cloud`
3. Deploy to Dokploy with production config
4. Update admin panel to use production WebSocket URL

---

## Support

- **Logs**: Check console output
- **Health**: `curl http://localhost:8090/health`
- **Stats**: `curl http://localhost:8090/stats`
- **Issues**: Check logs prefixed with `ERROR`

**Service is ready for development!** 🚀
