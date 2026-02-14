/**
 * WebSocket Server - Main Entry Point
 * Modular WebSocket server for real-time ride-sharing communication
 *
 * Modules:
 * - config/constants.js - Configuration and constants
 * - utils/connectionManager.js - Connection tracking
 * - utils/rateLimiter.js - Rate limiting
 * - utils/locationUtils.js - Distance/ETA calculations
 * - handlers/tripHandler.js - Trip management
 * - handlers/biddingHandler.js - Bidding system
 * - handlers/liveModeHandler.js - Live mode and shared rides
 * - notifications/index.js - All notification functions
 * - routes/httpRoutes.js - HTTP endpoints
 */

require('dotenv').config();

const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');

// Import modules
const config = require('./config/constants');
const rateLimiter = require('./utils/rateLimiter');
const tripHandler = require('./handlers/tripHandler');
const biddingHandler = require('./handlers/biddingHandler');
const liveModeHandler = require('./handlers/liveModeHandler');
const notifications = require('./notifications');
const httpRoutes = require('./routes/httpRoutes');

// Try to load optional modules
let pushNotificationService = null;
let fcmNotificationService = null;
let logger = console;

try {
  pushNotificationService = require('./push-notification');
} catch (e) {
  console.warn('Push notification service not available');
}

try {
  fcmNotificationService = require('./fcm-notification');
  if (fcmNotificationService.isAvailable()) {
    console.log('✅ FCM notification service loaded');
  } else {
    console.warn('⚠️ FCM service loaded but not initialized - check Firebase credentials');
  }
} catch (e) {
  console.warn('FCM notification service not available:', e.message);
}

try {
  logger = require('./logger');
} catch (e) {
  // Use console as fallback
}

// Validate production configuration
config.validateProductionConfig(logger);

// ==================== CONNECTION STATE ====================

// WebSocket connection management
const connections = new Map(); // userId -> { ws, connectionId, role, tripId, location, lastHeartbeat, driverId, riderId }
const userConnections = new Map(); // userId -> Set of connectionIds
const tripConnections = new Map(); // tripId -> Set of userIds
const driverIdToUserId = new Map(); // driverId -> userId mapping
const riderIdToUserId = new Map(); // riderId -> userId mapping
let connectionIdCounter = 0;

// ==================== UTILITY FUNCTIONS ====================

/**
 * Generate unique connection ID
 */
function generateConnectionId() {
  return `conn_${++connectionIdCounter}_${Date.now()}`;
}

/**
 * Check if user has reached connection limit
 */
function checkUserConnectionLimit(userId) {
  if (userId === 'api-server') return true;
  const userConns = userConnections.get(userId);
  return !userConns || userConns.size < config.RATE_LIMITS.MAX_CONNECTIONS_PER_USER;
}

/**
 * Check if server has reached total connection limit
 */
function checkTotalConnectionLimit() {
  return connections.size < config.RATE_LIMITS.MAX_TOTAL_CONNECTIONS;
}

/**
 * Track connection for user
 */
function trackUserConnection(userId, connectionId) {
  if (!userConnections.has(userId)) {
    userConnections.set(userId, new Set());
  }
  userConnections.get(userId).add(connectionId);
}

/**
 * Untrack connection for user
 */
function untrackUserConnection(userId, connectionId) {
  const userConns = userConnections.get(userId);
  if (userConns) {
    userConns.delete(connectionId);
    if (userConns.size === 0) {
      userConnections.delete(userId);
    }
  }
}

/**
 * Get connection statistics
 */
function getConnectionStats() {
  let totalUserConnections = 0;
  let maxConnectionsPerUser = 0;
  let usersWithMultipleConnections = 0;

  for (const [userId, conns] of userConnections.entries()) {
    totalUserConnections += conns.size;
    if (conns.size > maxConnectionsPerUser) maxConnectionsPerUser = conns.size;
    if (conns.size > 1) usersWithMultipleConnections++;
  }

  return {
    totalConnections: connections.size,
    uniqueUsers: userConnections.size,
    totalUserConnections,
    maxConnectionsPerUser,
    usersWithMultipleConnections,
    tripConnectionGroups: tripConnections.size,
    driverMappings: driverIdToUserId.size,
    riderMappings: riderIdToUserId.size,
  };
}

/**
 * Send message to specific user with push notification fallback
 */
async function sendToUser(userId, message) {
  let connectionKey = userId;
  let userConn = connections.get(connectionKey);

  // Try mappings if not found directly
  if (!userConn || !userConn.ws || userConn.ws.readyState !== WebSocket.OPEN) {
    let mappedUserId = riderIdToUserId.get(userId);
    if (!mappedUserId && typeof userId === 'number') {
      mappedUserId = riderIdToUserId.get(String(userId));
    } else if (!mappedUserId && typeof userId === 'string') {
      mappedUserId = riderIdToUserId.get(parseInt(userId, 10));
    }

    if (mappedUserId) {
      connectionKey = mappedUserId;
      userConn = connections.get(connectionKey);
    }

    // Try driver mapping
    if (!userConn || !userConn.ws || userConn.ws.readyState !== WebSocket.OPEN) {
      let driverMappedUserId = driverIdToUserId.get(userId);
      if (!driverMappedUserId && typeof userId === 'number') {
        driverMappedUserId = driverIdToUserId.get(String(userId));
      } else if (!driverMappedUserId && typeof userId === 'string') {
        driverMappedUserId = driverIdToUserId.get(parseInt(userId, 10));
      }

      if (driverMappedUserId) {
        connectionKey = driverMappedUserId;
        userConn = connections.get(connectionKey);
      }
    }
  }

  if (userConn && userConn.ws && userConn.ws.readyState === WebSocket.OPEN) {
    try {
      userConn.ws.send(JSON.stringify(message));
      console.log(`Message sent to user ${userId}:`, message.type);
      return true;
    } catch (error) {
      console.error(`Failed to send message to user ${userId}:`, error.message);
      return false;
    }
  } else {
    console.warn(`User ${userId} not connected or WebSocket not ready`);
    // Fallback to push notification
    await sendPushNotificationFallback(userId, message);
    return false;
  }
}

/**
 * Send push notification when WebSocket is unavailable
 * Supports both Expo Push Tokens and FCM Tokens
 */
async function sendPushNotificationFallback(userId, message) {
  const { type, payload } = message;

  // Try FCM first (native Firebase)
  if (fcmNotificationService && fcmNotificationService.isAvailable()) {
    try {
      // Try to get FCM token
      const fcmResponse = await fetch(`${config.API_URL}/api/users/${userId}/fcm-token`);
      if (fcmResponse.ok) {
        const { fcmToken } = await fcmResponse.json();
        if (fcmToken) {
          const fcmResult = await sendFcmNotification(fcmToken, type, payload);
          if (fcmResult.success) {
            console.log(`[FCM] Sent notification (${type}) to ${userId}`);
            return; // FCM succeeded, no need for Expo
          }
        }
      }
    } catch (error) {
      console.warn(`[FCM] Failed for ${userId}, falling back to Expo:`, error.message);
    }
  }

  // Fallback to Expo Push
  if (!pushNotificationService) return;

  try {
    const response = await fetch(`${config.API_URL}/api/users/${userId}/push-token`);
    if (!response.ok) return;

    const { expoPushToken } = await response.json();
    if (!expoPushToken) return;

    // Map message types to push notification methods
    const notificationMap = {
      'new_trip_request': () => pushNotificationService.notifyNewTripRequest(expoPushToken, payload),
      'bid_accepted': () => pushNotificationService.notifyBidAccepted(expoPushToken, payload),
      'driver_arrived': () => pushNotificationService.notifyDriverArrived(expoPushToken, payload),
      'trip_started': () => pushNotificationService.notifyTripStarted(expoPushToken, payload),
      'tripStarted': () => pushNotificationService.notifyTripStarted(expoPushToken, payload),
      'trip_completed': () => pushNotificationService.notifyTripCompleted(expoPushToken, payload),
      'trip_cancelled': () => pushNotificationService.notifyTripCancelled(expoPushToken, payload),
      'new_bid': () => pushNotificationService.notifyNewBid(expoPushToken, payload),
      'driver_accepted_request': () => pushNotificationService.notifySharedRideAccepted(expoPushToken, payload),
      'shared_ride_accepted': () => pushNotificationService.notifySharedRideAccepted(expoPushToken, payload),
      'driver_rejected_request': () => pushNotificationService.notifySharedRideRejected(expoPushToken, payload),
      'route_cancelled': () => pushNotificationService.notifyRouteCancelled(expoPushToken, payload),
      'city_trip_request': () => pushNotificationService.notifyCityTripRequest(expoPushToken, payload),
      'city_trip_accepted': () => pushNotificationService.notifyCityTripAccepted(expoPushToken, payload),
      'subscription_request': () => pushNotificationService.notifySubscriptionRequest(expoPushToken, payload),
      'subscription_status': () => pushNotificationService.notifySubscriptionStatus(expoPushToken, payload),
      'driver_verified': () => pushNotificationService.notifyDriverVerified(expoPushToken, payload),
    };

    if (notificationMap[type]) {
      await notificationMap[type]();
      console.log(`[Expo] Sent push notification (${type}) to ${userId}`);
    } else {
      await pushNotificationService.sendToUser(expoPushToken, 'Za6Zo Notification', `New ${type} notification`, { type, ...payload });
      console.log(`[Expo] Sent generic push notification (${type}) to ${userId}`);
    }
  } catch (error) {
    console.error(`Failed to send push notification to ${userId}:`, error.message);
  }
}

/**
 * Send FCM notification based on message type
 */
async function sendFcmNotification(fcmToken, type, payload) {
  if (!fcmNotificationService) return { success: false };

  const fcmMap = {
    'new_trip_request': () => fcmNotificationService.notifyNewTripRequest(fcmToken, payload),
    'bid_accepted': () => fcmNotificationService.notifyBidAccepted(fcmToken, payload),
    'driver_arrived': () => fcmNotificationService.notifyDriverArrived(fcmToken, payload),
    'trip_started': () => fcmNotificationService.notifyTripStarted(fcmToken, payload),
    'tripStarted': () => fcmNotificationService.notifyTripStarted(fcmToken, payload),
    'trip_completed': () => fcmNotificationService.notifyTripCompleted(fcmToken, payload),
    'trip_cancelled': () => fcmNotificationService.notifyTripCancelled(fcmToken, payload),
    'new_bid': () => fcmNotificationService.notifyNewBid(fcmToken, payload),
    'driver_accepted_request': () => fcmNotificationService.notifySharedRideAccepted(fcmToken, payload),
    'shared_ride_accepted': () => fcmNotificationService.notifySharedRideAccepted(fcmToken, payload),
    'driver_rejected_request': () => fcmNotificationService.notifySharedRideRejected(fcmToken, payload),
    'city_trip_request': () => fcmNotificationService.notifyCityTripRequest(fcmToken, payload),
    'city_trip_accepted': () => fcmNotificationService.notifyCityTripAccepted(fcmToken, payload),
    'subscription_request': () => fcmNotificationService.notifySubscriptionRequest(fcmToken, payload),
    'subscription_status': () => fcmNotificationService.notifySubscriptionStatus(fcmToken, payload),
    'driver_verified': () => fcmNotificationService.notifyDriverVerified(fcmToken, payload),
  };

  if (fcmMap[type]) {
    return await fcmMap[type]();
  }

  // Generic FCM notification
  return await fcmNotificationService.sendToDevice(
    fcmToken,
    'Za6Zo Notification',
    `New ${type} notification`,
    { type, ...payload }
  );
}

/**
 * Update driver's lastActiveAt via heartbeat
 */
async function updateDriverHeartbeat(driverId) {
  try {
    await fetch(`${config.API_URL}/api/driver/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ driverId })
    });
  } catch (error) {
    // Silently fail
  }
}

// ==================== INITIALIZE MODULES ====================

const sharedDeps = {
  connections,
  tripConnections,
  sendToUser,
  driverIdToUserId,
  riderIdToUserId,
  joinTrip: (...args) => tripHandler.joinTrip(...args),
  liveTrackingSessions: liveModeHandler.liveTrackingSessions,
};

// Initialize handlers
tripHandler.init(sharedDeps);
biddingHandler.init(sharedDeps);
liveModeHandler.init(sharedDeps);
notifications.init(sharedDeps);

// Initialize HTTP routes
httpRoutes.init({
  getConnectionStats,
  getRateLimitStats: rateLimiter.getRateLimitStats,
  handlers: {
    // Trip handlers
    notifyTripStarted: tripHandler.notifyTripStarted,
    notifyTripCompleted: tripHandler.notifyTripCompleted,
    notifyTripCancelled: tripHandler.notifyTripCancelled,
    notifyDriverArrived: tripHandler.notifyDriverArrived,
    notifyPassengerReady: tripHandler.notifyPassengerReady,
    broadcastDriverLocationUpdate: tripHandler.broadcastDriverLocationUpdate,
    // Bidding handlers
    broadcastToDrivers: biddingHandler.broadcastToDrivers,
    notifyRiderAboutBid: biddingHandler.notifyRiderAboutBid,
    notifyDriverBidAccepted: biddingHandler.notifyDriverBidAccepted,
    notifyDriverBidRejected: biddingHandler.notifyDriverBidRejected,
    // Live mode handlers
    startLiveTracking: liveModeHandler.startLiveTracking,
    // Notifications
    notifyDriverAboutPassengerRequest: notifications.notifyDriverAboutPassengerRequest,
    notifyDriverAboutRequestCancellation: notifications.notifyDriverAboutRequestCancellation,
    notifyPassengerAboutAcceptance: notifications.notifyPassengerAboutAcceptance,
    notifyPassengerAboutRejection: notifications.notifyPassengerAboutRejection,
    notifyPassengerAboutRouteCancellation: notifications.notifyPassengerAboutRouteCancellation,
    notifyDriverAboutSubscriptionRequest: notifications.notifyDriverAboutSubscriptionRequest,
    notifyPassengerAboutSubscriptionStatus: notifications.notifyPassengerAboutSubscriptionStatus,
    notifySubscriptionConfirmed: notifications.notifySubscriptionConfirmed,
    notifySubscriptionTrip: notifications.notifySubscriptionTrip,
    notifyCityTripRequest: notifications.notifyCityTripRequest,
    notifyCityTripDirectRequest: notifications.notifyCityTripDirectRequest,
    notifyCityTripAccepted: notifications.notifyCityTripAccepted,
    notifyCityTripRejected: notifications.notifyCityTripRejected,
    notifyCityTripCounterOffer: notifications.notifyCityTripCounterOffer,
    notifyCityTripPriceAgreed: notifications.notifyCityTripPriceAgreed,
    notifyCityTripStarted: notifications.notifyCityTripStarted,
    notifyCityTripCompleted: notifications.notifyCityTripCompleted,
    notifyCityTripUpdate: notifications.notifyCityTripUpdate,
    notifyDriverVerified: notifications.notifyDriverVerified,
  }
});

// ==================== MESSAGE HANDLER ====================

/**
 * Handle incoming WebSocket messages
 */
function handleMessage(userId, data) {
  const { type, payload } = data;
  const userConn = connections.get(userId);

  if (!userConn) return;

  // Handle ping/pong (heartbeat)
  if (type === 'ping' || type === 'heartbeat') {
    userConn.lastHeartbeat = Date.now();
    if (userConn.ws) {
      userConn.ws.send(JSON.stringify({ type: 'pong', payload: {} }));
    }
    if (userConn.role === 'driver' && userConn.driverId) {
      updateDriverHeartbeat(userConn.driverId);
    }
    return;
  }

  console.log(`Message from ${userId}:`, JSON.stringify(data));

  // Special handling for API server messages
  if (userConn.role === 'api-server') {
    handleApiServerMessage(type, payload);
    return;
  }

  switch (type) {
    case 'identify':
      handleIdentify(userId, userConn, payload);
      break;

    case 'new_trip_request':
      biddingHandler.broadcastToDrivers(payload);
      break;

    case 'trip_accepted':
      biddingHandler.notifyRiderTripAccepted(payload);
      break;

    case 'track_trip':
      tripHandler.joinTrip(userId, payload.tripId);
      break;

    case 'stop_tracking_trip':
      tripHandler.leaveTrip(userId, payload.tripId);
      break;

    case 'user_location':
    case 'driver_location':
      liveModeHandler.broadcastLiveLocation(userId, payload);
      break;

    case 'start_live_tracking':
      liveModeHandler.startLiveTracking(userId, payload);
      break;

    case 'stop_live_tracking':
      liveModeHandler.stopLiveTracking(userId, payload);
      break;

    case 'trip_started':
    case 'tripStarted':
      tripHandler.notifyTripStarted(userId, payload);
      break;

    case 'trip_completed':
      tripHandler.notifyTripCompleted(userId, payload);
      break;

    case 'driver_arrived':
    case 'driverArrived':
      tripHandler.notifyDriverArrived(userId, payload);
      break;

    case 'passenger_ready':
      const passengerConn = connections.get(userId);
      const actualRiderId = passengerConn?.riderId || payload.riderId || userId;
      tripHandler.notifyPassengerReady(actualRiderId, { ...payload, driverId: payload.driverId, tripId: payload.tripId });
      break;

    case 'passenger_seated':
      tripHandler.notifyPassengerSeated(userId, payload);
      break;

    case 'request_passenger_confirmation':
      tripHandler.requestPassengerConfirmation(userId, payload);
      break;

    case 'rider_location_update':
      tripHandler.broadcastRiderLocation(userId, payload);
      break;

    case 'driver_accepted_request':
      notifications.notifyPassengerAboutAcceptance(payload);
      break;

    case 'driver_rejected_request':
      notifications.notifyPassengerAboutRejection(payload);
      break;

    case 'place_bid':
      biddingHandler.handleDriverBid(userId, payload);
      break;

    case 'accept_bid':
      biddingHandler.handleBidAcceptance(userId, payload);
      break;

    case 'reject_bid':
      biddingHandler.handleBidRejection(userId, payload);
      break;

    case 'passenger_location_update':
      liveModeHandler.handlePassengerLocationUpdate(userId, payload);
      break;

    case 'driver_route_location':
      liveModeHandler.handleDriverRouteLocationUpdate(userId, payload);
      break;

    case 'enable_live_mode':
      liveModeHandler.handleEnableLiveMode(userId, payload);
      break;

    case 'disable_live_mode':
      liveModeHandler.handleDisableLiveMode(userId);
      break;

    case 'view_route':
      liveModeHandler.handleViewRoute(userId, payload);
      break;

    case 'stop_view_route':
      liveModeHandler.handleStopViewRoute(userId);
      break;

    case 'trip_cancelled':
      tripHandler.notifyTripCancelled(payload);
      break;

    case 'subscription_status':
      notifications.notifyPassengerAboutSubscriptionStatus(payload);
      break;

    default:
      console.log('Unknown message type:', type);
  }
}

/**
 * Handle API server messages
 */
function handleApiServerMessage(type, payload) {
  console.log('Processing API server notification:', type);

  switch (type) {
    case 'new_trip_request':
      biddingHandler.broadcastToDrivers(payload);
      break;
    case 'trip_accepted':
      biddingHandler.notifyRiderTripAccepted(payload);
      break;
    case 'trip_started':
      tripHandler.notifyTripStarted(null, payload);
      break;
    case 'trip_completed':
      tripHandler.notifyTripCompleted(null, payload);
      break;
    case 'driver_arrived':
      tripHandler.notifyDriverArrived(null, payload);
      break;
    case 'trip_cancelled':
      tripHandler.notifyTripCancelled(payload);
      break;
    case 'new_bid':
      biddingHandler.notifyRiderAboutBid(payload);
      break;
    case 'bid_accepted':
      biddingHandler.notifyDriverBidAccepted(payload);
      break;
    case 'bid_rejected':
      biddingHandler.notifyDriverBidRejected(payload);
      break;
    case 'passenger_ride_request':
      notifications.notifyDriverAboutPassengerRequest(payload);
      break;
    case 'passenger_request_cancelled':
      notifications.notifyDriverAboutRequestCancellation(payload);
      break;
    case 'driver_accepted_request':
      notifications.notifyPassengerAboutAcceptance(payload);
      break;
    case 'driver_rejected_request':
    case 'passenger_request_rejected':
      notifications.notifyPassengerAboutRejection(payload);
      break;
    case 'subscription_request':
      notifications.notifyDriverAboutSubscriptionRequest(payload);
      break;
  }
}

/**
 * Handle identify message
 */
function handleIdentify(userId, userConn, payload) {
  userConn.role = payload.role;
  console.log(`User ${userId} identified as ${payload.role}`);

  if (payload.tripId) {
    userConn.tripId = payload.tripId;
  }

  // Store driver ID mapping
  if (payload.role === 'driver' && payload.driverId) {
    userConn.driverId = payload.driverId;
    const driverId = payload.driverId;

    driverIdToUserId.set(driverId, userId);
    driverIdToUserId.set(String(driverId), userId);
    const driverIdInt = parseInt(String(driverId), 10);
    if (!isNaN(driverIdInt)) driverIdToUserId.set(driverIdInt, userId);
    driverIdToUserId.set(userId, userId);

    if (payload.userId && payload.userId !== userId) {
      driverIdToUserId.set(payload.userId, userId);
      driverIdToUserId.set(String(payload.userId), userId);
    }

    console.log(`Driver mapping created: ${payload.driverId} → ${userId}`);
  }

  // Store rider ID mapping
  if (payload.role === 'rider') {
    const riderId = payload.riderId || userId;
    userConn.riderId = riderId;

    riderIdToUserId.set(riderId, userId);
    riderIdToUserId.set(String(riderId), userId);
    const riderIdInt = parseInt(String(riderId), 10);
    if (!isNaN(riderIdInt)) riderIdToUserId.set(riderIdInt, userId);
    riderIdToUserId.set(userId, userId);

    if (payload.userId && payload.userId !== riderId) {
      riderIdToUserId.set(payload.userId, userId);
      riderIdToUserId.set(String(payload.userId), userId);
    }

    console.log(`Rider mapping created: ${riderId} → ${userId}`);
  }
}

// ==================== HEARTBEAT MONITOR ====================

/**
 * Check all connections and close stale ones
 */
function heartbeatMonitor() {
  const now = Date.now();
  let closedCount = 0;

  connections.forEach((conn, userId) => {
    if (!conn.lastHeartbeat) {
      conn.lastHeartbeat = now;
      return;
    }

    const timeSinceLastHeartbeat = now - conn.lastHeartbeat;
    if (timeSinceLastHeartbeat > config.CONNECTION_TIMEOUT) {
      console.log(`Heartbeat timeout for user ${userId}`);
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.close(1000, 'Heartbeat timeout');
        closedCount++;
      }
    } else {
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        try { conn.ws.ping(); } catch (error) {}
      }
    }
  });

  if (closedCount > 0) {
    console.log(`Heartbeat: Closed ${closedCount} stale connection(s)`);
  }
}

// ==================== SERVER SETUP ====================

// Create Express app
const app = express();
app.use(express.json());

// CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, ngrok-skip-browser-warning');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Setup HTTP routes
httpRoutes.setupRoutes(app);

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server, perMessageDeflate: false });

// Start server
server.listen(config.WS_PORT, () => {
  console.log(`Combined HTTP + WebSocket server running on port ${config.WS_PORT}`);
  console.log(`   - WebSocket: ws://localhost:${config.WS_PORT}`);
  console.log(`   - HTTP /notify: http://localhost:${config.WS_PORT}/notify`);
});

// Start heartbeat monitor
const heartbeatInterval = setInterval(heartbeatMonitor, config.HEARTBEAT_INTERVAL);
console.log(`Heartbeat monitor started (checking every ${config.HEARTBEAT_INTERVAL/1000}s, timeout: ${config.CONNECTION_TIMEOUT/1000}s)`);

// Start rate limit cleanup
rateLimiter.startCleanupInterval();

// ==================== WEBSOCKET CONNECTION HANDLER ====================

wss.on('connection', (ws, req) => {
  const connectionId = generateConnectionId();

  // Check total connection limit
  if (!checkTotalConnectionLimit()) {
    console.log('Server at capacity, rejecting new connection');
    ws.close(1013, 'Server at capacity. Please try again later.');
    return;
  }

  // Check connection rate limit
  const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
                   req.headers['x-real-ip'] ||
                   req.socket.remoteAddress || 'unknown';

  if (!rateLimiter.checkConnectionRateLimit(clientIP)) {
    console.log(`Rate limit: Connection rejected for IP ${clientIP}`);
    ws.close(1008, 'Too many connection attempts. Please try again later.');
    return;
  }

  // Get token from URL
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token') || url.searchParams.get('userId');

  if (!token) {
    ws.close(1008, 'Authentication required');
    return;
  }

  // Verify JWT token
  let userId = token;
  let tokenNeedsRefresh = false;

  if (token !== 'api-server' && token.includes('.')) {
    try {
      let decoded;
      try {
        decoded = jwt.verify(token, config.EFFECTIVE_JWT_SECRET, {
          issuer: config.JWT_OPTIONS.issuer,
          audience: config.JWT_OPTIONS.audience
        });
      } catch (verifyError) {
        if (verifyError.message.includes('jwt issuer invalid') || verifyError.message.includes('jwt audience invalid')) {
          decoded = jwt.verify(token, config.EFFECTIVE_JWT_SECRET);
        } else {
          throw verifyError;
        }
      }

      if (!decoded || !decoded.userId) {
        ws.close(1008, 'Invalid token payload');
        return;
      }

      // Check expiration with grace period
      if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) {
        const expiredFor = Math.floor(Date.now() / 1000) - decoded.exp;
        if (expiredFor > config.JWT_OPTIONS.gracePeriod) {
          ws.close(1008, 'Token expired - please login again');
          return;
        }
        tokenNeedsRefresh = true;
      }

      // Check if token is about to expire
      if (decoded.exp) {
        const expiresIn = decoded.exp - Math.floor(Date.now() / 1000);
        if (expiresIn > 0 && expiresIn < config.JWT_OPTIONS.refreshWarningThreshold) {
          tokenNeedsRefresh = true;
        }
      }

      userId = String(decoded.userId);
    } catch (error) {
      console.error('JWT verification failed:', error.message);
      ws.close(1008, 'Authentication failed: ' + error.message);
      return;
    }
  } else {
    console.log(`WebSocket connected: ${userId}`);
  }

  // Check per-user connection limit
  if (!checkUserConnectionLimit(userId)) {
    console.log(`User ${userId} at connection limit, closing oldest connection`);
    const existingConn = connections.get(userId);
    if (existingConn && existingConn.ws) {
      existingConn.ws.close(1000, 'New connection opened from another device');
    }
  }

  // Store connection
  connections.set(userId, {
    ws,
    connectionId,
    role: null,
    tripId: null,
    location: null,
    lastHeartbeat: Date.now(),
    driverId: null,
    riderId: null
  });

  trackUserConnection(userId, connectionId);
  console.log(`Active connections: ${connections.size}, Unique users: ${userConnections.size}`);

  // Special handling for API server
  if (userId === 'api-server') {
    console.log('API Server connected for notifications');
    connections.get(userId).role = 'api-server';
  }

  // Notify if token needs refresh
  if (tokenNeedsRefresh) {
    ws.send(JSON.stringify({
      type: 'token_refresh_needed',
      message: 'Your authentication token is expired or expiring soon. Please refresh it.',
      timestamp: new Date().toISOString()
    }));
  }

  // Handle messages
  ws.on('message', (message) => {
    try {
      if (!rateLimiter.checkMessageRateLimit(userId)) {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Too many messages. Please slow down.',
          code: 'RATE_LIMIT_EXCEEDED'
        }));
        return;
      }

      const data = JSON.parse(message);
      handleMessage(userId, data);
    } catch (error) {
      console.error('Error handling message:', error);
    }
  });

  // Handle disconnect
  ws.on('close', () => {
    console.log(`User ${userId} disconnected (${connectionId})`);
    const userConn = connections.get(userId);

    untrackUserConnection(userId, connectionId);

    // Clean up driver ID mappings
    if (userConn?.driverId) {
      const driverId = userConn.driverId;
      [driverId, String(driverId), parseInt(String(driverId)), userId, String(userId)]
        .filter(key => key !== undefined && key !== null && !isNaN(key))
        .forEach(key => driverIdToUserId.delete(key));
    }

    // Clean up rider ID mappings
    if (userConn?.riderId) {
      const riderId = userConn.riderId;
      [riderId, String(riderId), parseInt(String(riderId)), userId, String(userId)]
        .filter(key => key !== undefined && key !== null && !isNaN(key))
        .forEach(key => riderIdToUserId.delete(key));
    }

    // Remove from all trip connections
    tripConnections.forEach((tripUsers, tripId) => {
      if (tripUsers.has(userId)) {
        tripUsers.delete(userId);
        if (tripUsers.size === 0) tripConnections.delete(tripId);
      }
    });

    connections.delete(userId);
    console.log(`User ${userId} fully cleaned up`);
  });

  // Handle pong response
  ws.on('pong', () => {
    const userConn = connections.get(userId);
    if (userConn) userConn.lastHeartbeat = Date.now();
  });

  // Send initial connection success
  ws.send(JSON.stringify({
    type: 'connected',
    payload: { userId, timestamp: new Date().toISOString() }
  }));
});

// ==================== PROCESS HANDLERS ====================

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing WebSocket server');
  wss.close(() => {
    console.log('WebSocket server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing WebSocket server');
  wss.close(() => {
    console.log('WebSocket server closed');
    process.exit(0);
  });
});

console.log('WebSocket server is ready and listening on port', config.WS_PORT);
console.log('Connect at ws://localhost:' + config.WS_PORT);
console.log('Live tracking enabled with continuous WebSocket streaming');
console.log('Live Mode and Shared Ride tracking handlers loaded');
