# Za6Zo WebSocket Services

Real-time communication infrastructure for Za6Zo ride-sharing platform, including WebSocket Server and Bridge services.

## Services

This Docker container runs two services:

1. **WebSocket Server** (Port 8080) - Handles real-time WebSocket connections from mobile apps
2. **WebSocket Bridge** (Port 8090) - HTTP API for sending notifications from your backend to WebSocket clients

## Quick Start

### Prerequisites

- Docker installed
- Docker Compose installed
- GitHub account
- Dokploy account

### Local Development

1. Clone the repository:
```bash
git clone https://github.com/yourusername/za6zo.git
cd za6zo/websocket
```

2. Create `.env` file:
```bash
cp .env.example .env
# Edit .env with your configuration
```

3. Start services:
```bash
docker-compose up -d
```

4. View logs:
```bash
docker-compose logs -f
```

5. Stop services:
```bash
docker-compose down
```

## Deployment to Dokploy

### Step 1: Push to GitHub

1. Initialize git (if not already done):
```bash
cd websocket
git init
```

2. Create `.gitignore` file:
```bash
echo "node_modules
.env
npm-debug.log
*.log" > .gitignore
```

3. Commit and push:
```bash
git add .
git commit -m "Add WebSocket services for Dokploy deployment"
git branch -M main
git remote add origin https://github.com/yourusername/za6zo-websocket.git
git push -u origin main
```

### Step 2: Deploy on Dokploy

1. **Log in to Dokploy Dashboard**
   - Go to your Dokploy instance
   - Navigate to Applications

2. **Create New Application**
   - Click "New Application"
   - Choose "Docker Compose"
   - Name: `za6zo-websocket`

3. **Connect GitHub Repository**
   - Select your GitHub repository
   - Branch: `main`
   - Path: `/websocket` (or root if websocket is at root)

4. **Configure Docker Compose**
   - Dokploy will automatically detect `docker-compose.yml`
   - Click on the detected file

5. **Set Environment Variables**
   - Go to Environment Variables section
   - Add the following:

   ```env
   NODE_ENV=production
   WS_PORT=8080
   HTTP_PORT=8090
   API_URL=https://your-api-domain.com
   WEBSOCKET_URL=wss://your-websocket-domain.com
   JWT_SECRET=your-jwt-secret-here
   EXPO_ACCESS_TOKEN=your-expo-token-here
   FCM_SERVER_KEY=your-fcm-key-here
   ```

6. **Configure Domain (Optional)**
   - Add custom domain for WebSocket (e.g., `ws.za6zo.com`)
   - Add custom domain for Bridge (e.g., `ws-api.za6zo.com`)
   - Or use Dokploy's generated domain

7. **Deploy**
   - Click "Deploy"
   - Wait for build and deployment to complete
   - Monitor logs for any issues

### Step 3: Verify Deployment

1. **Check Health**
   ```bash
   curl https://your-websocket-domain.com:8090/health
   ```
   Should return: `{"status":"healthy","service":"websocket-bridge"}`

2. **Test WebSocket Connection**
   - Use a WebSocket client or your mobile app
   - Connect to: `wss://your-websocket-domain.com:8080`

3. **Test Bridge API**
   ```bash
   curl -X POST https://your-websocket-domain.com:8090/notify \
     -H "Content-Type: application/json" \
     -d '{
       "type": "test",
       "payload": {"message": "Hello"}
     }'
   ```

## Architecture

```
┌─────────────────┐
│   Mobile Apps   │
│ (Drivers/Riders)│
└────────┬────────┘
         │ WebSocket
         ↓
┌─────────────────┐
│  WebSocket      │
│  Server         │←──────┐
│  (Port 8080)    │       │
└─────────────────┘       │
                          │ Internal
┌─────────────────┐       │ Connection
│  Next.js API    │       │
│  Backend        │       │
└────────┬────────┘       │
         │ HTTP POST      │
         ↓                │
┌─────────────────┐       │
│  WebSocket      │       │
│  Bridge         │───────┘
│  (Port 8090)    │
└─────────────────┘
```

## API Endpoints

### WebSocket Bridge (Port 8090)

#### Health Check
```
GET /health
Response: {"status":"healthy","service":"websocket-bridge"}
```

#### Send Notification
```
POST /notify
Content-Type: application/json

{
  "type": "bid_accepted",
  "payload": {
    "driverId": "user123",
    "tripId": "trip456",
    "pickupLocation": {...},
    "dropoffLocation": {...}
  }
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NODE_ENV` | Yes | Environment (production/development) |
| `WS_PORT` | No | WebSocket server port (default: 8080) |
| `HTTP_PORT` | No | Bridge HTTP port (default: 8090) |
| `API_URL` | Yes | Your Next.js API URL |
| `WEBSOCKET_URL` | Yes | Public WebSocket URL for clients |
| `JWT_SECRET` | Yes | JWT secret (must match API) |
| `EXPO_ACCESS_TOKEN` | No | Expo push notification token |
| `FCM_SERVER_KEY` | No | Firebase Cloud Messaging key |

## Monitoring

### View Logs
```bash
# Docker Compose
docker-compose logs -f

# Dokploy
# Use Dokploy dashboard logs viewer
```

### Check Container Status
```bash
docker ps | grep za6zo-websocket
```

### Resource Usage
```bash
docker stats za6zo-websocket
```

## Troubleshooting

### Connection Issues

**Problem**: WebSocket clients can't connect

**Solutions**:
1. Check firewall rules (ports 8080, 8090)
2. Verify SSL/TLS certificates for WSS
3. Check `WEBSOCKET_URL` environment variable
4. Review container logs

### Bridge Not Forwarding Messages

**Problem**: HTTP API receives requests but WebSocket clients don't get messages

**Solutions**:
1. Check internal `WEBSOCKET_URL` is correct
2. Verify both services are running: `docker-compose ps`
3. Check WebSocket server logs for connection from bridge
4. Ensure JWT tokens are valid

### High Memory Usage

**Problem**: Container using too much memory

**Solutions**:
1. Review connection management in code
2. Adjust resource limits in docker-compose.yml
3. Monitor active connections
4. Implement connection pooling

## Security

- Never commit `.env` file to git
- Use strong, random `JWT_SECRET` in production
- Keep `EXPO_ACCESS_TOKEN` and `FCM_SERVER_KEY` secret
- Enable HTTPS/WSS in production
- Implement rate limiting (already built-in)
- Regular security updates: `docker-compose pull && docker-compose up -d`

## Scaling

To scale the service on Dokploy:

1. Go to your application in Dokploy
2. Increase replica count
3. Use a load balancer for WebSocket connections
4. Consider using Redis for shared state across instances

## Support

For issues or questions:
- Check logs: `docker-compose logs -f`
- Review health endpoint: `/health`
- Contact Za6Zo development team

## License

Proprietary - Za6Zo Team
