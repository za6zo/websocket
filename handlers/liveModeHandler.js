/**
 * Live Mode Handler Module
 * Handles Live Mode, Shared Ride, and real-time tracking functions
 */

const { setTripDestination, getTripDestination, calculateETA } = require('../utils/locationUtils');

// Live mode state
const liveTrackingSessions = new Map(); // tripId -> { driverId, riderId, startTime, isActive }
const liveModeDrivers = new Map(); // driverId -> { location, passengers: Set() }
const activeRouteDrivers = new Map(); // routeId -> { driverId, location }
const passengerLocations = new Map(); // passengerId -> { location, timestamp }

// Will be initialized from main server
let connections = null;
let tripConnections = null;
let sendToUser = null;
let driverIdToUserId = null;
let riderIdToUserId = null;
let joinTrip = null;

/**
 * Initialize live mode handler with shared state
 */
function init(deps) {
  connections = deps.connections;
  tripConnections = deps.tripConnections;
  sendToUser = deps.sendToUser;
  driverIdToUserId = deps.driverIdToUserId;
  riderIdToUserId = deps.riderIdToUserId;
  joinTrip = deps.joinTrip;
}

/**
 * Start continuous live tracking for a trip
 * @param {string} userId - User ID
 * @param {object} payload - Tracking payload
 */
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
  if (joinTrip) {
    joinTrip(driverId, tripId);
    joinTrip(riderId, tripId);
  }

  console.log(`Started live tracking for trip ${tripId}`);

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

/**
 * Stop live tracking for a trip
 * @param {string} userId - User ID
 * @param {object} payload - Stop tracking payload
 */
function stopLiveTracking(userId, payload) {
  const { tripId } = payload;
  const session = liveTrackingSessions.get(tripId);

  if (!session) return;

  session.isActive = false;
  liveTrackingSessions.delete(tripId);

  console.log(`Stopped live tracking for trip ${tripId}`);

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

/**
 * Enhanced location update for continuous tracking
 * @param {string} userId - User ID
 * @param {object} payload - Location payload
 */
function broadcastLiveLocation(userId, payload) {
  const userConn = connections.get(userId);
  if (!userConn) {
    console.log(`No connection found for user ${userId}`);
    return;
  }

  // Get tripId from payload or user connection
  const tripId = payload.tripId || userConn.tripId;
  if (!tripId) {
    console.log(`No tripId found for location update from ${userId}`);
    return;
  }

  // Check if live tracking session exists, if not create one
  let session = liveTrackingSessions.get(tripId);
  if (!session) {
    console.log(`No tracking session for trip ${tripId}, creating one`);
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

  // Calculate ETA if this is a driver location update
  let eta = null;
  if (userConn.role === 'driver') {
    const destination = getTripDestination(tripId);
    if (destination) {
      eta = calculateETA(userConn.location, destination);
    }
  }

  // Store pickup/dropoff locations if provided in payload
  if (payload.pickupLocation && payload.dropoffLocation) {
    setTripDestination(tripId, payload.pickupLocation, payload.dropoffLocation);
  }

  // Build the location payload with ETA
  const locationPayload = {
    tripId,
    location: userConn.location,
    userId,
    role: userConn.role,
    eta,
    timestamp: new Date().toISOString()
  };

  // Get trip users
  const tripUsers = tripConnections.get(tripId);
  if (!tripUsers || tripUsers.size === 0) {
    // Fallback: broadcast to all connections that might be interested
    connections.forEach((conn, uid) => {
      if (uid !== userId && (conn.tripId === tripId || uid === session.riderId)) {
        sendToUser(uid, {
          type: userConn.role === 'driver' ? 'driver_live_location' : 'rider_live_location',
          payload: locationPayload
        });
        sendToUser(uid, { type: 'user_location', payload: locationPayload });
      }
    });
    return;
  }

  // Broadcast to all trip participants immediately
  tripUsers.forEach(otherUserId => {
    if (otherUserId !== userId) {
      sendToUser(otherUserId, {
        type: userConn.role === 'driver' ? 'driver_live_location' : 'rider_live_location',
        payload: locationPayload
      });
      sendToUser(otherUserId, { type: 'user_location', payload: locationPayload });
    }
  });

  // Send acknowledgment back to sender
  sendToUser(userId, {
    type: 'location_ack',
    payload: { tripId, timestamp: userConn.location.timestamp, eta }
  });
}

/**
 * Handle passenger location update (for Live Mode)
 * @param {string} passengerId - Passenger ID
 * @param {object} payload - Location payload
 */
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

  console.log(`Passenger ${passengerId} location update: ${latitude}, ${longitude}`);

  // If driver is in live mode, broadcast to them
  if (driverId) {
    const driverUserId = driverIdToUserId.get(driverId);
    if (driverUserId) {
      sendToUser(driverUserId, {
        type: 'passenger_location_update',
        payload: {
          passengerId,
          location: { latitude, longitude, heading: heading || 0, speed: speed || 0 },
          timestamp: new Date().toISOString()
        }
      });
      console.log(`Sent passenger location to driver ${driverId}`);
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
          location: { latitude, longitude, heading: heading || 0, speed: speed || 0 },
          timestamp: new Date().toISOString()
        }
      });
    }
  }
}

/**
 * Handle driver route location update (for Shared Ride tracking)
 * @param {string} driverId - Driver ID
 * @param {object} payload - Location payload
 */
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

    console.log(`Driver ${driverId} route location: ${latitude}, ${longitude}`);

    // Broadcast to all passengers viewing this route
    connections.forEach((conn, userId) => {
      if (conn.role === 'rider' && conn.viewingRouteId === routeId) {
        sendToUser(userId, {
          type: 'driver_route_location',
          payload: {
            routeId,
            driverId,
            location: { latitude, longitude, heading: heading || 0, speed: speed || 0 },
            timestamp: new Date().toISOString()
          }
        });
      }
    });
  }
}

/**
 * Handle live mode enable (driver side)
 * @param {string} driverId - Driver ID
 * @param {object} payload - Enable payload
 */
function handleEnableLiveMode(driverId, payload) {
  const { sessionId } = payload;

  console.log(`Driver ${driverId} enabled Live Mode`);

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
      payload: { sessionId, timestamp: new Date().toISOString() }
    });
  }
}

/**
 * Handle live mode disable (driver side)
 * @param {string} driverId - Driver ID
 */
function handleDisableLiveMode(driverId) {
  console.log(`Driver ${driverId} disabled Live Mode`);

  liveModeDrivers.delete(driverId);

  // Confirm to driver
  const driverUserId = driverIdToUserId.get(driverId);
  if (driverUserId) {
    sendToUser(driverUserId, {
      type: 'live_mode_disabled',
      payload: { timestamp: new Date().toISOString() }
    });
  }
}

/**
 * Handle passenger viewing a driver's route (for real-time updates)
 * @param {string} passengerId - Passenger ID
 * @param {object} payload - View route payload
 */
function handleViewRoute(passengerId, payload) {
  const { routeId } = payload;

  console.log(`Passenger ${passengerId} viewing route ${routeId}`);

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

/**
 * Handle passenger stop viewing route
 * @param {string} passengerId - Passenger ID
 */
function handleStopViewRoute(passengerId) {
  const passengerConn = connections.get(passengerId);
  if (passengerConn) {
    console.log(`Passenger ${passengerId} stopped viewing route`);
    passengerConn.viewingRouteId = null;
  }
}

/**
 * Get live tracking sessions map
 * @returns {Map} Live tracking sessions
 */
function getLiveTrackingSessions() {
  return liveTrackingSessions;
}

module.exports = {
  init,
  startLiveTracking,
  stopLiveTracking,
  broadcastLiveLocation,
  handlePassengerLocationUpdate,
  handleDriverRouteLocationUpdate,
  handleEnableLiveMode,
  handleDisableLiveMode,
  handleViewRoute,
  handleStopViewRoute,
  getLiveTrackingSessions,
  liveTrackingSessions,
  liveModeDrivers,
  activeRouteDrivers,
  passengerLocations,
};
