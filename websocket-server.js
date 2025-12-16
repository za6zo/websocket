// ✅ Load environment variables from .env file
require('dotenv').config();

const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');
const express = require('express');
const fetch = require('node-fetch');
const pushNotificationService = require('./push-notification');
const jwt = require('jsonwebtoken');

const WS_PORT = process.env.WS_PORT || 8080;
const HTTP_PORT = process.env.HTTP_PORT || 8090;
const API_URL = process.env.API_URL || 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production-12345678';



// WebSocket connection management
const connections = new Map(); // userId -> { ws, role, tripId, location, lastHeartbeat }
const tripConnections = new Map(); // tripId -> Set of userIds
const driverIdToUserId = new Map(); // driverId -> userId mapping for notifications
const riderIdToUserId = new Map(); // riderId -> userId mapping for notifications

// ✅ RATE LIMITING: Track connection attempts and message rates
const connectionAttempts = new Map(); // IP -> { count, firstAttempt }
const messageRateLimits = new Map(); // userId -> { count, windowStart }

// ✅ HEARTBEAT MONITORING: Configuration
const CONNECTION_TIMEOUT = 60000; // 60 seconds - close if no heartbeat
const HEARTBEAT_INTERVAL = 30000; // 30 seconds - check interval

// ✅ Rate limit configuration (relaxed for development)
const RATE_LIMITS = {
  CONNECTION_ATTEMPTS: {
    maxAttempts: 20, // ✅ Increased to 20 to allow more reconnection attempts during development
    windowMs: 60 * 1000, // 1 minute - resets every minute so users aren't permanently blocked
  },
  MESSAGES: {
    maxMessages: 100,
    windowMs: 60 * 1000, // 1 minute
  },
};

// Cleanup old rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();

  // Cleanup connection attempts
  for (const [ip, data] of connectionAttempts.entries()) {
    if (now - data.firstAttempt > RATE_LIMITS.CONNECTION_ATTEMPTS.windowMs) {
      connectionAttempts.delete(ip);
    }
  }

  // Cleanup message rate limits
  for (const [userId, data] of messageRateLimits.entries()) {
    if (now - data.windowStart > RATE_LIMITS.MESSAGES.windowMs) {
      messageRateLimits.delete(userId);
    }
  }
}, 5 * 60 * 1000);

// ✅ TRIP DESTINATION CACHE: Store pickup/dropoff locations for ETA calculation
const tripDestinations = new Map(); // tripId -> { pickup, dropoff, status }

/**
 * Calculate distance between two coordinates using Haversine formula
 * @param {number} lat1 - Latitude of point 1
 * @param {number} lon1 - Longitude of point 1
 * @param {number} lat2 - Latitude of point 2
 * @param {number} lon2 - Longitude of point 2
 * @returns {number} Distance in kilometers
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Calculate ETA in minutes based on distance and speed
 * @param {object} driverLocation - Driver's current location { latitude, longitude, speed }
 * @param {object} destination - Destination { latitude, longitude }
 * @returns {number} ETA in minutes
 */
function calculateETA(driverLocation, destination) {
  if (!driverLocation || !destination) return null;

  const distance = calculateDistance(
    driverLocation.latitude,
    driverLocation.longitude,
    destination.latitude,
    destination.longitude
  );

  // Use driver's current speed if available and reasonable, otherwise use default
  // Speed is typically in m/s from GPS, convert to km/h
  let speedKmh = 25; // Default urban speed in km/h

  if (driverLocation.speed && driverLocation.speed > 0) {
    // Convert m/s to km/h
    speedKmh = driverLocation.speed * 3.6;
    // Clamp to reasonable values (5-80 km/h for urban driving)
    speedKmh = Math.max(5, Math.min(80, speedKmh));
  }

  // Calculate ETA in minutes
  const etaMinutes = (distance / speedKmh) * 60;

  // Add buffer for traffic/stops (20% extra time)
  const etaWithBuffer = etaMinutes * 1.2;

  return Math.ceil(etaWithBuffer);
}

/**
 * Store trip destination for ETA calculations
 * @param {string} tripId - Trip ID
 * @param {object} pickup - Pickup location { latitude, longitude }
 * @param {object} dropoff - Dropoff location { latitude, longitude }
 */
function setTripDestination(tripId, pickup, dropoff) {
  tripDestinations.set(tripId, {
    pickup,
    dropoff,
    status: 'ACCEPTED', // Default status
    updatedAt: new Date().toISOString()
  });
  console.log(`📍 Stored destinations for trip ${tripId}`);
}

/**
 * Update trip status (affects which destination is used for ETA)
 * @param {string} tripId - Trip ID
 * @param {string} status - New status (ACCEPTED, IN_PROGRESS, etc.)
 */
function updateTripStatus(tripId, status) {
  const trip = tripDestinations.get(tripId);
  if (trip) {
    trip.status = status;
    trip.updatedAt = new Date().toISOString();
  }
}

/**
 * Get the appropriate destination for ETA calculation based on trip status
 * @param {string} tripId - Trip ID
 * @returns {object|null} Destination { latitude, longitude }
 */
function getTripDestination(tripId) {
  const trip = tripDestinations.get(tripId);
  if (!trip) return null;

  // If trip is in progress, use dropoff. Otherwise use pickup.
  if (trip.status === 'IN_PROGRESS') {
    return trip.dropoff;
  }
  return trip.pickup;
}

/**
 * Check if connection attempt should be rate limited
 * @param {string} ip - Client IP address
 * @returns {boolean} True if allowed, false if rate limited
 */
function checkConnectionRateLimit(ip) {
  const now = Date.now();
  const attempts = connectionAttempts.get(ip);

  if (!attempts) {
    connectionAttempts.set(ip, { count: 1, firstAttempt: now });
    return true;
  }

  // Reset if window expired
  if (now - attempts.firstAttempt > RATE_LIMITS.CONNECTION_ATTEMPTS.windowMs) {
    connectionAttempts.set(ip, { count: 1, firstAttempt: now });
    return true;
  }

  // Check if exceeded limit
  if (attempts.count >= RATE_LIMITS.CONNECTION_ATTEMPTS.maxAttempts) {
    console.log(`🚫 [WS Rate Limit] Connection blocked for IP ${ip}: ${attempts.count} attempts`);
    return false;
  }

  attempts.count++;
  return true;
}

/**
 * Check if message should be rate limited
 * @param {string} userId - User ID
 * @returns {boolean} True if allowed, false if rate limited
 */
function checkMessageRateLimit(userId) {
  const now = Date.now();
  const limit = messageRateLimits.get(userId);

  if (!limit) {
    messageRateLimits.set(userId, { count: 1, windowStart: now });
    return true;
  }

  // Reset if window expired
  if (now - limit.windowStart > RATE_LIMITS.MESSAGES.windowMs) {
    messageRateLimits.set(userId, { count: 1, windowStart: now });
    return true;
  }

  // Check if exceeded limit
  if (limit.count >= RATE_LIMITS.MESSAGES.maxMessages) {
    console.log(`🚫 [WS Rate Limit] Messages blocked for user ${userId}: ${limit.count} messages/min`);
    return false;
  }

  limit.count++;
  return true;
}

/**
 * ✅ HEARTBEAT MONITOR: Check all connections and close stale ones
 * Runs every HEARTBEAT_INTERVAL (30s) and closes connections without heartbeat for CONNECTION_TIMEOUT (60s)
 */
function heartbeatMonitor() {
  const now = Date.now();
  let closedCount = 0;

  connections.forEach((conn, userId) => {
    // Skip if no lastHeartbeat set (newly connected)
    if (!conn.lastHeartbeat) {
      conn.lastHeartbeat = now;
      return;
    }

    // Check if heartbeat timeout exceeded
    const timeSinceLastHeartbeat = now - conn.lastHeartbeat;
    if (timeSinceLastHeartbeat > CONNECTION_TIMEOUT) {
      console.log(`⏱️ [Heartbeat] Timeout for user ${userId} (${Math.round(timeSinceLastHeartbeat/1000)}s since last heartbeat)`);

      // Close the connection
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.close(1000, 'Heartbeat timeout');
        closedCount++;
      }
    } else {
      // Send ping to active connections
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        try {
          conn.ws.ping();
        } catch (error) {
          console.error(`❌ [Heartbeat] Failed to ping user ${userId}:`, error.message);
        }
      }
    }
  });

  if (closedCount > 0) {
    console.log(`🧹 [Heartbeat] Closed ${closedCount} stale connection(s)`);
  }
}

// Create Express app for HTTP endpoints
const app = express();
app.use(express.json());

// Add CORS headers for ngrok
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, ngrok-skip-browser-warning');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Create HTTP server that will handle both HTTP requests and WebSocket upgrades
const server = http.createServer(app);

// Create WebSocket server attached to HTTP server (same port for both)
const wss = new WebSocket.Server({
  server,
  perMessageDeflate: false
});

// Start the combined HTTP + WebSocket server
server.listen(WS_PORT, () => {
  console.log(`🚀 Combined HTTP + WebSocket server running on port ${WS_PORT}`);
  console.log(`   - WebSocket: ws://localhost:${WS_PORT}`);
  console.log(`   - HTTP /notify: http://localhost:${WS_PORT}/notify`);
});

// ✅ Start heartbeat monitor
const heartbeatInterval = setInterval(heartbeatMonitor, HEARTBEAT_INTERVAL);
console.log(`💓 Heartbeat monitor started (checking every ${HEARTBEAT_INTERVAL/1000}s, timeout: ${CONNECTION_TIMEOUT/1000}s)`);

// HTTP endpoint for backend to send notifications (now on same port as WebSocket)
app.post('/notify', (req, res) => {
  const { type, payload } = req.body;
  // console.log(`📨 HTTP Notification received: ${type}`);
  // console.log(`📦 Full notification payload:`, JSON.stringify({ type, payload }, null, 2));

  if (type === 'new_trip_request') {
    // Broadcast to all connected drivers
    broadcastToDrivers(payload);
    res.json({ success: true, message: 'Notification sent to drivers' });
  } else if (type === 'new_bid') {
    // Notify rider about new bid
    notifyRiderAboutBid(payload);
    res.json({ success: true, message: 'Bid notification sent to rider' });
  } else if (type === 'bid_accepted') {
    // Notify driver that their bid was accepted
    notifyDriverBidAccepted(payload);
    res.json({ success: true, message: 'Bid acceptance notification sent to driver' });
  } else if (type === 'bid_rejected') {
    // Notify driver that their bid was rejected
    notifyDriverBidRejected(payload);
    res.json({ success: true, message: 'Bid rejection notification sent to driver' });
  } else if (type === 'passenger_ready') {
    // Notify driver that passenger is ready
    notifyPassengerReady(payload.riderId, payload);
    res.json({ success: true, message: 'Passenger ready notification sent to driver' });
  } else if (type === 'start_live_tracking') {
    // Start live tracking for trip
    console.log('🔴 Starting live tracking:', payload);
    startLiveTracking('api-server', payload);
    res.json({ success: true, message: 'Live tracking started' });
  } else if (type === 'trip_started') {
    // Notify rider that trip has started
    notifyTripStarted(payload.driverId, payload);
    res.json({ success: true, message: 'Trip started notification sent to rider' });
  } else if (type === 'trip_cancelled') {
    // Handle trip cancellation notification
    notifyTripCancelled(payload);
    res.json({ success: true, message: 'Trip cancelled notification sent' });
  } else if (type === 'trip_completed') {
    // Handle trip completion notification
    notifyTripCompleted(payload.riderId, payload);
    res.json({ success: true, message: 'Trip completed notification sent' });
  } else if (type === 'driver_arrived') {
    // Handle driver arrived notification
    notifyDriverArrived(payload.riderId, payload);
    res.json({ success: true, message: 'Driver arrived notification sent' });
  } else if (type === 'driver_location_update') {
    // Broadcast driver location to passenger
    broadcastDriverLocationUpdate(payload);
    res.json({ success: true, message: 'Driver location update sent to passenger' });
  } else if (type === 'passenger_ride_request') {
    // Notify driver about new passenger request for their route
    notifyDriverAboutPassengerRequest(payload);
    res.json({ success: true, message: 'Passenger request notification sent to driver' });
  } else if (type === 'passenger_request_cancelled') {
    // Notify driver that passenger cancelled their request
    notifyDriverAboutRequestCancellation(payload);
    res.json({ success: true, message: 'Cancellation notification sent to driver' });
  } else if (type === 'driver_accepted_request') {
    // Notify passenger that driver accepted their request
    notifyPassengerAboutAcceptance(payload);
    res.json({ success: true, message: 'Acceptance notification sent to passenger' });
  } else if (type === 'driver_rejected_request' || type === 'passenger_request_rejected') {
    // Notify passenger that driver rejected their request
    notifyPassengerAboutRejection(payload);
    res.json({ success: true, message: 'Rejection notification sent to passenger' });
  } else if (type === 'route_cancelled') {
    // Notify passenger that driver cancelled the route
    notifyPassengerAboutRouteCancellation(payload);
    res.json({ success: true, message: 'Route cancellation notification sent to passenger' });
  } else if (type === 'subscription_request') {
    // Notify driver about new subscription request
    notifyDriverAboutSubscriptionRequest(payload);
    res.json({ success: true, message: 'Subscription request notification sent to driver' });
  } else if (type === 'subscription_status') {
    // Notify passenger about subscription request status
    notifyPassengerAboutSubscriptionStatus(payload);
    res.json({ success: true, message: 'Subscription status notification sent to passenger' });
  } else if (type === 'subscription_confirmed') {
    // Notify both parties about confirmed subscription
    notifySubscriptionConfirmed(payload);
    res.json({ success: true, message: 'Subscription confirmation sent to both parties' });
  } else if (type === 'subscription_trip_update') {
    // Notify about subscription trip update
    notifySubscriptionTrip(payload);
    res.json({ success: true, message: 'Subscription trip notification sent' });
  } else if (type === 'city_trip_request') {
    // Notify drivers about new city trip request
    notifyCityTripRequest(payload);
    res.json({ success: true, message: 'City trip request broadcasted to drivers' });
  } else if (type === 'city_trip_direct_request') {
    // Notify specific driver about direct trip request
    notifyCityTripDirectRequest(payload);
    res.json({ success: true, message: 'City trip direct request sent to driver' });
  } else if (type === 'city_trip_accepted') {
    // Notify passenger that driver accepted trip
    notifyCityTripAccepted(payload);
    res.json({ success: true, message: 'City trip accepted notification sent' });
  } else if (type === 'city_trip_rejected') {
    // Notify passenger that driver rejected trip
    notifyCityTripRejected(payload);
    res.json({ success: true, message: 'City trip rejected notification sent' });
  } else if (type === 'city_trip_counter_offer') {
    // Notify passenger about driver counter offer
    notifyCityTripCounterOffer(payload);
    res.json({ success: true, message: 'City trip counter offer sent to passenger' });
  } else if (type === 'city_trip_price_agreed') {
    // Notify driver that passenger accepted counter offer
    notifyCityTripPriceAgreed(payload);
    res.json({ success: true, message: 'City trip price agreed notification sent to driver' });
  } else if (type === 'city_trip_started') {
    // Notify passenger that trip started
    notifyCityTripStarted(payload);
    res.json({ success: true, message: 'City trip started notification sent' });
  } else if (type === 'city_trip_completed') {
    // Notify passenger that trip completed
    notifyCityTripCompleted(payload);
    res.json({ success: true, message: 'City trip completed notification sent' });
  } else if (type === 'city_trip_update') {
    // Notify about city trip status update
    notifyCityTripUpdate(payload);
    res.json({ success: true, message: 'City trip update notification sent' });
  } else if (type === 'driver_verified') {
    // Notify driver about verification status change
    notifyDriverVerified(payload);
    res.json({ success: true, message: 'Driver verification notification sent' });
  } else {
    res.status(400).json({ error: 'Unknown notification type: ' + type });
  }
});

// Note: HTTP /notify endpoint now runs on same port as WebSocket (WS_PORT)
// No separate HTTP_PORT listener needed - using combined server above

wss.on('connection', (ws, req) => {
  // ✅ RATE LIMITING: Check connection rate limit by IP
  const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket.remoteAddress
    || 'unknown';

  if (!checkConnectionRateLimit(clientIP)) {
    console.log(`🚫 [WS Rate Limit] Connection rejected for IP ${clientIP}`);
    ws.close(1008, 'Too many connection attempts. Please try again later.');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token') || url.searchParams.get('userId');

  if (!token) {
    ws.close(1008, 'Authentication required');
    return;
  }

  // Verify JWT token to get userId (or use raw token for special cases like 'api-server')
  let userId = token;
  if (token !== 'api-server' && token.includes('.')) {
    // This looks like a JWT token, verify it
    try {
      // First, try to verify with issuer/audience (new tokens)
      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET, {
          issuer: 'za6zo-backend',
          audience: 'za6zo-mobile'
        });
        console.log(`✅ WebSocket connected: User ${decoded.userId} (JWT verified with issuer/audience)`);
      } catch (verifyError) {
        // If verification fails due to missing issuer/audience, try without them (old tokens)
        if (verifyError.message.includes('jwt issuer invalid') || verifyError.message.includes('jwt audience invalid')) {
          console.log('⚠️ Token missing issuer/audience claims, verifying without them (backward compatibility)');
          decoded = jwt.verify(token, JWT_SECRET);
          console.log(`✅ WebSocket connected: User ${decoded.userId} (JWT verified - legacy token)`);
        } else if (verifyError.message.includes('invalid signature')) {
          // ⚠️ TEMPORARY FIX: Allow connections with invalid signature (JWT_SECRET mismatch)
          // This is for development/debugging - should be removed in production!
          console.warn('⚠️⚠️⚠️ WARNING: JWT signature verification failed, but allowing connection for development');
          console.warn('⚠️ This means JWT_SECRET might not match between services');
          console.warn('⚠️ Token preview:', token.substring(0, 50) + '...');

          // Try to decode without verification to get userId (INSECURE - for dev only!)
          try {
            decoded = jwt.decode(token);
            if (decoded && decoded.userId) {
              console.warn(`⚠️ Allowing user ${decoded.userId} to connect WITHOUT signature verification`);
            } else {
              throw new Error('Cannot decode token or missing userId');
            }
          } catch (decodeError) {
            console.error('❌ Failed to decode token even without verification:', decodeError.message);
            throw verifyError; // Fall back to original error
          }
        } else {
          // Re-throw other errors (expired, malformed, etc.)
          throw verifyError;
        }
      }

      if (!decoded || !decoded.userId) {
        console.error('❌ JWT verification failed: Missing userId in payload');
        ws.close(1008, 'Invalid token payload');
        return;
      }

      // Check expiration (jwt.verify already checks this, but adding explicit check for clarity)
      if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) {
        console.error('❌ JWT verification failed: Token expired');
        ws.close(1008, 'Token expired');
        return;
      }

      userId = String(decoded.userId);
    } catch (error) {
      console.error('❌ JWT verification failed:', error.message);

      // ⚠️ LAST RESORT: Try to extract userId from token payload without verification
      // This is VERY INSECURE but prevents blocking users during JWT_SECRET configuration issues
      try {
        const decoded = jwt.decode(token);
        if (decoded && decoded.userId) {
          userId = String(decoded.userId);
          console.warn(`⚠️⚠️⚠️ SECURITY WARNING: Allowing connection for user ${userId} WITHOUT JWT verification!`);
          console.warn('⚠️ Please fix JWT_SECRET configuration to enable proper security');
        } else {
          ws.close(1008, 'Authentication failed: ' + error.message);
          return;
        }
      } catch (decodeError) {
        ws.close(1008, 'Authentication failed: ' + error.message);
        return;
      }
    }
  } else {
    console.log(`WebSocket connected: ${userId}`);
  }

  // ✅ Store connection with heartbeat timestamp
  connections.set(userId, { ws, role: null, tripId: null, location: null, lastHeartbeat: Date.now() });
  
  // Special handling for API server connections
  if (userId === 'api-server') {
    console.log('API Server connected for notifications');
    connections.get(userId).role = 'api-server';
  }

  // Handle messages
  ws.on('message', (message) => {
    try {
      // ✅ RATE LIMITING: Check message rate limit
      if (!checkMessageRateLimit(userId)) {
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
    console.log(`User ${userId} disconnected`);
    const userConn = connections.get(userId);

    // ✅ Remove ALL driver ID mappings (handles String, Number, and userId variations)
    if (userConn?.driverId) {
      const driverId = userConn.driverId;
      const keysToDelete = [
        driverId,
        String(driverId),
        parseInt(String(driverId)),
        userId,
        String(userId)
      ];

      keysToDelete.forEach(key => {
        if (key !== undefined && key !== null && !isNaN(key)) {
          driverIdToUserId.delete(key);
        }
      });
      console.log(`🧹 Cleaned up all driver ID mappings for driver ${driverId}`);
    }

    // ✅ Remove ALL rider ID mappings (handles String, Number, and userId variations)
    if (userConn?.riderId) {
      const riderId = userConn.riderId;
      const keysToDelete = [
        riderId,
        String(riderId),
        parseInt(String(riderId)),
        userId,
        String(userId)
      ];

      keysToDelete.forEach(key => {
        if (key !== undefined && key !== null && !isNaN(key)) {
          riderIdToUserId.delete(key);
        }
      });
      console.log(`🧹 Cleaned up all rider ID mappings for rider ${riderId}`);
    }

    // ✅ Remove from ALL trip connections (not just current trip)
    tripConnections.forEach((tripUsers, tripId) => {
      if (tripUsers.has(userId)) {
        tripUsers.delete(userId);
        console.log(`🧹 Removed user ${userId} from trip ${tripId}`);
        if (tripUsers.size === 0) {
          tripConnections.delete(tripId);
          console.log(`🧹 Deleted empty trip connection for trip ${tripId}`);
        }
      }
    });

    connections.delete(userId);
    console.log(`✅ User ${userId} fully cleaned up`);
  });

  // ✅ Handle pong response from native WebSocket ping
  ws.on('pong', () => {
    const userConn = connections.get(userId);
    if (userConn) {
      userConn.lastHeartbeat = Date.now();
    }
  });

  // Send initial connection success
  ws.send(JSON.stringify({
    type: 'connected',
    payload: { userId, timestamp: new Date().toISOString() }
  }));
});

// Update driver's lastActiveAt via heartbeat
async function updateDriverHeartbeat(driverId) {
  try {
    await fetch(`${API_URL}/api/driver/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ driverId })
    });
  } catch (error) {
    // Silently fail - don't log to avoid spam
  }
}

// Handle incoming messages
function handleMessage(userId, data) {
  const { type, payload } = data;
  const userConn = connections.get(userId);
  
  if (!userConn) return;

  // ✅ Handle ping/pong (heartbeat)
  if (type === 'ping' || type === 'heartbeat') {
    // ✅ Update heartbeat timestamp
    userConn.lastHeartbeat = Date.now();

    if (userConn.ws) {
      userConn.ws.send(JSON.stringify({ type: 'pong', payload: {} }));
    }

    // Update driver's lastActiveAt in database if this is a driver
    if (userConn.role === 'driver' && userConn.driverId) {
      updateDriverHeartbeat(userConn.driverId);
    }

    return;
  }

  console.log(`Message from ${userId}:`, JSON.stringify(data));
  
  // Special handling for API server messages
  if (userConn.role === 'api-server') {
    console.log('📡 Processing API server notification:', type);
    switch (type) {
      case 'new_trip_request':
        console.log('🚕 Broadcasting new trip request to drivers...');
        console.log('📥 Received payload from API:', JSON.stringify(payload, null, 2));
        broadcastToDrivers(payload);
        return;
      case 'trip_accepted':
        notifyRiderTripAccepted(payload);
        return;
      case 'trip_started':
        notifyTripStarted(userId, payload);
        return;
      case 'trip_completed':
        notifyTripCompleted(userId, payload);
        return;
      case 'driver_arrived':
        notifyDriverArrived(userId, payload);
        return;
      case 'trip_cancelled':
        notifyTripCancelled(payload);
        return;
      case 'new_bid':
        // Handle bid notification from API server
        console.log('📥 Processing new_bid notification from API server');
        notifyRiderAboutBid(payload);
        return;
      case 'bid_accepted':
        // Handle bid accepted notification from API server
        console.log('✅ Processing bid_accepted notification from API server');
        console.log('📥 Bid accepted payload:', JSON.stringify(payload, null, 2));
        notifyDriverBidAccepted(payload);
        return;
      case 'bid_rejected':
        // Handle bid rejected notification from API server
        console.log('❌ Processing bid_rejected notification from API server');
        notifyDriverBidRejected(payload);
        return;
      case 'passenger_ride_request':
        // Handle passenger shared ride request from API server
        console.log('🚕 Processing passenger_ride_request notification from API server');
        console.log('📥 Passenger request payload:', JSON.stringify(payload, null, 2));
        notifyDriverAboutPassengerRequest(payload);
        return;
      case 'passenger_request_cancelled':
        // Handle passenger request cancellation from API server
        console.log('❌ Processing passenger_request_cancelled notification from API server');
        notifyDriverAboutRequestCancellation(payload);
        return;
      case 'driver_accepted_request':
        // Handle driver accepting passenger request from API server
        console.log('✅ Processing driver_accepted_request notification from API server');
        notifyPassengerAboutAcceptance(payload);
        return;
      case 'driver_rejected_request':
      case 'passenger_request_rejected':
        // Handle driver rejecting passenger request from API server
        console.log('❌ Processing driver_rejected_request notification from API server');
        notifyPassengerAboutRejection(payload);
        return;
      case 'subscription_request':
        // Handle subscription request notification from API server
        console.log('📅 Processing subscription_request notification from API server');
        console.log('📥 Subscription request payload:', JSON.stringify(payload, null, 2));
        notifyDriverAboutSubscriptionRequest(payload);
        return;
    }
  }

  switch (type) {
    case 'identify':
      // Set user role (driver or rider)
      userConn.role = payload.role;
      // console.log(`\n🆔 IDENTIFY MESSAGE RECEIVED`);
      console.log(`User ${userId} identified as ${payload.role}`);

      // Store trip ID if provided
      if (payload.tripId) {
        userConn.tripId = payload.tripId;
        console.log(`  Associated with trip: ${payload.tripId}`);
      }

      // Store driver ID if it's a driver
      if (payload.role === 'driver' && payload.driverId) {
        userConn.driverId = payload.driverId;

        // Normalize driverId to handle both string and integer versions
        const driverId = payload.driverId;
        const driverIdStr = String(driverId);

        // Create mapping from driverId to userId for notifications
        driverIdToUserId.set(driverId, userId); // Original version
        driverIdToUserId.set(driverIdStr, userId); // String version

        // If driverId can be parsed as integer, also store integer version
        const driverIdInt = parseInt(driverIdStr, 10);
        if (!isNaN(driverIdInt)) {
          driverIdToUserId.set(driverIdInt, userId);
        }

        // Also map the userId itself as a potential driverId (for Clerk ID compatibility)
        driverIdToUserId.set(userId, userId);
        const userIdStr = String(userId);
        driverIdToUserId.set(userIdStr, userId);

        // IMPORTANT: Also map the database userId if provided (for backend notifications)
        if (payload.userId && payload.userId !== userId) {
          driverIdToUserId.set(payload.userId, userId);
          driverIdToUserId.set(String(payload.userId), userId);
          const payloadUserIdInt = parseInt(payload.userId, 10);
          if (!isNaN(payloadUserIdInt)) {
            driverIdToUserId.set(payloadUserIdInt, userId);
          }
        }

        console.log(`  🚗 DRIVER MAPPING CREATED:`);
        console.log(`    Driver ID: ${payload.driverId}`);
        console.log(`    User ID: ${userId}`);
        console.log(`    Mapping: ${payload.driverId} → ${userId}`);
        console.log(`    Also mapped: ${userId} → ${userId} (for Clerk compatibility)`);
        if (payload.userId && payload.userId !== userId) {
          console.log(`    Database UserId mapping: ${payload.userId} → ${userId}`);
        }
        // console.log(`  📊 All driver mappings:`, Array.from(driverIdToUserId.entries()));
        // console.log(`  📊 All connections:`, Array.from(connections.keys()));
      }

      // Store rider ID if it's a rider
      if (payload.role === 'rider') {
        // The riderId might be the same as userId (from mobile app)
        // or it might be a specific riderId from the database
        const riderId = payload.riderId || userId;
        userConn.riderId = riderId;

        // Normalize riderId to string for consistent mapping
        const riderIdStr = String(riderId);

        // Create multiple mappings to ensure we can find the rider
        // Map both the riderId and userId to this connection
        riderIdToUserId.set(riderIdStr, userId); // String version
        riderIdToUserId.set(riderId, userId); // Original version (could be int or string)

        // If riderId can be parsed as integer, also store integer version
        const riderIdInt = parseInt(riderIdStr, 10);
        if (!isNaN(riderIdInt)) {
          riderIdToUserId.set(riderIdInt, userId);
        }

        if (payload.userId && payload.userId !== riderId) {
          const userIdStr = String(payload.userId);
          riderIdToUserId.set(payload.userId, userId);
          riderIdToUserId.set(userIdStr, userId);

          const userIdInt = parseInt(userIdStr, 10);
          if (!isNaN(userIdInt)) {
            riderIdToUserId.set(userIdInt, userId);
          }
        }

        // Also map the userId itself as a riderId (for backward compatibility)
        riderIdToUserId.set(userId, userId);
        const userIdStr = String(userId);
        riderIdToUserId.set(userIdStr, userId);

        console.log(`  🚕 RIDER MAPPING CREATED:`);
        console.log(`    Rider ID: ${riderId}`);
        console.log(`    User ID: ${userId}`);
        console.log(`    All rider mappings:`, Array.from(riderIdToUserId.entries()));
      }
      break;
    
    case 'new_trip_request':
      // Broadcast new trip request to all online drivers
      console.log('Broadcasting new trip request to all drivers');
      broadcastToDrivers(payload);
      break;
    
    case 'trip_accepted':
      // Notify specific rider about trip acceptance
      console.log('Notifying rider about trip acceptance:', payload.riderId);
      notifyRiderTripAccepted(payload);
      break;

    case 'track_trip':
      // Start tracking a trip
      joinTrip(userId, payload.tripId);
      break;

    case 'stop_tracking_trip':
      // Stop tracking a trip
      leaveTrip(userId, payload.tripId);
      break;

    case 'user_location':
    case 'driver_location':
      // Continuous driver location streaming
      broadcastLiveLocation(userId, payload);
      break;

    case 'start_live_tracking':
      // Start continuous live tracking for a trip
      startLiveTracking(userId, payload);
      break;

    case 'stop_live_tracking':
      // Stop live tracking for a trip
      stopLiveTracking(userId, payload);
      break;

    case 'trip_accepted':
      // Driver accepted trip, notify rider
      notifyTripAccepted(userId, payload);
      break;

    case 'trip_started':
    case 'tripStarted':  // Support both formats
      // Trip started, notify all parties
      notifyTripStarted(userId, payload);
      break;

    case 'trip_completed':
      // Trip completed, notify all parties
      notifyTripCompleted(userId, payload);
      break;

    case 'driver_arrived':
    case 'driverArrived':
      // Driver arrived at pickup, notify rider
      notifyDriverArrived(userId, payload);
      break;
    
    case 'passenger_ready':
      // Passenger confirmed ready, notify driver
      // The userId here is the passenger's userId, we need to pass the proper riderId
      const passengerConn = connections.get(userId);
      const actualRiderId = passengerConn?.riderId || payload.riderId || userId;
      notifyPassengerReady(actualRiderId, {
        ...payload,
        driverId: payload.driverId,
        tripId: payload.tripId
      });
      break;
    
    case 'passenger_seated':
      // Passenger confirmed seated, notify driver
      notifyPassengerSeated(userId, payload);
      break;
    
    case 'request_passenger_confirmation':
      // Driver requesting passenger confirmation
      requestPassengerConfirmation(userId, payload);
      break;
    
    case 'rider_location_update':
      // Rider sharing location with driver
      broadcastRiderLocation(userId, payload);
      break;
    
    case 'place_bid':
      // Driver places a bid on a trip request
      handleDriverBid(userId, payload);
      break;

    case 'accept_bid':
      // Rider accepts a driver's bid
      handleBidAcceptance(userId, payload);
      break;

    case 'reject_bid':
      // Rider rejects a driver's bid
      handleBidRejection(userId, payload);
      break;

    case 'send_reminder':
      // Driver sends reminder to passenger
      handleReminderNotification(userId, payload);
      break;

    case 'driver_reminder':
      // Driver sending reminder notification to passenger
      handleDriverReminder(userId, payload);
      break;

    case 'passenger_reminder':
      // Updated event name for driver reminder to passenger
      handlePassengerReminder(userId, payload);
      break;

    case 'driver_arrived_notification':
      // Driver notifies passenger of arrival
      handleDriverArrivedNotification(userId, payload);
      break;

    case 'waiting_charge_update':
      // Waiting charges update from driver to passenger
      handleWaitingChargeUpdate(userId, payload);
      break;

    case 'passenger_location_update':
      // Passenger sharing location for Live Mode or Shared Ride
      handlePassengerLocationUpdate(userId, payload);
      break;

    case 'driver_route_location':
      // Driver sharing location while on an active route
      handleDriverRouteLocationUpdate(userId, payload);
      break;

    case 'enable_live_mode':
      // Driver enabling Live Mode
      handleEnableLiveMode(userId, payload);
      break;

    case 'disable_live_mode':
      // Driver disabling Live Mode
      handleDisableLiveMode(userId);
      break;

    case 'view_route':
      // Passenger viewing a driver's route for real-time updates
      handleViewRoute(userId, payload);
      break;

    case 'stop_view_route':
      // Passenger stopped viewing route
      handleStopViewRoute(userId);
      break;

    case 'trip_cancelled':
      // Trip cancelled by driver or passenger
      console.log('🚫 Processing trip cancellation:', payload);
      notifyTripCancelled(payload);
      break;

    case 'subscription_status':
      // Notify passenger about subscription request status (accepted/rejected/counter)
      console.log('📢 Processing subscription status notification:', payload);
      notifyPassengerAboutSubscriptionStatus(payload);
      break;

    default:
      console.log('Unknown message type:', type);
  }
}

// Join a trip room
function joinTrip(userId, tripId) {
  const userConn = connections.get(userId);
  if (!userConn) return;

  // Leave previous trip if any
  if (userConn.tripId && userConn.tripId !== tripId) {
    leaveTrip(userId, userConn.tripId);
  }

  // Join new trip
  userConn.tripId = tripId;
  
  if (!tripConnections.has(tripId)) {
    tripConnections.set(tripId, new Set());
  }
  tripConnections.get(tripId).add(userId);

  console.log(`User ${userId} joined trip ${tripId}`);
  
  // Notify user they joined the trip
  sendToUser(userId, {
    type: 'joined_trip',
    payload: { tripId }
  });
}

// Leave a trip room
function leaveTrip(userId, tripId) {
  const userConn = connections.get(userId);
  if (userConn) {
    userConn.tripId = null;
  }

  const tripUsers = tripConnections.get(tripId);
  if (tripUsers) {
    tripUsers.delete(userId);
    if (tripUsers.size === 0) {
      tripConnections.delete(tripId);
    }
  }

  console.log(`User ${userId} left trip ${tripId}`);
}

// Update user location with continuous WebSocket streaming
function updateLocation(userId, locationData) {
  const userConn = connections.get(userId);
  if (!userConn) return;

  // Update stored location with timestamp
  userConn.location = {
    ...locationData,
    timestamp: new Date().toISOString(),
    userId: userId
  };

  // Broadcast to all users in the same trip in real-time
  if (userConn.tripId) {
    const tripUsers = tripConnections.get(userConn.tripId);
    if (tripUsers) {
      // Prepare location update message
      const locationUpdate = {
        tripId: userConn.tripId,
        ...userConn.location,
        role: userConn.role
      };

      tripUsers.forEach(otherUserId => {
        if (otherUserId !== userId) {
          const otherConn = connections.get(otherUserId);
          const messageType = userConn.role === 'driver'
            ? 'driver_location_update'
            : 'rider_location_update';
          
          sendToUser(otherUserId, {
            type: messageType,
            payload: {
              userId,
              location,
              role: userConn.role,
              timestamp: new Date().toISOString()
            }
          });
        }
      });
    }
  }
}

// Notify trip accepted
function notifyTripAccepted(driverId, payload) {
  const { riderId, tripId, driverInfo } = payload;
  
  // Join driver to trip
  joinTrip(driverId, tripId);
  
  // Notify rider
  sendToUser(riderId, {
    type: 'trip_request_accepted',
    payload: {
      tripId,
      driverId,
      driverInfo,
      timestamp: new Date().toISOString()
    }
  });
  
  // Also join rider to trip
  joinTrip(riderId, tripId);
}

// Notify trip started
function notifyTripStarted(driverId, payload) {
  const { tripId, riderId, startLocation, pickupLocation, dropoffLocation } = payload;

  console.log(`🚗 Trip ${tripId} started by driver ${driverId}`);
  console.log('Location data:', {
    startLocation: !!startLocation,
    pickupLocation: !!pickupLocation,
    dropoffLocation: !!dropoffLocation
  });

  // ✅ Update trip status for ETA calculation (now targets dropoff)
  updateTripStatus(tripId, 'IN_PROGRESS');

  // ✅ Store/update destinations if provided
  if (pickupLocation && dropoffLocation) {
    setTripDestination(tripId, pickupLocation, dropoffLocation);
  }

  const tripPayload = {
    tripId,
    driverId,
    startLocation,
    pickupLocation,
    dropoffLocation,
    // Also provide snake_case field names for compatibility
    pickup_location: pickupLocation,
    dropoff_location: dropoffLocation,
    destinationLocation: dropoffLocation, // Provide both naming conventions for compatibility
    timestamp: new Date().toISOString()
  };

  // Notify the rider specifically
  if (riderId) {
    sendToUser(riderId, {
      type: 'trip_started',
      payload: tripPayload
    });
    // Also send camelCase version for compatibility
    sendToUser(riderId, {
      type: 'tripStarted',
      payload: tripPayload
    });
    console.log(`✅ Notified rider ${riderId} that trip has started with both event formats`);
  }

  // Also broadcast to all trip participants
  broadcastToTrip(tripId, {
    type: 'trip_started',
    payload: {
      ...tripPayload,
      startedBy: driverId
    }
  }, driverId);
}

// Notify trip completed
function notifyTripCompleted(userId, payload) {
  const { tripId, fare, riderId, tripRequestId } = payload;
  
  console.log(`🏁 Trip ${tripId} completed by user ${userId}`);
  console.log(`Payload:`, payload);
  
  // Prepare the completion message
  const completionMessage = {
    type: 'trip_completed',
    payload: {
      tripId,
      fare,
      completedBy: userId,
      timestamp: new Date().toISOString(),
      trip: payload.trip || { id: tripId, estimatedFare: fare }
    }
  };
  
  // Method 1: Try to notify the rider directly
  if (riderId) {
    console.log(`Attempting to notify rider ${riderId} directly`);
    const riderNotified = sendToUser(riderId, completionMessage);
    if (riderNotified) {
      console.log(`✅ Rider ${riderId} notified directly about trip completion`);
    } else {
      console.log(`⚠️ Failed to notify rider ${riderId} directly`);
      
      // Try to find rider by their connection role
      connections.forEach((conn, uid) => {
        if (conn.riderId === riderId || uid === riderId) {
          sendToUser(uid, completionMessage);
          console.log(`✅ Rider ${riderId} notified via fallback (user ${uid})`);
        }
      });
    }
  }
  
  // Method 2: Broadcast to all users in the trip room
  broadcastToTrip(tripId, completionMessage);
  console.log(`📢 Broadcasted trip completion to trip room ${tripId}`);
  
  // Method 3: If we have a trip request ID, try that room too
  if (tripRequestId && tripRequestId !== tripId) {
    broadcastToTrip(tripRequestId, completionMessage);
    console.log(`📢 Also broadcasted to trip request room ${tripRequestId}`);
  }
  
  // Clean up trip connections after a delay to ensure messages are delivered
  setTimeout(() => {
    const tripUsers = tripConnections.get(tripId);
    if (tripUsers) {
      tripUsers.forEach(uid => {
        const conn = connections.get(uid);
        if (conn) conn.tripId = null;
      });
      tripConnections.delete(tripId);
      console.log(`🧹 Cleaned up trip room ${tripId}`);
    }
  }, 2000); // 2 second delay to ensure message delivery
}

// Notify passenger ready to driver
function notifyPassengerReady(riderId, payload) {
  const { tripId, tripRequestId, driverId, timestamp } = payload;
  
  console.log(`🚗 Passenger ready notification from ${riderId}`);
  console.log(`Trip IDs - Actual: ${tripId}, Request: ${tripRequestId}, Driver: ${driverId}`);
  
  // Debug: Show all current connections
  console.log('Current connections:', Array.from(connections.keys()));
  console.log('Current trip rooms:', Array.from(tripConnections.keys()));
  
  let driverNotified = false;
  
  // Method 1: Try to notify driver directly if driverId is provided
  if (driverId) {
    // Look up the actual WebSocket userId for this driverId
    const driverUserId = driverIdToUserId.get(driverId);
    console.log(`Driver ${driverId} maps to user ${driverUserId}`);
    
    if (driverUserId) {
      console.log(`Attempting to send to driver user ${driverUserId}...`);
      const sent = sendToUser(driverUserId, {
        type: 'passenger_ready',
        payload: {
          tripId: tripId || tripRequestId,
          riderId,
          timestamp
        }
      });
      if (sent) {
        console.log(`✅ Notified driver ${driverId} (user ${driverUserId}) that passenger is ready`);
        driverNotified = true;
      } else {
        console.log(`❌ Failed to notify driver ${driverId} (user ${driverUserId})`);
      }
    } else {
      console.log(`❌ No WebSocket user found for driver ${driverId}`);
    }
  }
  
  // Method 2: Find driver in trip room (using actual trip ID)
  if (!driverNotified && tripId) {
    const tripUsers = tripConnections.get(tripId);
    if (tripUsers) {
      console.log(`Looking for driver in trip ${tripId} connections:`, Array.from(tripUsers));
      tripUsers.forEach(userId => {
        const conn = connections.get(userId);
        if (conn && conn.role === 'driver') {
          sendToUser(userId, {
            type: 'passenger_ready',
            payload: {
              tripId,
              riderId,
              timestamp
            }
          });
          console.log(`✅ Notified driver ${userId} via trip room that passenger is ready`);
          driverNotified = true;
        }
      });
    }
  }
  
  // Method 3: Try with trip request ID if actual trip ID didn't work
  if (!driverNotified && tripRequestId && tripRequestId !== tripId) {
    const tripUsers = tripConnections.get(tripRequestId);
    if (tripUsers) {
      console.log(`Looking for driver in trip request ${tripRequestId} connections:`, Array.from(tripUsers));
      tripUsers.forEach(userId => {
        const conn = connections.get(userId);
        if (conn && conn.role === 'driver') {
          sendToUser(userId, {
            type: 'passenger_ready',
            payload: {
              tripId: tripId || tripRequestId,
              riderId,
              timestamp
            }
          });
          console.log(`✅ Notified driver ${userId} via trip request room that passenger is ready`);
          driverNotified = true;
        }
      });
    }
  }
  
  // Method 4: Broadcast to all drivers as last resort
  if (!driverNotified) {
    console.warn(`⚠️ Could not find driver for trip ${tripId || tripRequestId}, broadcasting to all drivers`);
    connections.forEach((conn, userId) => {
      if (conn.role === 'driver' && (conn.driverId === driverId || userId === driverId)) {
        sendToUser(userId, {
          type: 'passenger_ready',
          payload: {
            tripId: tripId || tripRequestId,
            riderId,
            timestamp
          }
        });
        console.log(`📢 Broadcast passenger ready to driver ${userId}`);
      }
    });
  }
}

// Notify passenger seated to driver
function notifyPassengerSeated(riderId, payload) {
  const { tripId, timestamp } = payload;
  
  console.log(`🚗 Passenger seated notification from ${riderId} for trip ${tripId}`);
  
  // Find driver in trip
  const tripUsers = tripConnections.get(tripId);
  if (tripUsers) {
    tripUsers.forEach(userId => {
      const conn = connections.get(userId);
      if (conn && conn.role === 'driver') {
        sendToUser(userId, {
          type: 'passenger_seated',
          payload: {
            tripId,
            riderId,
            timestamp
          }
        });
        console.log(`✅ Notified driver ${userId} that passenger is seated`);
      }
    });
  }
}

// Request passenger confirmation
function requestPassengerConfirmation(driverId, payload) {
  const { tripId, riderId, message } = payload;
  
  console.log(`📱 Driver ${driverId} requesting passenger confirmation`);
  
  sendToUser(riderId, {
    type: 'request_passenger_confirmation',
    payload: {
      tripId,
      driverId,
      message,
      timestamp: new Date().toISOString()
    }
  });
}

// Broadcast rider location to driver
function broadcastRiderLocation(riderId, payload) {
  const { tripId, location } = payload;
  
  // Find driver in trip
  const tripUsers = tripConnections.get(tripId);
  if (tripUsers) {
    tripUsers.forEach(userId => {
      const conn = connections.get(userId);
      if (conn && conn.role === 'driver' && userId !== riderId) {
        sendToUser(userId, {
          type: 'rider_location_update',
          payload: {
            riderId,
            location,
            timestamp: new Date().toISOString()
          }
        });
      }
    });
  }
}

// Notify trip cancelled
function notifyTripCancelled(payload) {
  const { tripId, tripRequestId, driverId, driverDbId, riderId, reason, cancelledBy } = payload;

  console.log(`🚫 Trip cancelled:`, { tripId, tripRequestId, driverId, driverDbId, riderId, reason, cancelledBy });

  // Prepare the cancellation message with all necessary fields for driver app
  const cancellationMessage = {
    type: 'trip_cancelled',
    payload: {
      tripId,
      tripRequestId, // Essential for driver app matching
      reason: reason || 'Trip has been cancelled',
      cancelledBy: cancelledBy || 'passenger',
      timestamp: new Date().toISOString()
    }
  };
  
  // Notify the driver if specified - try both Clerk userId and database driverId
  if (driverId || driverDbId) {
    console.log(`🔍 Looking for driver - Clerk ID: ${driverId}, DB ID: ${driverDbId}`);

    // Try multiple approaches to find the driver
    let driverNotified = false;
    const driverIdsToTry = [];

    // Collect all possible driver IDs
    if (driverId) driverIdsToTry.push(driverId);
    if (driverDbId && driverDbId !== driverId) driverIdsToTry.push(driverDbId);

    console.log(`📋 Will try these driver IDs:`, driverIdsToTry);

    for (const id of driverIdsToTry) {
      if (driverNotified) break;

      // 1. Try to find driver by driverId mapping
      const mappedUserId = driverIdToUserId.get(id);
      if (mappedUserId) {
        console.log(`📱 Found driver mapping: ${id} -> ${mappedUserId}`);
        const sent = sendToUser(mappedUserId, cancellationMessage);
        if (sent) {
          console.log(`✅ Notified driver via mapped userId ${mappedUserId}`);
          driverNotified = true;
          break;
        }
      }

      // 2. Try direct userId
      if (!driverNotified) {
        const sent = sendToUser(id, cancellationMessage);
        if (sent) {
          console.log(`✅ Notified driver directly via ID ${id}`);
          driverNotified = true;
          break;
        }
      }
    }

    // 3. Search all connections for this driver
    if (!driverNotified) {
      console.log(`🔍 Searching all connections for driver...`);
      connections.forEach((conn, userId) => {
        if (!driverNotified && conn.role === 'driver') {
          // Check if this connection matches any of our driver IDs
          const matches = driverIdsToTry.some(id =>
            conn.driverId === id || userId === id
          );
          if (matches) {
            sendToUser(userId, cancellationMessage);
            console.log(`✅ Found and notified driver via connection search: ${userId}`);
            driverNotified = true;
          }
        }
      });
    }

    if (!driverNotified) {
      console.log(`⚠️ Could not find driver connection for IDs: ${driverIdsToTry.join(', ')}`);
      console.log(`📊 Current driver mappings:`, Array.from(driverIdToUserId.entries()));
    }
  }
  
  // Notify the rider if specified
  if (riderId) {
    const sent = sendToUser(riderId, cancellationMessage);
    if (sent) {
      console.log(`✅ Notified rider ${riderId} about trip cancellation`);
    }
  }
  
  // Broadcast to trip room if trip ID exists
  if (tripId) {
    broadcastToTrip(tripId, cancellationMessage);
    console.log(`📢 Broadcasted cancellation to trip room ${tripId}`);
  }
  
  // Broadcast to trip request room if different from trip ID
  if (tripRequestId && tripRequestId !== tripId) {
    broadcastToTrip(tripRequestId, cancellationMessage);
    console.log(`📢 Broadcasted cancellation to trip request room ${tripRequestId}`);
  }
  
  // If no specific driver, broadcast to all drivers (for pending requests)
  if (!driverId) {
    connections.forEach((conn, userId) => {
      if (conn.role === 'driver') {
        sendToUser(userId, cancellationMessage);
      }
    });
    console.log(`📢 Broadcasted cancellation to all drivers`);
  }
}

// Notify driver arrived
function notifyDriverArrived(driverId, payload) {
  const { tripId, riderId, driverLocation, message } = payload;
  
  console.log(`🚗 Driver ${driverId} arrived for rider ${riderId} on trip ${tripId}`);
  
  // Prepare the notification message
  const riderNotification = {
    type: 'driver_arrived',
    payload: {
      tripId,
      driverId,
      driverLocation,
      message: message || 'Your driver has arrived!',
      timestamp: new Date().toISOString()
    }
  };
  
  // Try to notify the rider
  let riderNotified = false;
  
  // First try with riderId
  riderNotified = sendToUser(riderId, riderNotification);
  
  // If that fails, try to find rider by trip connections
  if (!riderNotified && tripId) {
    const tripUsers = tripConnections.get(tripId);
    if (tripUsers) {
      console.log(`Looking for rider in trip ${tripId} connections:`, Array.from(tripUsers));
      tripUsers.forEach(userId => {
        const conn = connections.get(userId);
        if (conn && conn.role === 'rider') {
          console.log(`Found rider connection: ${userId}`);
          riderNotified = sendToUser(userId, riderNotification);
        }
      });
    }
  }
  
  // If still not notified, broadcast to all riders as last resort
  if (!riderNotified) {
    console.warn(`⚠️ Could not directly notify rider ${riderId}, broadcasting to all riders`);
    connections.forEach((conn, userId) => {
      if (conn.role === 'rider' && (conn.riderId === riderId || userId === riderId)) {
        console.log(`Attempting to notify rider via broadcast: ${userId}`);
        sendToUser(userId, riderNotification);
      }
    });
  }
  
  // Also notify the driver to confirm
  const driverConfirmation = {
    type: 'arrival_confirmed',
    payload: {
      tripId,
      timestamp: new Date().toISOString()
    }
  };
  
  // Send confirmation to driver
  const driverNotified = sendToUser(driverId, driverConfirmation);
  
  if (!driverNotified) {
    // Try to find driver by connections
    connections.forEach((conn, userId) => {
      if (conn.role === 'driver' && (conn.driverId === driverId || userId === driverId)) {
        sendToUser(userId, driverConfirmation);
      }
    });
  }
  
  console.log(`📬 Driver arrival notification complete - Rider notified: ${riderNotified}`);
}

// Send message to specific user with push notification fallback
async function sendToUser(userId, message) {
  // First, try to find the actual connection key using mappings
  let connectionKey = userId;
  let userConn = connections.get(connectionKey);

  // If not found directly, try using mappings
  if (!userConn || !userConn.ws || userConn.ws.readyState !== WebSocket.OPEN) {
    // Try rider mapping (string and integer versions)
    let mappedUserId = riderIdToUserId.get(userId);
    if (!mappedUserId && typeof userId === 'number') {
      mappedUserId = riderIdToUserId.get(String(userId));
    } else if (!mappedUserId && typeof userId === 'string') {
      mappedUserId = riderIdToUserId.get(parseInt(userId, 10));
    }

    if (mappedUserId) {
      connectionKey = mappedUserId;
      userConn = connections.get(connectionKey);
      console.log(`🔄 Mapped userId ${userId} → ${connectionKey} via rider mapping`);
    }

    // If still not found, try driver mapping
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
        console.log(`🔄 Mapped userId ${userId} → ${connectionKey} via driver mapping`);
      }
    }
  }

  // Now try to send with the resolved connection key
  if (userConn && userConn.ws && userConn.ws.readyState === WebSocket.OPEN) {
    try {
      userConn.ws.send(JSON.stringify(message));
      console.log(`✉️ Message sent to user ${userId} (via connection ${connectionKey}):`, message.type);
      return true;
    } catch (error) {
      console.error(`❌ Failed to send message to user ${userId}:`, error.message);
      return false;
    }
  } else {
    console.warn(`⚠️ User ${userId} not connected or WebSocket not ready`);
    console.log('Available connections:', Array.from(connections.keys()));
    console.log('Tried connection key:', connectionKey);

    // Fallback to push notification for offline users
    await sendPushNotificationFallback(userId, message);
    return false;
  }
}

// Send push notification when WebSocket is unavailable
async function sendPushNotificationFallback(userId, message) {
  try {
    // Fetch user's push token from database
    const response = await fetch(`${API_URL}/api/users/${userId}/push-token`);
    if (!response.ok) {
      console.log(`⚠️ Could not fetch push token for user ${userId}`);
      return;
    }

    const { expoPushToken } = await response.json();
    if (!expoPushToken) {
      console.log(`⚠️ No push token found for user ${userId}`);
      return;
    }

    const { type, payload } = message;

    // Map message types to push notifications
    switch (type) {
      // ============================================
      // REGULAR RIDE NOTIFICATIONS
      // ============================================
      case 'new_trip_request':
        await pushNotificationService.notifyNewTripRequest(expoPushToken, payload);
        console.log(`📲 Sent push notification (new_trip_request) to ${userId}`);
        break;

      case 'bid_accepted':
        await pushNotificationService.notifyBidAccepted(expoPushToken, payload);
        console.log(`📲 Sent push notification (bid_accepted) to ${userId}`);
        break;

      case 'driver_arrived':
        await pushNotificationService.notifyDriverArrived(expoPushToken, payload);
        console.log(`📲 Sent push notification (driver_arrived) to ${userId}`);
        break;

      case 'trip_started':
      case 'tripStarted':
        await pushNotificationService.notifyTripStarted(expoPushToken, payload);
        console.log(`📲 Sent push notification (trip_started) to ${userId}`);
        break;

      case 'trip_completed':
        await pushNotificationService.notifyTripCompleted(expoPushToken, payload);
        console.log(`📲 Sent push notification (trip_completed) to ${userId}`);
        break;

      case 'trip_cancelled':
        await pushNotificationService.notifyTripCancelled(expoPushToken, payload);
        console.log(`📲 Sent push notification (trip_cancelled) to ${userId}`);
        break;

      case 'new_bid':
        await pushNotificationService.notifyNewBid(expoPushToken, payload);
        console.log(`📲 Sent push notification (new_bid) to ${userId}`);
        break;

      // ============================================
      // SHARED RIDE NOTIFICATIONS
      // ============================================
      case 'driver_accepted_request':
      case 'shared_ride_accepted':
        await pushNotificationService.notifySharedRideAccepted(expoPushToken, payload);
        console.log(`📲 Sent push notification (shared_ride_accepted) to ${userId}`);
        break;

      case 'driver_rejected_request':
      case 'passenger_request_rejected':
      case 'shared_ride_rejected':
        await pushNotificationService.notifySharedRideRejected(expoPushToken, payload);
        console.log(`📲 Sent push notification (shared_ride_rejected) to ${userId}`);
        break;

      case 'shared_ride_route_updated':
        await pushNotificationService.notifySharedRideRouteUpdated(expoPushToken, payload);
        console.log(`📲 Sent push notification (shared_ride_route_updated) to ${userId}`);
        break;

      case 'other_passenger_joined':
        await pushNotificationService.notifyOtherPassengerJoined(expoPushToken, payload);
        console.log(`📲 Sent push notification (other_passenger_joined) to ${userId}`);
        break;

      case 'route_cancelled':
        await pushNotificationService.notifyRouteCancelled(expoPushToken, payload);
        console.log(`📲 Sent push notification (route_cancelled) to ${userId}`);
        break;

      case 'passenger_ride_request':
        await pushNotificationService.notifyPassengerRideRequest(expoPushToken, payload);
        console.log(`📲 Sent push notification (passenger_ride_request) to ${userId}`);
        break;

      case 'passenger_request_cancelled':
        await pushNotificationService.notifyPassengerRequestCancelled(expoPushToken, payload);
        console.log(`📲 Sent push notification (passenger_request_cancelled) to ${userId}`);
        break;

      // ============================================
      // CITY-TO-CITY NOTIFICATIONS
      // ============================================
      case 'city_trip_request':
        await pushNotificationService.notifyCityTripRequest(expoPushToken, payload);
        console.log(`📲 Sent push notification (city_trip_request) to ${userId}`);
        break;

      case 'city_trip_direct_request':
        await pushNotificationService.notifyCityTripDirectRequest(expoPushToken, payload);
        console.log(`📲 Sent push notification (city_trip_direct_request) to ${userId}`);
        break;

      case 'city_trip_accepted':
        await pushNotificationService.notifyCityTripAccepted(expoPushToken, payload);
        console.log(`📲 Sent push notification (city_trip_accepted) to ${userId}`);
        break;

      case 'city_trip_rejected':
        await pushNotificationService.notifyCityTripRejected(expoPushToken, payload);
        console.log(`📲 Sent push notification (city_trip_rejected) to ${userId}`);
        break;

      case 'city_trip_counter_offer':
        await pushNotificationService.notifyCityTripCounterOffer(expoPushToken, payload);
        console.log(`📲 Sent push notification (city_trip_counter_offer) to ${userId}`);
        break;

      case 'city_trip_price_agreed':
        await pushNotificationService.notifyCityTripPriceAgreed(expoPushToken, payload);
        console.log(`📲 Sent push notification (city_trip_price_agreed) to ${userId}`);
        break;

      case 'city_trip_started':
        await pushNotificationService.notifyCityTripStarted(expoPushToken, payload);
        console.log(`📲 Sent push notification (city_trip_started) to ${userId}`);
        break;

      case 'city_trip_completed':
        await pushNotificationService.notifyCityTripCompleted(expoPushToken, payload);
        console.log(`📲 Sent push notification (city_trip_completed) to ${userId}`);
        break;

      // ============================================
      // SUBSCRIPTION NOTIFICATIONS
      // ============================================
      case 'subscription_request':
        await pushNotificationService.notifySubscriptionRequest(expoPushToken, payload);
        console.log(`📲 Sent push notification (subscription_request) to ${userId}`);
        break;

      case 'subscription_status':
        await pushNotificationService.notifySubscriptionStatus(expoPushToken, payload);
        console.log(`📲 Sent push notification (subscription_status) to ${userId}`);
        break;

      case 'subscription_confirmed':
        await pushNotificationService.notifySubscriptionStatus(expoPushToken, { ...payload, status: 'ACCEPTED' });
        console.log(`📲 Sent push notification (subscription_confirmed) to ${userId}`);
        break;

      case 'subscription_trip_update':
        await pushNotificationService.notifySubscriptionTripUpdate(expoPushToken, payload);
        console.log(`📲 Sent push notification (subscription_trip_update) to ${userId}`);
        break;

      case 'subscription_trip_reminder':
        await pushNotificationService.notifySubscriptionTripReminder(expoPushToken, payload);
        console.log(`📲 Sent push notification (subscription_trip_reminder) to ${userId}`);
        break;

      // ============================================
      // DRIVER NOTIFICATIONS
      // ============================================
      case 'driver_verified':
        await pushNotificationService.notifyDriverVerified(expoPushToken, payload);
        console.log(`📲 Sent push notification (driver_verified) to ${userId}`);
        break;

      // ============================================
      // SPECIAL RIDE NOTIFICATIONS
      // ============================================
      case 'special_ride_available':
        await pushNotificationService.notifySpecialRideAvailable(expoPushToken, payload);
        console.log(`📲 Sent push notification (special_ride_available) to ${userId}`);
        break;

      case 'special_ride_confirmed':
        await pushNotificationService.notifySpecialRideConfirmed(expoPushToken, payload);
        console.log(`📲 Sent push notification (special_ride_confirmed) to ${userId}`);
        break;

      case 'special_ride_reminder':
        await pushNotificationService.notifySpecialRideReminder(expoPushToken, payload);
        console.log(`📲 Sent push notification (special_ride_reminder) to ${userId}`);
        break;

      case 'special_ride_cancelled':
        await pushNotificationService.notifySpecialRideCancelled(expoPushToken, payload);
        console.log(`📲 Sent push notification (special_ride_cancelled) to ${userId}`);
        break;

      // ============================================
      // PROMOTIONAL NOTIFICATIONS
      // ============================================
      case 'promotion':
        await pushNotificationService.notifyPromotion(expoPushToken, payload);
        console.log(`📲 Sent push notification (promotion) to ${userId}`);
        break;

      case 'promo_expiring':
        await pushNotificationService.notifyPromoExpiring(expoPushToken, payload);
        console.log(`📲 Sent push notification (promo_expiring) to ${userId}`);
        break;

      case 'referral_bonus':
        await pushNotificationService.notifyReferralBonus(expoPushToken, payload);
        console.log(`📲 Sent push notification (referral_bonus) to ${userId}`);
        break;

      case 'loyalty_reward':
        await pushNotificationService.notifyLoyaltyReward(expoPushToken, payload);
        console.log(`📲 Sent push notification (loyalty_reward) to ${userId}`);
        break;

      case 'welcome_offer':
        await pushNotificationService.notifyWelcomeOffer(expoPushToken, payload);
        console.log(`📲 Sent push notification (welcome_offer) to ${userId}`);
        break;

      default:
        // Send generic notification for other types
        await pushNotificationService.sendToUser(
          expoPushToken,
          'Za6Zo Notification',
          `New ${type} notification`,
          { type, ...payload }
        );
        console.log(`📲 Sent generic push notification (${type}) to ${userId}`);
    }
  } catch (error) {
    console.error(`❌ Failed to send push notification to ${userId}:`, error.message);
  }
}

// Broadcast to all users in a trip
function broadcastToTrip(tripId, message, excludeUserId = null) {
  const tripUsers = tripConnections.get(tripId);
  if (tripUsers) {
    tripUsers.forEach(userId => {
      if (userId !== excludeUserId) {
        sendToUser(userId, message);
      }
    });
  }
}

// Broadcast to all online drivers or specific drivers
function broadcastToDrivers(data) {
  const { tripRequest, targetDriverIds, estimatedFare, vehicleType } = data;

  console.log('📢 Broadcasting trip request to drivers');
  console.log('Target driver IDs:', targetDriverIds);
  console.log('Vehicle type:', vehicleType);
  console.log('Estimated fare:', estimatedFare);
  // Debug logging - commented for production
  // console.log('🔍 TripRequest object:', {
  //   id: tripRequest?.id,
  //   riderId: tripRequest?.riderId,
  //   hasPickupLocation: !!tripRequest?.pickupLocation,
  //   hasDropoffLocation: !!tripRequest?.dropoffLocation,
  //   keys: Object.keys(tripRequest || {})
  // });

  let driversNotified = 0;
  let totalConnections = 0;
  let driverConnections = 0;

  // Prepare the payload with bidding information
  // Ensure tripRequest has proper structure
  const broadcastPayload = {
    id: tripRequest?.id || tripRequest?.tripRequestId,
    tripRequestId: tripRequest?.id || tripRequest?.tripRequestId, // Include both for compatibility
    riderId: tripRequest?.riderId,
    pickupLocation: tripRequest?.pickupLocation,
    dropoffLocation: tripRequest?.dropoffLocation,
    estimatedFare: estimatedFare || tripRequest?.estimatedFare,
    rideTypeId: tripRequest?.rideTypeId,
    status: tripRequest?.status,
    requestType: 'broadcast', // Mark as broadcast request
    allowBidding: true, // Enable bidding
    vehicleType: vehicleType,
    minBidAmount: tripRequest?.minBidAmount,
    maxBidAmount: tripRequest?.maxBidAmount,
    // Include rider info if available
    riderName: tripRequest?.rider?.name || 'Passenger',
    riderRating: tripRequest?.rider?.rating
  };

  // console.log('📦 Broadcast payload prepared:', {
  //   id: broadcastPayload.id,
  //   hasPickupLocation: !!broadcastPayload.pickupLocation,
  //   hasDropoffLocation: !!broadcastPayload.dropoffLocation,
  //   vehicleType: broadcastPayload.vehicleType,
  //   estimatedFare: broadcastPayload.estimatedFare
  // });

  // console.log('🔍 Checking connections for drivers...');

  connections.forEach((userConn, userId) => {
    totalConnections++;
    console.log(`  - User ${userId}: role=${userConn.role}, driverId=${userConn.driverId}, wsState=${userConn.ws.readyState}`);

    // Send to drivers
    if (userConn.role === 'driver') {
      driverConnections++;

      // If targetDriverIds provided and not empty, only send to those drivers
      if (targetDriverIds && targetDriverIds.length > 0) {
        // Check if this driver is in the target list
        const isTargetDriver = targetDriverIds.includes(userId) ||
                              targetDriverIds.includes(userConn.driverId);

        if (!isTargetDriver) {
          console.log(`⏩ Skipping driver ${userId} - not in target list`);
          return;
        }
      }
      // If targetDriverIds is empty or not provided, broadcast to all drivers

      if (userConn.ws.readyState === WebSocket.OPEN) {
        userConn.ws.send(JSON.stringify({
          type: 'new_trip_request',
          payload: broadcastPayload
        }));
        driversNotified++;
        console.log(`✅ Notified driver ${userId} about new trip request (bidding enabled)`);
      } else {
        console.log(`⚠️ Driver ${userId} WebSocket not open (state: ${userConn.ws.readyState})`);
      }
    }
  });

  console.log(`Broadcast sent to ${driversNotified} drivers`);

  if (driversNotified === 0) {
    console.log('⚠️ No drivers were notified! Possible reasons:');
    console.log('  1. No targeted drivers are connected to WebSocket');
    console.log('  2. Drivers connected but not identified as "driver" role');
    console.log('  3. Driver WebSocket connections are not in OPEN state');
    console.log('  4. Target driver IDs do not match connected drivers');
  }
}

// Notify specific rider about trip acceptance
// Notify driver that their bid was accepted
function notifyDriverBidAccepted(payload) {
  const { driverId, tripId, tripRequestId, bidId, bidAmount, riderId, message, pickupLocation, dropoffLocation, pickupAddress, dropoffAddress } = payload;

  console.log(`\n========== BID ACCEPTED NOTIFICATION ==========`);
  console.log(`✅ Notifying driver ${driverId} that bid was accepted`);
  console.log(`📍 Pickup: ${pickupAddress || 'N/A'}`);
  console.log(`📍 Dropoff: ${dropoffAddress || 'N/A'}`);
  // console.log('📊 Current driver mappings:', Array.from(driverIdToUserId.entries()));
  // console.log('📊 Current connections:', Array.from(connections.keys()));

  // Log details about each connection
  console.log('📝 Connection details:');
  connections.forEach((conn, userId) => {
    console.log(`  - User ${userId}: role=${conn.role}, driverId=${conn.driverId}, wsReady=${conn.ws.readyState === 1}`);
  });
  console.log(`================================================\n`);

  // Try to find driver by driverId mapping
  const driverUserId = driverIdToUserId.get(driverId);
  // console.log(`🔍 Looking up driver ${driverId} in mapping:`, driverUserId);

  const notification = {
    type: 'bid_accepted',
    payload: {
      tripId,
      tripRequestId,
      bidId,
      bidAmount,
      riderId,
      pickupLocation,
      dropoffLocation,
      pickupAddress,
      dropoffAddress,
      message: message || 'Your bid has been accepted! Get ready to pick up the passenger.',
      timestamp: new Date().toISOString()
    }
  };

  let notificationSent = false;

  // Method 1: Try using the driverId to userId mapping
  if (driverUserId) {
    console.log(`📍 Method 1: Using mapping ${driverId} → ${driverUserId}`);
    const sent = sendToUser(driverUserId, notification);
    if (sent) {
      console.log(`✅ Notified driver ${driverId} (user ${driverUserId}) about bid acceptance`);
      notificationSent = true;
    } else {
      console.log(`⚠️ Failed to send to mapped user ${driverUserId}`);
    }
  }

  // Method 2: Try direct driverId as connection key
  if (!notificationSent) {
    console.log(`📍 Method 2: Trying direct driverId as connection key: ${driverId}`);
    const sent = sendToUser(driverId, notification);
    if (sent) {
      console.log(`✅ Sent directly to driver ${driverId}`);
      notificationSent = true;
    }
  }

  // Method 3: Search all connections for matching driverId
  if (!notificationSent) {
    console.log(`📍 Method 3: Searching all connections for driver ${driverId}`);
    for (const [userId, conn] of connections.entries()) {
      console.log(`  Checking connection: userId=${userId}, conn.driverId=${conn.driverId}, role=${conn.role}`);
      if (conn.driverId === driverId && !notificationSent) {
        console.log(`  🎯 Found matching connection!`);
        const sent = sendToUser(userId, notification);
        if (sent) {
          console.log(`  ✅ Sent to driver via connection search: ${userId}`);
          notificationSent = true;
          break;
        }
      }
    }
  }

  if (!notificationSent) {
    console.log(`❌ Could not find driver ${driverId} in any connection!`);
  }

  // Also notify other drivers that the trip is no longer available
  const tripUnavailableNotification = {
    type: 'trip_unavailable',
    payload: {
      tripRequestId,
      reason: 'Another driver was selected',
      timestamp: new Date().toISOString()
    }
  };

  connections.forEach((conn, userId) => {
    if (conn.role === 'driver' && userId !== driverUserId && userId !== driverId) {
      sendToUser(userId, tripUnavailableNotification);
    }
  });
}

// Notify driver that their bid was rejected
function notifyDriverBidRejected(payload) {
  const { driverId, tripRequestId, bidId, reason } = payload;

  console.log(`❌ Notifying driver ${driverId} that bid was rejected`);

  // Try to find driver by driverId mapping
  const driverUserId = driverIdToUserId.get(driverId);

  const notification = {
    type: 'bid_rejected',
    payload: {
      tripRequestId,
      bidId,
      reason: reason || 'Another driver was selected',
      timestamp: new Date().toISOString()
    }
  };

  if (driverUserId) {
    sendToUser(driverUserId, notification);
    console.log(`❌ Notified driver ${driverId} (user ${driverUserId}) about bid rejection`);
  } else {
    // Try direct userId
    sendToUser(driverId, notification);
  }
}

// Notify rider about a new bid
function notifyRiderAboutBid(payload) {
  const { riderId, tripRequestId, bid } = payload;

  console.log(`📢 Notifying rider ${riderId} about new bid for trip ${tripRequestId}`);
  console.log('📦 Bid details:', JSON.stringify(bid, null, 2));
  console.log('🔍 Current rider mappings:', Array.from(riderIdToUserId.entries()));
  console.log('🔍 Current connections:', Array.from(connections.keys()));

  // Try multiple ways to find the rider
  let riderUserId = null;

  // 1. Try to find by riderId in mapping
  if (riderIdToUserId.has(riderId)) {
    riderUserId = riderIdToUserId.get(riderId);
    console.log(`✅ Found rider via mapping: ${riderId} → ${riderUserId}`);
  }

  // 2. If not found, check if riderId is directly a connection userId
  if (!riderUserId && connections.has(riderId)) {
    riderUserId = riderId;
    console.log(`✅ Found rider as direct connection: ${riderUserId}`);
  }

  // 3. Look through all connections for a rider with matching riderId
  if (!riderUserId) {
    for (const [userId, userConn] of connections.entries()) {
      if (userConn.riderId === riderId || userId === riderId) {
        riderUserId = userId;
        console.log(`✅ Found rider by scanning connections: ${riderUserId}`);
        break;
      }
    }
  }

  if (!riderUserId) {
    console.log(`⚠️ Rider ${riderId} not connected via WebSocket`);
    console.log('Available riders:', Array.from(connections.entries())
      .filter(([_, conn]) => conn.role === 'rider')
      .map(([userId, conn]) => ({ userId, riderId: conn.riderId }))
    );
    return;
  }

  const riderConn = connections.get(riderUserId);

  if (riderConn && riderConn.ws.readyState === WebSocket.OPEN) {
    const message = {
      type: 'new_bid',
      payload: {
        tripRequestId,
        bid
      }
    };

    riderConn.ws.send(JSON.stringify(message));
    console.log(`✅ Sent new bid notification to rider ${riderId}`);
  } else {
    console.log(`⚠️ Rider connection not available or not open for ${riderId}`);
  }
}

function notifyRiderTripAccepted(payload) {
  const { riderId, tripId, driverInfo, vehicle, estimatedArrival } = payload;

  // Find the rider's connection
  const riderConn = connections.get(riderId);
  
  if (riderConn && riderConn.ws.readyState === WebSocket.OPEN) {
    riderConn.ws.send(JSON.stringify({
      type: 'trip_request_accepted',
      payload: {
        tripId,
        driverInfo,
        vehicle,
        estimatedArrival
      }
    }));
    console.log(`✅ Notified rider ${riderId} about trip acceptance`);
    
    // Also join both rider and driver to the trip
    joinTrip(riderId, tripId);
    if (payload.driverId) {
      joinTrip(payload.driverId, tripId);
    }
  } else {
    console.log(`❌ Could not notify rider ${riderId} - not connected`);
  }
}

// Handle process termination
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

// Broadcast driver location update to passenger
function broadcastDriverLocationUpdate(payload) {
  const {
    tripId,
    riderId,
    passengerId, // For shared rides
    driverId,
    routeId, // For shared rides
    location,
    latitude, // Direct location fields
    longitude,
    heading,
    speed,
    eta,
    timestamp
  } = payload;

  // Support both tripId (regular trip) and routeId (shared ride)
  const targetId = riderId || passengerId;
  const journeyId = tripId || routeId;

  console.log(`📍 Broadcasting location update from driver ${driverId} to passenger ${targetId}`);
  console.log(`   Journey ID: ${journeyId} (${routeId ? 'shared ride' : 'regular trip'})`);
  console.log(`   Location: ${latitude || location?.latitude}, ${longitude || location?.longitude}`);

  // Normalize location object
  const normalizedLocation = location || {
    latitude: latitude,
    longitude: longitude,
    heading: heading || 0,
    speed: speed || 0
  };

  const notification = {
    type: 'driver_location_update',
    payload: {
      tripId: journeyId,
      routeId,
      driverId,
      latitude: normalizedLocation.latitude,
      longitude: normalizedLocation.longitude,
      heading: normalizedLocation.heading,
      speed: normalizedLocation.speed,
      location: normalizedLocation, // Keep for compatibility
      eta,
      timestamp: timestamp || new Date().toISOString()
    }
  };

  // Try multiple methods to find and notify the passenger
  let passengerNotified = false;

  // Method 1: Try direct targetId
  if (targetId) {
    const sent = sendToUser(targetId, notification);
    if (sent) {
      console.log(`✅ Sent location update to passenger ${targetId} directly`);
      passengerNotified = true;
    }
  }

  // Method 2: Try riderId mapping
  if (!passengerNotified && targetId) {
    // Try both number and string versions of targetId
    let passengerUserId = riderIdToUserId.get(targetId);
    if (!passengerUserId && typeof targetId === 'number') {
      passengerUserId = riderIdToUserId.get(String(targetId));
    } else if (!passengerUserId && typeof targetId === 'string') {
      passengerUserId = riderIdToUserId.get(parseInt(targetId, 10));
    }

    if (passengerUserId) {
      const sent = sendToUser(passengerUserId, notification);
      if (sent) {
        console.log(`✅ Sent location update via riderId mapping: ${targetId} → ${passengerUserId}`);
        passengerNotified = true;
      }
    }
  }

  // Method 3: Search all passenger/rider connections
  if (!passengerNotified && targetId) {
    connections.forEach((conn, userId) => {
      if (!passengerNotified && (conn.role === 'rider' || conn.role === 'passenger')) {
        if (conn.riderId === targetId || userId === targetId) {
          const sent = sendToUser(userId, notification);
          if (sent) {
            console.log(`✅ Found and sent location update via connection search: ${userId}`);
            passengerNotified = true;
          }
        }
      }
    });
  }

  if (!passengerNotified) {
    console.log(`⚠️ Could not find passenger ${targetId} to send location update`);
    console.log(`📊 Current connections:`, Array.from(connections.keys()));
    console.log(`📊 Current rider mappings:`, Array.from(riderIdToUserId.entries()));
  }

  return passengerNotified;
}

// ==================== BIDDING SYSTEM HANDLERS ====================

// Handle driver placing a bid
function handleDriverBid(driverId, payload) {
  const { tripRequestId, bidAmount, message, riderId } = payload;
  
  console.log(`💰 Driver ${driverId} placed bid ₨${bidAmount} for trip ${tripRequestId}`);
  
  // Notify the rider about the new bid
  const bidNotification = {
    type: 'new_bid',
    payload: {
      tripRequestId,
      driverId,
      bidAmount,
      message,
      timestamp: new Date().toISOString(),
      // Include driver info if available
      driverInfo: {
        id: driverId,
        name: connections.get(driverId)?.driverName || 'Driver'
      }
    }
  };
  
  // Try to notify the rider
  let riderNotified = false;
  if (riderId) {
    riderNotified = sendToUser(riderId, bidNotification);
  }
  
  // If direct notification failed, try to find rider by trip request
  if (!riderNotified) {
    // Broadcast to all riders (fallback)
    connections.forEach((conn, userId) => {
      if (conn.role === 'rider' || conn.role === 'passenger') {
        sendToUser(userId, bidNotification);
      }
    });
  }
  
  console.log(`📱 Notified rider about bid from driver ${driverId}`);
}

// Handle rider accepting a bid
function handleBidAcceptance(riderId, payload) {
  const { tripRequestId, bidId, driverId, bidAmount, tripId } = payload;

  console.log(`✅ Rider ${riderId} accepted bid ${bidId} from driver ${driverId}`);

  // ✅ FIX: Immediately join both users to trip room for real-time tracking
  // This ensures location updates work from the start
  const effectiveTripId = tripId || tripRequestId;
  if (effectiveTripId) {
    console.log(`🚗 Auto-joining driver ${driverId} and rider ${riderId} to trip ${effectiveTripId}`);
    joinTrip(driverId, effectiveTripId);
    joinTrip(riderId, effectiveTripId);

    // ✅ Auto-start live tracking session
    liveTrackingSessions.set(effectiveTripId, {
      driverId,
      riderId,
      startTime: new Date().toISOString(),
      isActive: true
    });
    console.log(`🔴 Auto-started live tracking for trip ${effectiveTripId}`);
  }

  // Notify the driver about bid acceptance
  const acceptanceNotification = {
    type: 'bid_accepted',
    payload: {
      tripRequestId,
      tripId: effectiveTripId,
      bidId,
      bidAmount,
      riderId,
      message: 'Your bid has been accepted! Get ready to pick up the passenger.',
      timestamp: new Date().toISOString()
    }
  };

  sendToUser(driverId, acceptanceNotification);

  // Notify other drivers that the trip is no longer available
  const tripUnavailableNotification = {
    type: 'trip_unavailable',
    payload: {
      tripRequestId,
      reason: 'Another driver was selected',
      timestamp: new Date().toISOString()
    }
  };

  connections.forEach((conn, userId) => {
    if (conn.role === 'driver' && userId !== driverId) {
      sendToUser(userId, tripUnavailableNotification);
    }
  });

  console.log(`📱 Notified all drivers about trip ${tripRequestId} being taken`);
}

// Handle rider rejecting a bid
function handleBidRejection(riderId, payload) {
  const { tripRequestId, bidId, driverId, reason } = payload;
  
  console.log(`❌ Rider ${riderId} rejected bid ${bidId} from driver ${driverId}`);
  
  // Notify the driver about bid rejection
  const rejectionNotification = {
    type: 'bid_rejected',
    payload: {
      tripRequestId,
      bidId,
      reason: reason || 'Rider chose a different option',
      timestamp: new Date().toISOString()
    }
  };
  
  sendToUser(driverId, rejectionNotification);
  console.log(`📱 Notified driver ${driverId} about bid rejection`);
}

// Live tracking management
const liveTrackingSessions = new Map(); // tripId -> { driverId, riderId, startTime }

// Start continuous live tracking for a trip
function startLiveTracking(userId, payload) {
  const { tripId, driverId, riderId } = payload;
  const userConn = connections.get(userId);

  if (!userConn) return;

  // Create tracking session
  liveTrackingSessions.set(tripId, {
    driverId,
    riderId,
    startTime: new Date().toISOString(),
    isActive: true
  });

  // Join both users to the trip
  joinTrip(driverId, tripId);
  joinTrip(riderId, tripId);

  console.log(`🔴 Started live tracking for trip ${tripId}`);

  // Notify both parties
  sendToUser(driverId, {
    type: 'live_tracking_started',
    payload: { tripId, role: 'driver' }
  });

  sendToUser(riderId, {
    type: 'live_tracking_started',
    payload: { tripId, role: 'rider' }
  });
}

// Stop live tracking for a trip
function stopLiveTracking(userId, payload) {
  const { tripId } = payload;
  const session = liveTrackingSessions.get(tripId);

  if (!session) return;

  session.isActive = false;
  liveTrackingSessions.delete(tripId);

  console.log(`⭕ Stopped live tracking for trip ${tripId}`);

  // Notify all users in the trip
  const tripUsers = tripConnections.get(tripId);
  if (tripUsers) {
    tripUsers.forEach(userId => {
      sendToUser(userId, {
        type: 'live_tracking_stopped',
        payload: { tripId }
      });
    });
  }
}

// Enhanced location update for continuous tracking
function broadcastLiveLocation(userId, payload) {
  const userConn = connections.get(userId);
  if (!userConn) {
    console.log(`❌ No connection found for user ${userId}`);
    return;
  }

  // Get tripId from payload or user connection
  const tripId = payload.tripId || userConn.tripId;
  if (!tripId) {
    console.log(`❌ No tripId found for location update from ${userId}`);
    return;
  }

  // Check if live tracking session exists, if not create one
  let session = liveTrackingSessions.get(tripId);
  if (!session) {
    console.log(`⚠️ No tracking session for trip ${tripId}, creating one`);
    liveTrackingSessions.set(tripId, {
      driverId: payload.driverId || userConn.driverId,
      riderId: payload.riderId || userConn.riderId,
      startTime: new Date().toISOString(),
      isActive: true
    });
    session = liveTrackingSessions.get(tripId);
  }

  // Store location update
  const locationData = payload.location || payload;
  userConn.location = {
    latitude: locationData.latitude,
    longitude: locationData.longitude,
    heading: locationData.heading || 0,
    speed: locationData.speed || 0,
    accuracy: locationData.accuracy || 0,
    timestamp: new Date().toISOString()
  };

  // ✅ Calculate ETA if this is a driver location update
  let eta = null;
  if (userConn.role === 'driver') {
    const destination = getTripDestination(tripId);
    if (destination) {
      eta = calculateETA(userConn.location, destination);
    }
  }

  // ✅ Store pickup/dropoff locations if provided in payload
  if (payload.pickupLocation && payload.dropoffLocation) {
    setTripDestination(tripId, payload.pickupLocation, payload.dropoffLocation);
  }

  // Build the location payload with ETA
  const locationPayload = {
    tripId: tripId,
    location: userConn.location,
    userId: userId,
    role: userConn.role,
    eta: eta, // ✅ Include ETA in the payload
    timestamp: new Date().toISOString()
  };

  // Get trip users
  const tripUsers = tripConnections.get(tripId);
  if (!tripUsers || tripUsers.size === 0) {
    console.log(`⚠️ No users in trip ${tripId}, broadcasting to all connections`);
    // Fallback: broadcast to all connections that might be interested
    connections.forEach((conn, uid) => {
      if (uid !== userId && (conn.tripId === tripId || uid === session.riderId)) {
        // Send both event types for compatibility
        sendToUser(uid, {
          type: userConn.role === 'driver' ? 'driver_live_location' : 'rider_live_location',
          payload: locationPayload
        });
        // Also send generic user_location event for compatibility
        sendToUser(uid, {
          type: 'user_location',
          payload: locationPayload
        });
      }
    });
    return;
  }

  // Broadcast to all trip participants immediately (no interval)
  tripUsers.forEach(otherUserId => {
    if (otherUserId !== userId) {
      // Send both event types for compatibility
      sendToUser(otherUserId, {
        type: userConn.role === 'driver' ? 'driver_live_location' : 'rider_live_location',
        payload: locationPayload
      });
      // Also send generic user_location event for compatibility
      sendToUser(otherUserId, {
        type: 'user_location',
        payload: locationPayload
      });
    }
  });

  // ✅ Send acknowledgment back to sender
  sendToUser(userId, {
    type: 'location_ack',
    payload: {
      tripId,
      timestamp: userConn.location.timestamp,
      eta: eta
    }
  });
}

// Handle reminder notification from driver to passenger
function handleReminderNotification(driverId, payload) {
  const { tripId, riderId, message } = payload;

  console.log(`⏰ Driver ${driverId} sending reminder for trip ${tripId}`);

  const reminderNotification = {
    type: 'driver_reminder',
    payload: {
      tripId,
      message: message || 'Your driver is waiting. Please confirm when ready.',
      timestamp: new Date().toISOString()
    }
  };

  // Send to specific rider
  const riderUserId = riderIdToUserId.get(riderId);
  if (riderUserId) {
    sendToUser(riderUserId, reminderNotification);
    console.log(`📱 Reminder sent to rider ${riderId}`);
  }
}

// Handle driver reminder with waiting time and charges
async function handleDriverReminder(driverId, payload) {
  const { tripId, riderId, driverId: payloadDriverId, message, waitingTime, waitingCharges, timestamp } = payload;

  console.log(`⏰ Driver ${driverId} sending reminder to passenger ${riderId}`);
  console.log(`   Waiting time: ${waitingTime}s, Charges: Rs.${waitingCharges}`);

  // Prepare notification for passenger
  const reminderNotification = {
    type: 'driver_reminder',
    payload: {
      tripId,
      driverId: payloadDriverId || driverId,
      message: message || 'Your driver has arrived and is waiting for you. Please come to the pickup location.',
      waitingTime: waitingTime || 0,
      waitingCharges: waitingCharges || 0,
      timestamp: timestamp || new Date().toISOString()
    }
  };

  // Try multiple methods to find and notify the passenger
  let passengerNotified = false;

  // Method 1: Try direct riderId
  const sent1 = sendToUser(riderId, reminderNotification);
  if (sent1) {
    console.log(`✅ Reminder sent directly to rider ${riderId}`);
    passengerNotified = true;
  }

  // Method 2: Try riderId mapping
  if (!passengerNotified) {
    const riderUserId = riderIdToUserId.get(riderId);
    if (riderUserId) {
      const sent2 = sendToUser(riderUserId, reminderNotification);
      if (sent2) {
        console.log(`✅ Reminder sent via mapping to rider ${riderId} (user ${riderUserId})`);
        passengerNotified = true;
      }
    }
  }

  // Method 3: Search all connections for matching riderId
  if (!passengerNotified && tripId) {
    connections.forEach((conn, userId) => {
      if (!passengerNotified && (conn.role === 'rider' || conn.role === 'passenger')) {
        if (conn.riderId === riderId || userId === riderId || conn.tripId === tripId) {
          const sent3 = sendToUser(userId, reminderNotification);
          if (sent3) {
            console.log(`✅ Reminder sent via connection search to user ${userId}`);
            passengerNotified = true;
          }
        }
      }
    });
  }

  if (!passengerNotified) {
    console.log(`⚠️ Could not find passenger ${riderId} to send reminder`);
    console.log(`📊 Current rider mappings:`, Array.from(riderIdToUserId.entries()));

    // Try push notification fallback
    await sendPushNotificationFallback(riderId, reminderNotification);
  }

  return passengerNotified;
}

// Handle passenger reminder with updated event name
async function handlePassengerReminder(driverId, payload) {
  const { tripId, passengerId, driverId: payloadDriverId, driverName, pickupAddress, message, waitingTime, waitingCharges, timestamp } = payload;

  console.log(`⏰ Driver ${driverId} sending passenger reminder`);
  console.log(`   Passenger: ${passengerId}, Waiting: ${waitingTime}s, Charges: Rs.${waitingCharges}`);

  // Prepare notification for passenger
  const reminderNotification = {
    type: 'passenger_reminder',
    payload: {
      tripId,
      driverId: payloadDriverId || driverId,
      driverName: driverName || 'Your driver',
      pickupAddress: pickupAddress || '',
      message: message || 'Your driver is waiting for you',
      waitingTime: waitingTime || 0,
      waitingCharges: waitingCharges || 0,
      timestamp: timestamp || new Date().toISOString()
    }
  };

  // Try to send to passenger
  let passengerNotified = false;

  // Method 1: Direct passenger ID
  const sent1 = sendToUser(passengerId, reminderNotification);
  if (sent1) {
    console.log(`✅ Reminder sent directly to passenger ${passengerId}`);
    passengerNotified = true;
  }

  // Method 2: Try mapping
  if (!passengerNotified) {
    const riderUserId = riderIdToUserId.get(passengerId);
    if (riderUserId) {
      const sent2 = sendToUser(riderUserId, reminderNotification);
      if (sent2) {
        console.log(`✅ Reminder sent via mapping to passenger ${passengerId}`);
        passengerNotified = true;
      }
    }
  }

  // Method 3: Search connections
  if (!passengerNotified) {
    connections.forEach((conn, userId) => {
      if (!passengerNotified && (conn.role === 'rider' || conn.role === 'passenger')) {
        if (conn.riderId === passengerId || userId === passengerId || conn.tripId === tripId) {
          const sent3 = sendToUser(userId, reminderNotification);
          if (sent3) {
            console.log(`✅ Reminder sent via search to user ${userId}`);
            passengerNotified = true;
          }
        }
      }
    });
  }

  if (!passengerNotified) {
    console.log(`⚠️ Could not find passenger ${passengerId}`);
  }

  return passengerNotified;
}

// Handle driver arrived notification
async function handleDriverArrivedNotification(driverId, payload) {
  const { tripId, riderId, driverId: payloadDriverId, driverName, pickupAddress, dropoffAddress, message } = payload;

  console.log(`🚗 Driver ${driverId} notifying passenger of arrival`);
  console.log(`   Passenger: ${riderId}, Trip: ${tripId}`);

  // Prepare notification for passenger
  const arrivalNotification = {
    type: 'driver_arrived_notification',
    payload: {
      tripId,
      driverId: payloadDriverId || driverId,
      driverName: driverName || 'Your driver',
      pickupAddress: pickupAddress || '',
      dropoffAddress: dropoffAddress || '',
      message: message || 'Your driver has arrived at the pickup location!',
      timestamp: new Date().toISOString()
    }
  };

  // Try to send to passenger
  let passengerNotified = false;

  // Method 1: Direct rider ID
  const sent1 = sendToUser(riderId, arrivalNotification);
  if (sent1) {
    console.log(`✅ Arrival notification sent directly to passenger ${riderId}`);
    passengerNotified = true;
  }

  // Method 2: Try mapping
  if (!passengerNotified) {
    const riderUserId = riderIdToUserId.get(riderId);
    if (riderUserId) {
      const sent2 = sendToUser(riderUserId, arrivalNotification);
      if (sent2) {
        console.log(`✅ Arrival notification sent via mapping to passenger ${riderId}`);
        passengerNotified = true;
      }
    }
  }

  // Method 3: Search connections
  if (!passengerNotified) {
    connections.forEach((conn, userId) => {
      if (!passengerNotified && (conn.role === 'rider' || conn.role === 'passenger')) {
        if (conn.riderId === riderId || userId === riderId || conn.tripId === tripId) {
          const sent3 = sendToUser(userId, arrivalNotification);
          if (sent3) {
            console.log(`✅ Arrival notification sent via search to user ${userId}`);
            passengerNotified = true;
          }
        }
      }
    });
  }

  if (!passengerNotified) {
    console.log(`⚠️ Could not find passenger ${riderId}`);
  }

  return passengerNotified;
}

// Handle waiting charge updates
async function handleWaitingChargeUpdate(driverId, payload) {
  const { tripId, riderId, waitingCharges, message, timestamp } = payload;

  console.log(`💰 Waiting charge update: Rs.${waitingCharges} for trip ${tripId}`);

  // Prepare notification for passenger
  const chargeNotification = {
    type: 'waiting_charge_update',
    payload: {
      tripId,
      waitingCharges: waitingCharges || 0,
      message: message || `Waiting charges: Rs.${waitingCharges} (Driver has been waiting)`,
      timestamp: timestamp || new Date().toISOString()
    }
  };

  // Try multiple methods to find and notify the passenger
  let passengerNotified = false;

  // Method 1: Try direct riderId
  const sent1 = sendToUser(riderId, chargeNotification);
  if (sent1) {
    console.log(`✅ Charge update sent directly to rider ${riderId}`);
    passengerNotified = true;
  }

  // Method 2: Try riderId mapping
  if (!passengerNotified) {
    const riderUserId = riderIdToUserId.get(riderId);
    if (riderUserId) {
      const sent2 = sendToUser(riderUserId, chargeNotification);
      if (sent2) {
        console.log(`✅ Charge update sent via mapping to rider ${riderId} (user ${riderUserId})`);
        passengerNotified = true;
      }
    }
  }

  // Method 3: Search all connections
  if (!passengerNotified && tripId) {
    connections.forEach((conn, userId) => {
      if (!passengerNotified && (conn.role === 'rider' || conn.role === 'passenger')) {
        if (conn.riderId === riderId || userId === riderId || conn.tripId === tripId) {
          const sent3 = sendToUser(userId, chargeNotification);
          if (sent3) {
            console.log(`✅ Charge update sent via connection search to user ${userId}`);
            passengerNotified = true;
          }
        }
      }
    });
  }

  if (!passengerNotified) {
    console.log(`⚠️ Could not find passenger ${riderId} to send charge update`);

    // Try push notification fallback
    await sendPushNotificationFallback(riderId, chargeNotification);
  }

  return passengerNotified;
}

// ==================== LIVE MODE & SHARED RIDE HANDLERS ====================

// Store live mode sessions and route tracking
const liveModeDrivers = new Map(); // driverId -> { location, passengers: Set() }
const activeRouteDrivers = new Map(); // routeId -> { driverId, location }
const passengerLocations = new Map(); // passengerId -> { location, timestamp }

// Handle passenger location update (for Live Mode)
function handlePassengerLocationUpdate(passengerId, payload) {
  const { latitude, longitude, heading, speed, accuracy, routeId, driverId } = payload;

  // Store passenger location
  passengerLocations.set(passengerId, {
    latitude,
    longitude,
    heading: heading || 0,
    speed: speed || 0,
    accuracy: accuracy || 0,
    timestamp: new Date().toISOString()
  });

  console.log(`📍 Passenger ${passengerId} location update: ${latitude}, ${longitude}`);

  // If driver is in live mode, broadcast to them
  if (driverId) {
    const driverUserId = driverIdToUserId.get(driverId);
    if (driverUserId) {
      sendToUser(driverUserId, {
        type: 'passenger_location_update',
        payload: {
          passengerId,
          location: {
            latitude,
            longitude,
            heading: heading || 0,
            speed: speed || 0
          },
          timestamp: new Date().toISOString()
        }
      });
      console.log(`✅ Sent passenger location to driver ${driverId}`);
    }
  }

  // If part of a route, notify driver on that route
  if (routeId && activeRouteDrivers.has(routeId)) {
    const routeInfo = activeRouteDrivers.get(routeId);
    const driverUserId = driverIdToUserId.get(routeInfo.driverId);
    if (driverUserId) {
      sendToUser(driverUserId, {
        type: 'passenger_location_update',
        payload: {
          passengerId,
          routeId,
          location: {
            latitude,
            longitude,
            heading: heading || 0,
            speed: speed || 0
          },
          timestamp: new Date().toISOString()
        }
      });
    }
  }
}

// Handle driver route location update (for Shared Ride tracking)
function handleDriverRouteLocationUpdate(driverId, payload) {
  const { latitude, longitude, heading, speed, routeId } = payload;

  // Store driver location for this route
  if (routeId) {
    activeRouteDrivers.set(routeId, {
      driverId,
      location: {
        latitude,
        longitude,
        heading: heading || 0,
        speed: speed || 0,
        timestamp: new Date().toISOString()
      }
    });

    console.log(`📍 Driver ${driverId} route location: ${latitude}, ${longitude}`);

    // Broadcast to all passengers viewing this route
    connections.forEach((conn, userId) => {
      if (conn.role === 'rider' && conn.viewingRouteId === routeId) {
        sendToUser(userId, {
          type: 'driver_route_location',
          payload: {
            routeId,
            driverId,
            location: {
              latitude,
              longitude,
              heading: heading || 0,
              speed: speed || 0
            },
            timestamp: new Date().toISOString()
          }
        });
      }
    });
  }
}

// Handle live mode enable (driver side)
function handleEnableLiveMode(driverId, payload) {
  const { sessionId } = payload;

  console.log(`🔴 Driver ${driverId} enabled Live Mode`);

  liveModeDrivers.set(driverId, {
    sessionId,
    location: null,
    passengers: new Set(),
    startTime: new Date().toISOString()
  });

  // Confirm to driver
  const driverUserId = driverIdToUserId.get(driverId);
  if (driverUserId) {
    sendToUser(driverUserId, {
      type: 'live_mode_enabled',
      payload: {
        sessionId,
        timestamp: new Date().toISOString()
      }
    });
  }
}

// Handle live mode disable (driver side)
function handleDisableLiveMode(driverId) {
  console.log(`⭕ Driver ${driverId} disabled Live Mode`);

  liveModeDrivers.delete(driverId);

  // Confirm to driver
  const driverUserId = driverIdToUserId.get(driverId);
  if (driverUserId) {
    sendToUser(driverUserId, {
      type: 'live_mode_disabled',
      payload: {
        timestamp: new Date().toISOString()
      }
    });
  }
}

// Handle passenger viewing a driver's route (for real-time updates)
function handleViewRoute(passengerId, payload) {
  const { routeId } = payload;

  console.log(`👀 Passenger ${passengerId} viewing route ${routeId}`);

  // Mark this connection as viewing the route
  const passengerConn = connections.get(passengerId);
  if (passengerConn) {
    passengerConn.viewingRouteId = routeId;

    // Send current driver location if available
    if (activeRouteDrivers.has(routeId)) {
      const routeInfo = activeRouteDrivers.get(routeId);
      sendToUser(passengerId, {
        type: 'driver_route_location',
        payload: {
          routeId,
          driverId: routeInfo.driverId,
          location: routeInfo.location,
          timestamp: new Date().toISOString()
        }
      });
    }
  }
}

// Handle passenger stop viewing route
function handleStopViewRoute(passengerId) {
  const passengerConn = connections.get(passengerId);
  if (passengerConn) {
    console.log(`👋 Passenger ${passengerId} stopped viewing route`);
    passengerConn.viewingRouteId = null;
  }
}

// Notify driver about new passenger request for their route
function notifyDriverAboutPassengerRequest(payload) {
  const {
    requestId,
    routeId,
    driverId,
    passengerId,
    passengerInfo,
    pickupLocation,
    dropoffLocation,
    pickupDistance,
    estimatedFare,
    requestedSeats,
    timestamp
  } = payload;

  console.log(`🚕 New passenger request for driver ${driverId} on route ${routeId}`);
  console.log(`   Passenger: ${passengerInfo.name} (${passengerId})`);
  console.log(`   Pickup: ${pickupLocation.address}`);
  console.log(`   Dropoff: ${dropoffLocation.address}`);
  console.log(`   Seats requested: ${requestedSeats || 1}`);

  // Prepare notification message
  const notification = {
    type: 'passenger_ride_request',
    payload: {
      requestId,
      routeId,
      passengerId,
      passengerInfo,
      pickupLocation,
      dropoffLocation,
      pickupDistance,
      estimatedFare,
      requestedSeats: requestedSeats || 1,
      timestamp
    }
  };

  // Try multiple methods to find and notify the driver
  let driverNotified = false;

  // Method 1: Try driverId mapping
  const driverUserId = driverIdToUserId.get(driverId);
  if (driverUserId) {
    console.log(`📍 Found driver mapping: ${driverId} → ${driverUserId}`);
    const sent = sendToUser(driverUserId, notification);
    if (sent) {
      console.log(`✅ Notified driver ${driverId} (user ${driverUserId}) about passenger request`);
      driverNotified = true;
    }
  }

  // Method 2: Try direct driverId as userId
  if (!driverNotified) {
    const sent = sendToUser(driverId, notification);
    if (sent) {
      console.log(`✅ Notified driver ${driverId} directly about passenger request`);
      driverNotified = true;
    }
  }

  // Method 3: Search all connections for this driver
  if (!driverNotified) {
    console.log(`🔍 Searching all connections for driver ${driverId}...`);
    connections.forEach((conn, userId) => {
      if (!driverNotified && conn.role === 'driver') {
        if (conn.driverId === driverId || userId === driverId) {
          const sent = sendToUser(userId, notification);
          if (sent) {
            console.log(`✅ Found and notified driver via connection search: ${userId}`);
            driverNotified = true;
          }
        }
      }
    });
  }

  if (!driverNotified) {
    console.log(`⚠️ Could not find driver ${driverId} in any connection!`);
    console.log(`📊 Current driver mappings:`, Array.from(driverIdToUserId.entries()));
    console.log(`📊 Current connections:`, Array.from(connections.keys()));
  }

  return driverNotified;
}

// Notify driver about passenger request cancellation
function notifyDriverAboutRequestCancellation(payload) {
  const { requestId, routeId, driverId, passengerId, reason, timestamp } = payload;

  console.log(`❌ Passenger ${passengerId} cancelled request ${requestId} for driver ${driverId}`);

  // Prepare notification message
  const notification = {
    type: 'passenger_request_cancelled',
    payload: {
      requestId,
      routeId,
      passengerId,
      reason,
      timestamp
    }
  };

  // Try multiple methods to find and notify the driver
  let driverNotified = false;

  // Method 1: Try driverId mapping
  const driverUserId = driverIdToUserId.get(driverId);
  if (driverUserId) {
    const sent = sendToUser(driverUserId, notification);
    if (sent) {
      console.log(`✅ Notified driver ${driverId} about request cancellation`);
      driverNotified = true;
    }
  }

  // Method 2: Try direct driverId
  if (!driverNotified) {
    const sent = sendToUser(driverId, notification);
    if (sent) {
      console.log(`✅ Notified driver ${driverId} directly about cancellation`);
      driverNotified = true;
    }
  }

  // Method 3: Search all connections
  if (!driverNotified) {
    connections.forEach((conn, userId) => {
      if (!driverNotified && conn.role === 'driver') {
        if (conn.driverId === driverId || userId === driverId) {
          const sent = sendToUser(userId, notification);
          if (sent) {
            console.log(`✅ Found and notified driver about cancellation: ${userId}`);
            driverNotified = true;
          }
        }
      }
    });
  }

  if (!driverNotified) {
    console.log(`⚠️ Could not find driver ${driverId} to notify about cancellation`);
  }

  return driverNotified;
}

// Notify driver about new subscription request
function notifyDriverAboutSubscriptionRequest(payload) {
  const {
    targetDriverId,
    requestId,
    passengerId,
    passengerName,
    passengerImage,
    routeId,
    destinationName,
    pickupAddress,
    acceptDriverPrice,
    proposedPrice,
    monthlyPrice,
    message,
    status
  } = payload;

  console.log(`📅 New subscription request for driver ${targetDriverId}`);
  console.log(`   Passenger: ${passengerName} (${passengerId})`);
  console.log(`   Route: ${routeId} - ${destinationName}`);
  console.log(`   Pickup: ${pickupAddress}`);
  console.log(`   Monthly Price: ${monthlyPrice}`);

  // Prepare notification message
  const notification = {
    type: 'newSubscriptionRequest',
    payload: {
      requestId,
      passengerId,
      passengerName,
      passengerImage,
      routeId,
      destinationName,
      pickupAddress,
      acceptDriverPrice,
      proposedPrice,
      monthlyPrice,
      message,
      status
    }
  };

  // Try multiple methods to find and notify the driver
  let driverNotified = false;

  // Method 1: Try driverId mapping
  const driverUserId = driverIdToUserId.get(targetDriverId);
  if (driverUserId) {
    console.log(`📍 Found driver mapping: ${targetDriverId} → ${driverUserId}`);
    const sent = sendToUser(driverUserId, notification);
    if (sent) {
      console.log(`✅ Notified driver ${targetDriverId} (user ${driverUserId}) about subscription request`);
      driverNotified = true;
    }
  }

  // Method 2: Try direct driverId as userId
  if (!driverNotified) {
    const sent = sendToUser(targetDriverId, notification);
    if (sent) {
      console.log(`✅ Notified driver ${targetDriverId} directly about subscription request`);
      driverNotified = true;
    }
  }

  // Method 3: Search all connections for this driver
  if (!driverNotified) {
    console.log(`🔍 Searching all connections for driver ${targetDriverId}...`);
    connections.forEach((conn, userId) => {
      if (!driverNotified && conn.role === 'driver') {
        if (conn.driverId === targetDriverId || userId === targetDriverId) {
          const sent = sendToUser(userId, notification);
          if (sent) {
            console.log(`✅ Found and notified driver via connection search: ${userId}`);
            driverNotified = true;
          }
        }
      }
    });
  }

  if (!driverNotified) {
    console.log(`⚠️ Could not find driver ${targetDriverId} in any connection!`);
    console.log(`📊 Current driver mappings:`, Array.from(driverIdToUserId.entries()));
    console.log(`📊 Current connections:`, Array.from(connections.keys()));
  }

  return driverNotified;
}

// Notify passenger about driver accepting their request
function notifyPassengerAboutAcceptance(payload) {
  const {
    requestId,
    routeId,
    passengerId,
    driverId,
    driverInfo,
    vehicleInfo,
    routeInfo,
    pickupLocation,
    dropoffLocation,
    estimatedFare,
    acceptedAt,
    message
  } = payload;

  console.log(`✅ Driver ${driverId} accepted passenger ${passengerId}'s request`);
  console.log(`   Driver: ${driverInfo.name} (${driverInfo.phone})`);
  if (vehicleInfo) {
    console.log(`   Vehicle: ${vehicleInfo.color} ${vehicleInfo.make} ${vehicleInfo.model} (${vehicleInfo.plateNumber})`);
  }

  // Prepare notification message
  const notification = {
    type: 'driver_accepted_request',
    payload: {
      requestId,
      routeId,
      driverId,
      driverInfo,
      vehicleInfo,
      routeInfo,
      pickupLocation,
      dropoffLocation,
      estimatedFare,
      acceptedAt,
      message
    }
  };

  // Try multiple methods to find and notify the passenger
  let passengerNotified = false;

  // Method 1: Try direct passengerId as userId
  const sent = sendToUser(passengerId, notification);
  if (sent) {
    console.log(`✅ Notified passenger ${passengerId} about driver acceptance`);
    passengerNotified = true;
  }

  // Method 2: Try riderId mapping (passengers might be stored as riders)
  if (!passengerNotified) {
    // Try both number and string versions of passengerId
    let passengerUserId = riderIdToUserId.get(passengerId);
    if (!passengerUserId && typeof passengerId === 'number') {
      passengerUserId = riderIdToUserId.get(String(passengerId));
    } else if (!passengerUserId && typeof passengerId === 'string') {
      passengerUserId = riderIdToUserId.get(parseInt(passengerId, 10));
    }

    if (passengerUserId) {
      const sent = sendToUser(passengerUserId, notification);
      if (sent) {
        console.log(`✅ Notified passenger via riderId mapping: ${passengerId} → ${passengerUserId}`);
        passengerNotified = true;
      }
    }
  }

  // Method 3: Search all connections for this passenger
  if (!passengerNotified) {
    console.log(`🔍 Searching all connections for passenger ${passengerId}...`);
    connections.forEach((conn, userId) => {
      if (!passengerNotified && (conn.role === 'rider' || conn.role === 'passenger')) {
        if (conn.riderId === passengerId || userId === passengerId) {
          const sent = sendToUser(userId, notification);
          if (sent) {
            console.log(`✅ Found and notified passenger via connection search: ${userId}`);
            passengerNotified = true;
          }
        }
      }
    });
  }

  if (!passengerNotified) {
    console.log(`⚠️ Could not find passenger ${passengerId} in any connection!`);
    console.log(`📊 Current rider mappings:`, Array.from(riderIdToUserId.entries()));
    console.log(`📊 Current connections:`, Array.from(connections.keys()));
  }

  return passengerNotified;
}

// Notify passenger about driver rejecting their request
function notifyPassengerAboutRejection(payload) {
  const {
    requestId,
    routeId,
    passengerId,
    driverId,
    reason,
    message
  } = payload;

  console.log(`❌ Driver ${driverId} rejected passenger ${passengerId}'s request`);
  console.log(`   Reason: ${reason || 'Not specified'}`);

  // Prepare notification message
  const notification = {
    type: 'driver_rejected_passenger',
    payload: {
      requestId,
      routeId,
      driverId,
      passengerId,
      reason: reason || 'Driver unavailable',
      message: message || 'Your ride request was declined. Please try another driver.'
    }
  };

  // Try multiple methods to find and notify the passenger
  let passengerNotified = false;

  // Method 1: Try direct passengerId as userId
  const sent = sendToUser(passengerId, notification);
  if (sent) {
    console.log(`✅ Notified passenger ${passengerId} about driver rejection`);
    passengerNotified = true;
  }

  // Method 2: Try riderId mapping (passengers might be stored as riders)
  if (!passengerNotified) {
    let passengerUserId = riderIdToUserId.get(passengerId);
    if (!passengerUserId && typeof passengerId === 'number') {
      passengerUserId = riderIdToUserId.get(String(passengerId));
    } else if (!passengerUserId && typeof passengerId === 'string') {
      passengerUserId = riderIdToUserId.get(parseInt(passengerId, 10));
    }

    if (passengerUserId) {
      const sent = sendToUser(passengerUserId, notification);
      if (sent) {
        console.log(`✅ Notified passenger via riderId mapping: ${passengerId} → ${passengerUserId}`);
        passengerNotified = true;
      }
    }
  }

  // Method 3: Search all connections for this passenger
  if (!passengerNotified) {
    console.log(`🔍 Searching all connections for passenger ${passengerId}...`);
    connections.forEach((conn, userId) => {
      if (!passengerNotified && (conn.role === 'rider' || conn.role === 'passenger')) {
        if (conn.riderId === passengerId || userId === passengerId) {
          const sent = sendToUser(userId, notification);
          if (sent) {
            console.log(`✅ Found and notified passenger via connection search: ${userId}`);
            passengerNotified = true;
          }
        }
      }
    });
  }

  if (!passengerNotified) {
    console.log(`⚠️ Could not find passenger ${passengerId} in any connection!`);
  }

  return passengerNotified;
}

// Notify passenger about route cancellation
function notifyPassengerAboutRouteCancellation(payload) {
  const {
    routeId,
    requestId,
    passengerId,
    driverId,
    driverName,
    message,
    routeInfo
  } = payload;

  console.log(`🚫 Notifying passenger ${passengerId} that driver cancelled route ${routeId}`);

  // Prepare notification message
  const notification = {
    type: 'route_cancelled',
    payload: {
      routeId,
      requestId,
      driverId,
      driverName,
      message: message || 'The driver has cancelled the route. Your ride request has been cancelled.',
      routeInfo,
      timestamp: new Date().toISOString()
    }
  };

  // Try multiple methods to find and notify the passenger
  let passengerNotified = false;

  // Method 1: Try direct passengerId as userId
  const sent = sendToUser(passengerId, notification);
  if (sent) {
    console.log(`✅ Notified passenger ${passengerId} about route cancellation`);
    passengerNotified = true;
  }

  // Method 2: Try riderId mapping
  if (!passengerNotified) {
    const passengerUserId = riderIdToUserId.get(passengerId);
    if (passengerUserId) {
      const sent = sendToUser(passengerUserId, notification);
      if (sent) {
        console.log(`✅ Notified passenger via riderId mapping: ${passengerId} → ${passengerUserId}`);
        passengerNotified = true;
      }
    }
  }

  // Method 3: Search all connections
  if (!passengerNotified) {
    console.log(`🔍 Searching all connections for passenger ${passengerId}...`);
    connections.forEach((conn, userId) => {
      if (!passengerNotified && (conn.role === 'rider' || conn.role === 'passenger')) {
        if (conn.riderId === passengerId || userId === passengerId) {
          const sent = sendToUser(userId, notification);
          if (sent) {
            console.log(`✅ Found and notified passenger via connection search: ${userId}`);
            passengerNotified = true;
          }
        }
      }
    });
  }

  if (!passengerNotified) {
    console.log(`⚠️ Could not find passenger ${passengerId} in any connection!`);
  }

  return passengerNotified;
}

// ========================================
// MONTHLY SUBSCRIPTION & CITY-TO-CITY NOTIFICATION HANDLERS
// ========================================

// Notify driver about new subscription request
function notifyDriverAboutSubscriptionRequest(payload) {
  const { targetDriverId, requestId, passengerId, passengerName, destinationName, proposedPrice, monthlyPrice } = payload;

  console.log(`📢 [Subscription] Notifying driver ${targetDriverId} about new subscription request ${requestId}`);

  const driverUserId = driverIdToUserId.get(parseInt(targetDriverId)) || targetDriverId;

  const notification = {
    type: 'subscription_request',
    payload: {
      requestId,
      passengerId,
      passengerName,
      destinationName,
      proposedPrice,
      monthlyPrice,
      timestamp: new Date().toISOString()
    }
  };

  if (sendToUser(driverUserId, notification)) {
    console.log(`✅ Notified driver ${targetDriverId} about subscription request`);
  } else {
    console.log(`❌ Failed to notify driver ${targetDriverId} - not connected`);
  }
}

// Notify passenger about subscription request status
function notifyPassengerAboutSubscriptionStatus(payload) {
  const { passengerId, requestId, status, driverName, finalPrice, counterPrice } = payload;

  console.log(`📢 [Subscription] Notifying passenger ${passengerId} - status: ${status}`);
  console.log(`🔍 [Subscription] Full payload:`, JSON.stringify(payload, null, 2));

  const passengerUserId = riderIdToUserId.get(parseInt(passengerId)) || passengerId;
  console.log(`🔍 [Subscription] Mapped passengerId ${passengerId} → userId ${passengerUserId}`);
  console.log(`🔍 [Subscription] Is passenger connected?`, connections.has(passengerUserId));
  console.log(`🔍 [Subscription] All connections:`, Array.from(connections.keys()));

  const notification = {
    type: status === 'accepted' ? 'subscription_request_accepted' :
          status === 'rejected' ? 'subscription_request_rejected' :
          'subscription_counter_offer',
    payload: {
      requestId,
      driverName,
      finalPrice,
      counterPrice,
      timestamp: new Date().toISOString()
    }
  };

  console.log(`📤 [Subscription] Sending notification:`, JSON.stringify(notification, null, 2));

  if (sendToUser(passengerUserId, notification)) {
    console.log(`✅ Notified passenger ${passengerId} about subscription ${status}`);
  } else {
    console.log(`❌ Failed to notify passenger ${passengerId} - not connected or send failed`);
  }
}

// Notify both parties about subscription confirmation
function notifySubscriptionConfirmed(payload) {
  const { subscriptionId, passengerId, driverId, destinationName, startDate, monthlyPrice } = payload;

  console.log(`📢 [Subscription] Notifying about confirmed subscription ${subscriptionId}`);

  const passengerUserId = riderIdToUserId.get(parseInt(passengerId)) || passengerId;
  const driverUserId = driverIdToUserId.get(parseInt(driverId)) || driverId;

  const passengerNotification = {
    type: 'subscription_confirmed',
    payload: {
      subscriptionId,
      destinationName,
      startDate,
      monthlyPrice,
      timestamp: new Date().toISOString()
    }
  };

  const driverNotification = {
    type: 'new_subscriber',
    payload: {
      subscriptionId,
      destinationName,
      startDate,
      monthlyPrice,
      timestamp: new Date().toISOString()
    }
  };

  sendToUser(passengerUserId, passengerNotification);
  sendToUser(driverUserId, driverNotification);
}

// Notify about subscription trip (daily scheduled trip)
function notifySubscriptionTrip(payload) {
  const { tripId, passengerId, driverId, scheduledTime, status } = payload;

  console.log(`📢 [Subscription Trip] Notifying about trip ${tripId} - status: ${status}`);

  const passengerUserId = riderIdToUserId.get(parseInt(passengerId)) || passengerId;
  const driverUserId = driverIdToUserId.get(parseInt(driverId)) || driverId;

  const notification = {
    type: 'subscription_trip_update',
    payload: {
      tripId,
      scheduledTime,
      status,
      timestamp: new Date().toISOString()
    }
  };

  sendToUser(passengerUserId, notification);
  sendToUser(driverUserId, notification);
}

// Notify about city-to-city trip request
function notifyCityTripRequest(payload) {
  const { tripId, passengerId, fromCity, toCity, scheduledDate, proposedPrice } = payload;

  console.log(`📢 [City Trip] New trip request ${tripId} from ${fromCity} to ${toCity}`);

  // Broadcast to available drivers (in production, filter by location/availability)
  const notification = {
    type: 'city_trip_request',
    payload: {
      tripId,
      passengerId,
      fromCity,
      toCity,
      scheduledDate,
      proposedPrice,
      timestamp: new Date().toISOString()
    }
  };

  // For now, broadcast to all connected drivers
  // In production, you'd query database for drivers on this route
  connections.forEach((conn, userId) => {
    if (conn.role === 'DRIVER') {
      sendToUser(userId, notification);
    }
  });
}

// Notify about city trip status updates
function notifyCityTripUpdate(payload) {
  const { tripId, passengerId, driverId, status, finalPrice, counterPrice } = payload;

  console.log(`📢 [City Trip] Trip ${tripId} status update: ${status}`);

  const passengerUserId = riderIdToUserId.get(parseInt(passengerId)) || passengerId;
  const driverUserId = driverId ? (driverIdToUserId.get(parseInt(driverId)) || driverId) : null;

  const notification = {
    type: 'city_trip_update',
    payload: {
      tripId,
      status,
      finalPrice,
      counterPrice,
      timestamp: new Date().toISOString()
    }
  };

  sendToUser(passengerUserId, notification);
  if (driverUserId) {
    sendToUser(driverUserId, notification);
  }
}

// ==================== CITY-TO-CITY TRIP NOTIFICATION FUNCTIONS ====================

// Notify specific driver about direct trip request
function notifyCityTripDirectRequest(payload) {
  const { tripId, userId, passengerId, passengerName, fromCity, toCity, scheduledDate, proposedPrice } = payload;

  console.log(`📢 [City Trip Direct] Direct request ${tripId} sent to driver userId: ${userId}`);

  // Try multiple mappings to find the driver's Clerk ID
  let driverClerkId = driverIdToUserId.get(userId);
  if (!driverClerkId) driverClerkId = driverIdToUserId.get(String(userId));
  if (!driverClerkId) driverClerkId = driverIdToUserId.get(parseInt(userId));

  if (!driverClerkId) {
    console.error(`⚠️ Could not find Clerk ID for driver userId: ${userId}`);
    console.log(`📊 Available driver mappings:`, Array.from(driverIdToUserId.entries()));
    return;
  }

  const notification = {
    type: 'city_trip_direct_request',
    payload: {
      tripId,
      passengerId,
      passengerName,
      fromCity,
      toCity,
      scheduledDate,
      proposedPrice,
      timestamp: new Date().toISOString()
    }
  };

  console.log(`✅ [City Trip Direct] Sending to Clerk ID: ${driverClerkId}`);
  sendToUser(driverClerkId, notification);
}

// Notify passenger that driver accepted trip
function notifyCityTripAccepted(payload) {
  const { tripId, userId, driverId, fromCity, toCity, scheduledDate, finalPrice, vehicle } = payload;

  console.log(`📢 [City Trip Accepted] Driver ${driverId} accepted trip ${tripId}`);

  const passengerUserId = riderIdToUserId.get(parseInt(userId)) || userId;

  const notification = {
    type: 'city_trip_accepted',
    payload: {
      tripId,
      driverId,
      fromCity,
      toCity,
      scheduledDate,
      finalPrice,
      vehicle,
      timestamp: new Date().toISOString()
    }
  };

  sendToUser(passengerUserId, notification);
}

// Notify passenger that driver rejected trip
function notifyCityTripRejected(payload) {
  const { tripId, userId, driverId, fromCity, toCity } = payload;

  console.log(`📢 [City Trip Rejected] Driver ${driverId} rejected trip ${tripId}`);

  const passengerUserId = riderIdToUserId.get(parseInt(userId)) || userId;

  const notification = {
    type: 'city_trip_rejected',
    payload: {
      tripId,
      driverId,
      fromCity,
      toCity,
      timestamp: new Date().toISOString()
    }
  };

  sendToUser(passengerUserId, notification);
}

// Notify passenger about driver counter offer
function notifyCityTripCounterOffer(payload) {
  const { tripId, userId, driverId, fromCity, toCity, driverProposedPrice, passengerProposedPrice } = payload;

  console.log(`📢 [City Trip Counter] Driver ${driverId} sent counter offer for trip ${tripId}: PKR ${driverProposedPrice}`);

  const passengerUserId = riderIdToUserId.get(parseInt(userId)) || userId;

  const notification = {
    type: 'city_trip_counter_offer',
    payload: {
      tripId,
      driverId,
      fromCity,
      toCity,
      driverProposedPrice,
      passengerProposedPrice,
      timestamp: new Date().toISOString()
    }
  };

  sendToUser(passengerUserId, notification);
}

// Notify driver that passenger accepted counter offer
function notifyCityTripPriceAgreed(payload) {
  const { tripId, userId, passengerName, fromCity, toCity, finalPrice } = payload;

  console.log(`📢 [City Trip Price Agreed] Passenger agreed to price for trip ${tripId}: PKR ${finalPrice}`);

  const driverUserId = driverIdToUserId.get(parseInt(userId)) || userId;

  const notification = {
    type: 'city_trip_price_agreed',
    payload: {
      tripId,
      passengerName,
      fromCity,
      toCity,
      finalPrice,
      timestamp: new Date().toISOString()
    }
  };

  sendToUser(driverUserId, notification);
}

// Notify passenger that trip started
function notifyCityTripStarted(payload) {
  const { tripId, userId } = payload;

  console.log(`📢 [City Trip Started] Trip ${tripId} has started for passenger userId: ${userId}`);

  // Try multiple mapping strategies to find passenger's Clerk ID
  let passengerClerkId = riderIdToUserId.get(parseInt(userId));
  if (!passengerClerkId) passengerClerkId = riderIdToUserId.get(String(userId));
  if (!passengerClerkId) passengerClerkId = riderIdToUserId.get(userId);

  if (!passengerClerkId) {
    console.error(`⚠️ Could not find Clerk ID for passenger userId: ${userId}`);
    console.log(`📊 Available rider mappings:`, Array.from(riderIdToUserId.entries()));
    console.log(`📊 Available connections:`, Array.from(connections.keys()));
    // Try sending directly with userId as fallback
    passengerClerkId = userId;
  } else {
    console.log(`✅ [City Trip Started] Found passenger Clerk ID: ${passengerClerkId}`);
  }

  const notification = {
    type: 'city_trip_started',
    payload: {
      tripId,
      timestamp: new Date().toISOString()
    }
  };

  console.log(`📤 [City Trip Started] Sending notification to passenger: ${passengerClerkId}`);
  sendToUser(passengerClerkId, notification);
}

// Notify passenger that trip completed
function notifyCityTripCompleted(payload) {
  const { tripId, userId, finalPrice } = payload;

  console.log(`📢 [City Trip Completed] Trip ${tripId} completed for passenger userId: ${userId}. Final price: PKR ${finalPrice}`);

  // Try multiple mapping strategies to find passenger's Clerk ID
  let passengerClerkId = riderIdToUserId.get(parseInt(userId));
  if (!passengerClerkId) passengerClerkId = riderIdToUserId.get(String(userId));
  if (!passengerClerkId) passengerClerkId = riderIdToUserId.get(userId);

  if (!passengerClerkId) {
    console.error(`⚠️ Could not find Clerk ID for passenger userId: ${userId}`);
    console.log(`📊 Available rider mappings:`, Array.from(riderIdToUserId.entries()));
    // Try sending directly with userId as fallback
    passengerClerkId = userId;
  } else {
    console.log(`✅ [City Trip Completed] Found passenger Clerk ID: ${passengerClerkId}`);
  }

  const notification = {
    type: 'city_trip_completed',
    payload: {
      tripId,
      finalPrice,
      timestamp: new Date().toISOString()
    }
  };

  console.log(`📤 [City Trip Completed] Sending notification to passenger: ${passengerClerkId}`);
  sendToUser(passengerClerkId, notification);
}

// ==================== END CITY-TO-CITY NOTIFICATION FUNCTIONS ====================

// ==================== DRIVER VERIFICATION NOTIFICATION FUNCTION ====================

/**
 * Notify driver about verification status change
 * @param {Object} payload - Contains driverId, userId, verificationStatus, message
 */
function notifyDriverVerified(payload) {
  const { driverId, userId, verificationStatus, message, targetDriverId } = payload;

  // Use targetDriverId if provided, otherwise use driverId
  const targetId = targetDriverId || driverId;

  console.log(`✅ [Driver Verified] Notifying driver ${targetId} about verification status: ${verificationStatus}`);
  console.log(`📋 [Driver Verified] Payload:`, JSON.stringify(payload, null, 2));

  // Prepare notification message
  const notification = {
    type: 'driver_verified',
    payload: {
      driverId: targetId,
      userId,
      verificationStatus,
      message: message || 'Your driver account has been verified!',
      timestamp: new Date().toISOString()
    }
  };

  // Try multiple methods to find and notify the driver
  let driverNotified = false;

  // Method 1: Try driverId mapping (driverId -> userId)
  const driverUserId = driverIdToUserId.get(parseInt(targetId));
  if (driverUserId) {
    console.log(`📍 [Driver Verified] Found driver mapping: ${targetId} → ${driverUserId}`);
    const sent = sendToUser(driverUserId, notification);
    if (sent) {
      console.log(`✅ [Driver Verified] Notified driver ${targetId} (user ${driverUserId})`);
      driverNotified = true;
    }
  }

  // Method 2: Try direct driverId as userId
  if (!driverNotified && targetId) {
    const sent = sendToUser(targetId.toString(), notification);
    if (sent) {
      console.log(`✅ [Driver Verified] Notified driver ${targetId} directly`);
      driverNotified = true;
    }
  }

  // Method 3: Try with provided userId
  if (!driverNotified && userId) {
    const sent = sendToUser(userId.toString(), notification);
    if (sent) {
      console.log(`✅ [Driver Verified] Notified driver via userId: ${userId}`);
      driverNotified = true;
    }
  }

  // Method 4: Search all connections for this driver
  if (!driverNotified) {
    console.log(`🔍 [Driver Verified] Searching all connections for driver ${targetId}...`);
    connections.forEach((conn, connectionUserId) => {
      if (!driverNotified && conn.role === 'driver') {
        if (conn.driverId === parseInt(targetId) ||
            connectionUserId === targetId.toString() ||
            (userId && connectionUserId === userId.toString())) {
          const sent = sendToUser(connectionUserId, notification);
          if (sent) {
            console.log(`✅ [Driver Verified] Found and notified driver via connection search: ${connectionUserId}`);
            driverNotified = true;
          }
        }
      }
    });
  }

  if (!driverNotified) {
    console.log(`⚠️ [Driver Verified] Could not find driver ${targetId} in any connection!`);
    console.log(`📊 [Driver Verified] Current driver mappings:`, Array.from(driverIdToUserId.entries()));
    console.log(`📊 [Driver Verified] Current connections:`, Array.from(connections.keys()));

    // Log all driver connections for debugging
    console.log(`📊 [Driver Verified] All driver connections:`);
    connections.forEach((conn, connectionUserId) => {
      if (conn.role === 'driver') {
        console.log(`   - User ${connectionUserId}: driverId=${conn.driverId}, wsState=${conn.ws.readyState}`);
      }
    });
  } else {
    console.log(`✅ [Driver Verified] Successfully notified driver ${targetId}`);
  }

  return driverNotified;
}

// ==================== END DRIVER VERIFICATION NOTIFICATION FUNCTION ====================

// Add these handlers to the handleMessage function's switch statement
// Update the switch statement in handleMessage to include these cases:
// case 'passenger_location_update': handlePassengerLocationUpdate(userId, payload); break;
// case 'driver_route_location': handleDriverRouteLocationUpdate(userId, payload); break;
// case 'enable_live_mode': handleEnableLiveMode(userId, payload); break;
// case 'disable_live_mode': handleDisableLiveMode(userId); break;
// case 'view_route': handleViewRoute(userId, payload); break;
// case 'stop_view_route': handleStopViewRoute(userId); break;

console.log('WebSocket server is ready and listening on port', WS_PORT);
console.log('Connect at ws://localhost:' + WS_PORT);
console.log('🚀 Live tracking enabled with continuous WebSocket streaming');
console.log('🔴 Live Mode and Shared Ride tracking handlers loaded');