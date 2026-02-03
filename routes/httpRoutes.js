/**
 * HTTP Routes Module
 * Handles HTTP endpoints for the WebSocket server
 */

const { NOTIFY_API_KEY, RATE_LIMITS, CONNECTION_TIMEOUT, HEARTBEAT_INTERVAL } = require('../config/constants');

// Will be initialized from main server
let getConnectionStats = null;
let getRateLimitStats = null;

// Handler references (set via init)
let handlers = {};

/**
 * Initialize HTTP routes with dependencies
 */
function init(deps) {
  getConnectionStats = deps.getConnectionStats;
  getRateLimitStats = deps.getRateLimitStats;
  handlers = deps.handlers;
}

/**
 * Middleware to verify API key for /notify endpoint
 */
function verifyNotifyApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

  if (!apiKey) {
    console.warn('/notify request rejected: Missing API key');
    return res.status(401).json({ error: 'API key required' });
  }

  if (apiKey !== NOTIFY_API_KEY) {
    console.warn('/notify request rejected: Invalid API key');
    return res.status(403).json({ error: 'Invalid API key' });
  }

  next();
}

/**
 * Setup HTTP routes on Express app
 * @param {Express} app - Express application
 */
function setupRoutes(app) {
  // Stats endpoint for monitoring connection health
  app.get('/stats', (req, res) => {
    const stats = getConnectionStats();
    const rateLimitStats = getRateLimitStats();

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      connections: stats,
      rateLimits: rateLimitStats,
      config: {
        maxConnectionsPerUser: RATE_LIMITS.MAX_CONNECTIONS_PER_USER,
        maxTotalConnections: RATE_LIMITS.MAX_TOTAL_CONNECTIONS,
        connectionTimeoutMs: CONNECTION_TIMEOUT,
        heartbeatIntervalMs: HEARTBEAT_INTERVAL,
      }
    });
  });

  // Health check endpoint
  app.get('/health', (req, res) => {
    const stats = getConnectionStats();
    res.json({
      status: 'healthy',
      service: 'websocket-server',
      uptime: process.uptime(),
      connections: stats.totalConnections,
    });
  });

  // HTTP endpoint for backend to send notifications
  app.post('/notify', verifyNotifyApiKey, (req, res) => {
    const { type, payload } = req.body;

    switch (type) {
      case 'new_trip_request':
        handlers.broadcastToDrivers(payload);
        res.json({ success: true, message: 'Notification sent to drivers' });
        break;

      case 'new_bid':
        handlers.notifyRiderAboutBid(payload);
        res.json({ success: true, message: 'Bid notification sent to rider' });
        break;

      case 'bid_accepted':
        handlers.notifyDriverBidAccepted(payload);
        res.json({ success: true, message: 'Bid acceptance notification sent to driver' });
        break;

      case 'bid_rejected':
        handlers.notifyDriverBidRejected(payload);
        res.json({ success: true, message: 'Bid rejection notification sent to driver' });
        break;

      case 'passenger_ready':
        handlers.notifyPassengerReady(payload.riderId, payload);
        res.json({ success: true, message: 'Passenger ready notification sent to driver' });
        break;

      case 'start_live_tracking':
        console.log('Starting live tracking:', payload);
        handlers.startLiveTracking('api-server', payload);
        res.json({ success: true, message: 'Live tracking started' });
        break;

      case 'trip_started':
        handlers.notifyTripStarted(payload.driverId, payload);
        res.json({ success: true, message: 'Trip started notification sent to rider' });
        break;

      case 'trip_cancelled':
        handlers.notifyTripCancelled(payload);
        res.json({ success: true, message: 'Trip cancelled notification sent' });
        break;

      case 'trip_completed':
        handlers.notifyTripCompleted(payload.riderId, payload);
        res.json({ success: true, message: 'Trip completed notification sent' });
        break;

      case 'driver_arrived':
        handlers.notifyDriverArrived(payload.riderId, payload);
        res.json({ success: true, message: 'Driver arrived notification sent' });
        break;

      case 'driver_location_update':
        handlers.broadcastDriverLocationUpdate(payload);
        res.json({ success: true, message: 'Driver location update sent to passenger' });
        break;

      case 'passenger_ride_request':
        handlers.notifyDriverAboutPassengerRequest(payload);
        res.json({ success: true, message: 'Passenger request notification sent to driver' });
        break;

      case 'passenger_request_cancelled':
        handlers.notifyDriverAboutRequestCancellation(payload);
        res.json({ success: true, message: 'Cancellation notification sent to driver' });
        break;

      case 'driver_accepted_request':
        handlers.notifyPassengerAboutAcceptance(payload);
        res.json({ success: true, message: 'Acceptance notification sent to passenger' });
        break;

      case 'driver_rejected_request':
      case 'passenger_request_rejected':
        handlers.notifyPassengerAboutRejection(payload);
        res.json({ success: true, message: 'Rejection notification sent to passenger' });
        break;

      case 'route_cancelled':
        handlers.notifyPassengerAboutRouteCancellation(payload);
        res.json({ success: true, message: 'Route cancellation notification sent to passenger' });
        break;

      case 'subscription_request':
        handlers.notifyDriverAboutSubscriptionRequest(payload);
        res.json({ success: true, message: 'Subscription request notification sent to driver' });
        break;

      case 'subscription_status':
        handlers.notifyPassengerAboutSubscriptionStatus(payload);
        res.json({ success: true, message: 'Subscription status notification sent to passenger' });
        break;

      case 'subscription_confirmed':
        handlers.notifySubscriptionConfirmed(payload);
        res.json({ success: true, message: 'Subscription confirmation sent to both parties' });
        break;

      case 'subscription_trip_update':
        handlers.notifySubscriptionTrip(payload);
        res.json({ success: true, message: 'Subscription trip notification sent' });
        break;

      case 'city_trip_request':
        handlers.notifyCityTripRequest(payload);
        res.json({ success: true, message: 'City trip request broadcasted to drivers' });
        break;

      case 'city_trip_direct_request':
        handlers.notifyCityTripDirectRequest(payload);
        res.json({ success: true, message: 'City trip direct request sent to driver' });
        break;

      case 'city_trip_accepted':
        handlers.notifyCityTripAccepted(payload);
        res.json({ success: true, message: 'City trip accepted notification sent' });
        break;

      case 'city_trip_rejected':
        handlers.notifyCityTripRejected(payload);
        res.json({ success: true, message: 'City trip rejected notification sent' });
        break;

      case 'city_trip_counter_offer':
        handlers.notifyCityTripCounterOffer(payload);
        res.json({ success: true, message: 'City trip counter offer sent to passenger' });
        break;

      case 'city_trip_price_agreed':
        handlers.notifyCityTripPriceAgreed(payload);
        res.json({ success: true, message: 'City trip price agreed notification sent to driver' });
        break;

      case 'city_trip_started':
        handlers.notifyCityTripStarted(payload);
        res.json({ success: true, message: 'City trip started notification sent' });
        break;

      case 'city_trip_completed':
        handlers.notifyCityTripCompleted(payload);
        res.json({ success: true, message: 'City trip completed notification sent' });
        break;

      case 'city_trip_update':
        handlers.notifyCityTripUpdate(payload);
        res.json({ success: true, message: 'City trip update notification sent' });
        break;

      case 'driver_verified':
        handlers.notifyDriverVerified(payload);
        res.json({ success: true, message: 'Driver verification notification sent' });
        break;

      default:
        res.status(400).json({ error: 'Unknown notification type: ' + type });
    }
  });
}

module.exports = {
  init,
  setupRoutes,
  verifyNotifyApiKey,
};
