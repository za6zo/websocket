/**
 * Trip Handler Module
 * Handles trip-related WebSocket functions: join, leave, location updates, notifications
 */

const { setTripDestination, updateTripStatus, getTripDestination, calculateETA } = require('../utils/locationUtils');

// Will be initialized from main server
let connections = null;
let tripConnections = null;
let sendToUser = null;
let driverIdToUserId = null;
let riderIdToUserId = null;

/**
 * Initialize trip handler with shared state
 */
function init(deps) {
  connections = deps.connections;
  tripConnections = deps.tripConnections;
  sendToUser = deps.sendToUser;
  driverIdToUserId = deps.driverIdToUserId;
  riderIdToUserId = deps.riderIdToUserId;
}

/**
 * Join a trip room
 * @param {string} userId - User ID
 * @param {string} tripId - Trip ID
 */
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

/**
 * Leave a trip room
 * @param {string} userId - User ID
 * @param {string} tripId - Trip ID
 */
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

/**
 * Broadcast to all users in a trip
 * @param {string} tripId - Trip ID
 * @param {object} message - Message to send
 * @param {string} excludeUserId - Optional user to exclude
 */
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

/**
 * Notify trip accepted
 * @param {string} driverId - Driver ID
 * @param {object} payload - Trip acceptance payload
 */
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

/**
 * Notify trip started
 * @param {string} driverId - Driver ID
 * @param {object} payload - Trip start payload
 */
function notifyTripStarted(driverId, payload) {
  const { tripId, riderId, startLocation, pickupLocation, dropoffLocation } = payload;

  console.log(`Trip ${tripId} started by driver ${driverId}`);

  // Update trip status for ETA calculation (now targets dropoff)
  updateTripStatus(tripId, 'IN_PROGRESS');

  // Store/update destinations if provided
  if (pickupLocation && dropoffLocation) {
    setTripDestination(tripId, pickupLocation, dropoffLocation);
  }

  const tripPayload = {
    tripId,
    driverId,
    startLocation,
    pickupLocation,
    dropoffLocation,
    pickup_location: pickupLocation,
    dropoff_location: dropoffLocation,
    destinationLocation: dropoffLocation,
    timestamp: new Date().toISOString()
  };

  // Notify the rider specifically
  if (riderId) {
    sendToUser(riderId, { type: 'trip_started', payload: tripPayload });
    sendToUser(riderId, { type: 'tripStarted', payload: tripPayload }); // Compatibility
    console.log(`Notified rider ${riderId} that trip has started`);
  }

  // Also broadcast to all trip participants
  broadcastToTrip(tripId, {
    type: 'trip_started',
    payload: { ...tripPayload, startedBy: driverId }
  }, driverId);
}

/**
 * Notify trip completed
 * @param {string} userId - User ID
 * @param {object} payload - Trip completion payload
 */
function notifyTripCompleted(userId, payload) {
  const { tripId, fare, riderId, tripRequestId } = payload;

  console.log(`Trip ${tripId} completed by user ${userId}`);

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

  // Notify the rider directly
  if (riderId) {
    const riderNotified = sendToUser(riderId, completionMessage);
    if (!riderNotified) {
      // Try fallback via connection search
      connections.forEach((conn, uid) => {
        if (conn.riderId === riderId || uid === riderId) {
          sendToUser(uid, completionMessage);
        }
      });
    }
  }

  // Broadcast to trip room
  broadcastToTrip(tripId, completionMessage);

  // If we have a trip request ID, try that room too
  if (tripRequestId && tripRequestId !== tripId) {
    broadcastToTrip(tripRequestId, completionMessage);
  }

  // Clean up trip connections after a delay
  setTimeout(() => {
    const tripUsers = tripConnections.get(tripId);
    if (tripUsers) {
      tripUsers.forEach(uid => {
        const conn = connections.get(uid);
        if (conn) conn.tripId = null;
      });
      tripConnections.delete(tripId);
      console.log(`Cleaned up trip room ${tripId}`);
    }
  }, 2000);
}

/**
 * Notify trip cancelled
 * @param {object} payload - Cancellation payload
 */
function notifyTripCancelled(payload) {
  const { tripId, tripRequestId, driverId, driverDbId, riderId, reason, cancelledBy } = payload;

  console.log(`Trip cancelled:`, { tripId, tripRequestId, driverId, riderId, reason, cancelledBy });

  const cancellationMessage = {
    type: 'trip_cancelled',
    payload: {
      tripId,
      tripRequestId,
      reason: reason || 'Trip has been cancelled',
      cancelledBy: cancelledBy || 'passenger',
      timestamp: new Date().toISOString()
    }
  };

  // Notify the driver
  if (driverId || driverDbId) {
    const driverIdsToTry = [];
    if (driverId) driverIdsToTry.push(driverId);
    if (driverDbId && driverDbId !== driverId) driverIdsToTry.push(driverDbId);

    let driverNotified = false;
    for (const id of driverIdsToTry) {
      if (driverNotified) break;

      const mappedUserId = driverIdToUserId.get(id);
      if (mappedUserId) {
        const sent = sendToUser(mappedUserId, cancellationMessage);
        if (sent) driverNotified = true;
      }

      if (!driverNotified) {
        const sent = sendToUser(id, cancellationMessage);
        if (sent) driverNotified = true;
      }
    }

    // Search all connections as fallback
    if (!driverNotified) {
      connections.forEach((conn, userId) => {
        if (!driverNotified && conn.role === 'driver') {
          const matches = driverIdsToTry.some(id => conn.driverId === id || userId === id);
          if (matches) {
            sendToUser(userId, cancellationMessage);
            driverNotified = true;
          }
        }
      });
    }
  }

  // Notify the rider
  if (riderId) {
    sendToUser(riderId, cancellationMessage);
  }

  // Broadcast to trip rooms
  if (tripId) broadcastToTrip(tripId, cancellationMessage);
  if (tripRequestId && tripRequestId !== tripId) {
    broadcastToTrip(tripRequestId, cancellationMessage);
  }

  // If no specific driver, broadcast to all drivers
  if (!driverId) {
    connections.forEach((conn, userId) => {
      if (conn.role === 'driver') {
        sendToUser(userId, cancellationMessage);
      }
    });
  }
}

/**
 * Notify driver arrived
 * @param {string} driverId - Driver ID
 * @param {object} payload - Arrival payload
 */
function notifyDriverArrived(driverId, payload) {
  const { tripId, riderId, driverLocation, message } = payload;

  console.log(`Driver ${driverId} arrived for rider ${riderId} on trip ${tripId}`);

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
  let riderNotified = sendToUser(riderId, riderNotification);

  // If that fails, try to find rider by trip connections
  if (!riderNotified && tripId) {
    const tripUsers = tripConnections.get(tripId);
    if (tripUsers) {
      tripUsers.forEach(userId => {
        const conn = connections.get(userId);
        if (conn && conn.role === 'rider') {
          riderNotified = sendToUser(userId, riderNotification);
        }
      });
    }
  }

  // Fallback: broadcast to all riders
  if (!riderNotified) {
    connections.forEach((conn, userId) => {
      if (conn.role === 'rider' && (conn.riderId === riderId || userId === riderId)) {
        sendToUser(userId, riderNotification);
      }
    });
  }

  // Send confirmation to driver
  const driverConfirmation = {
    type: 'arrival_confirmed',
    payload: { tripId, timestamp: new Date().toISOString() }
  };

  const driverNotified = sendToUser(driverId, driverConfirmation);
  if (!driverNotified) {
    connections.forEach((conn, userId) => {
      if (conn.role === 'driver' && (conn.driverId === driverId || userId === driverId)) {
        sendToUser(userId, driverConfirmation);
      }
    });
  }
}

/**
 * Notify passenger ready
 * @param {string} riderId - Rider ID
 * @param {object} payload - Ready payload
 */
function notifyPassengerReady(riderId, payload) {
  const { tripId, tripRequestId, driverId, timestamp } = payload;

  console.log(`Passenger ready notification from ${riderId}`);

  let driverNotified = false;

  // Try to notify driver directly
  if (driverId) {
    const driverUserId = driverIdToUserId.get(driverId);
    if (driverUserId) {
      const sent = sendToUser(driverUserId, {
        type: 'passenger_ready',
        payload: { tripId: tripId || tripRequestId, riderId, timestamp }
      });
      if (sent) driverNotified = true;
    }
  }

  // Try finding driver in trip room
  if (!driverNotified && tripId) {
    const tripUsers = tripConnections.get(tripId);
    if (tripUsers) {
      tripUsers.forEach(userId => {
        const conn = connections.get(userId);
        if (conn && conn.role === 'driver') {
          sendToUser(userId, {
            type: 'passenger_ready',
            payload: { tripId, riderId, timestamp }
          });
          driverNotified = true;
        }
      });
    }
  }

  // Try with trip request ID
  if (!driverNotified && tripRequestId && tripRequestId !== tripId) {
    const tripUsers = tripConnections.get(tripRequestId);
    if (tripUsers) {
      tripUsers.forEach(userId => {
        const conn = connections.get(userId);
        if (conn && conn.role === 'driver') {
          sendToUser(userId, {
            type: 'passenger_ready',
            payload: { tripId: tripId || tripRequestId, riderId, timestamp }
          });
          driverNotified = true;
        }
      });
    }
  }
}

/**
 * Notify passenger seated
 * @param {string} riderId - Rider ID
 * @param {object} payload - Seated payload
 */
function notifyPassengerSeated(riderId, payload) {
  const { tripId, timestamp } = payload;

  console.log(`Passenger seated notification from ${riderId} for trip ${tripId}`);

  const tripUsers = tripConnections.get(tripId);
  if (tripUsers) {
    tripUsers.forEach(userId => {
      const conn = connections.get(userId);
      if (conn && conn.role === 'driver') {
        sendToUser(userId, {
          type: 'passenger_seated',
          payload: { tripId, riderId, timestamp }
        });
      }
    });
  }
}

/**
 * Request passenger confirmation
 * @param {string} driverId - Driver ID
 * @param {object} payload - Confirmation request payload
 */
function requestPassengerConfirmation(driverId, payload) {
  const { tripId, riderId, message } = payload;

  console.log(`Driver ${driverId} requesting passenger confirmation`);

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

/**
 * Broadcast rider location to driver
 * @param {string} riderId - Rider ID
 * @param {object} payload - Location payload
 */
function broadcastRiderLocation(riderId, payload) {
  const { tripId, location } = payload;

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

/**
 * Broadcast driver location update to passenger
 * @param {object} payload - Location payload
 */
function broadcastDriverLocationUpdate(payload) {
  const {
    tripId,
    riderId,
    passengerId,
    driverId,
    routeId,
    location,
    latitude,
    longitude,
    heading,
    speed,
    eta,
    timestamp
  } = payload;

  const targetId = riderId || passengerId;
  const journeyId = tripId || routeId;

  // Normalize location object
  const normalizedLocation = location || {
    latitude,
    longitude,
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
      location: normalizedLocation,
      eta,
      timestamp: timestamp || new Date().toISOString()
    }
  };

  let passengerNotified = false;

  // Try direct targetId
  if (targetId) {
    const sent = sendToUser(targetId, notification);
    if (sent) passengerNotified = true;
  }

  // Try riderId mapping
  if (!passengerNotified && targetId) {
    let passengerUserId = riderIdToUserId.get(targetId);
    if (!passengerUserId && typeof targetId === 'number') {
      passengerUserId = riderIdToUserId.get(String(targetId));
    } else if (!passengerUserId && typeof targetId === 'string') {
      passengerUserId = riderIdToUserId.get(parseInt(targetId, 10));
    }

    if (passengerUserId) {
      const sent = sendToUser(passengerUserId, notification);
      if (sent) passengerNotified = true;
    }
  }

  // Search all passenger connections
  if (!passengerNotified && targetId) {
    connections.forEach((conn, userId) => {
      if (!passengerNotified && (conn.role === 'rider' || conn.role === 'passenger')) {
        if (conn.riderId === targetId || userId === targetId) {
          const sent = sendToUser(userId, notification);
          if (sent) passengerNotified = true;
        }
      }
    });
  }

  return passengerNotified;
}

module.exports = {
  init,
  joinTrip,
  leaveTrip,
  broadcastToTrip,
  notifyTripAccepted,
  notifyTripStarted,
  notifyTripCompleted,
  notifyTripCancelled,
  notifyDriverArrived,
  notifyPassengerReady,
  notifyPassengerSeated,
  requestPassengerConfirmation,
  broadcastRiderLocation,
  broadcastDriverLocationUpdate,
};
