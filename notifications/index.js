/**
 * Notifications Module
 * Centralized notification functions for shared rides, city trips, subscriptions, etc.
 */

// Will be initialized from main server
let connections = null;
let sendToUser = null;
let driverIdToUserId = null;
let riderIdToUserId = null;

/**
 * Initialize notifications module with shared state
 */
function init(deps) {
  connections = deps.connections;
  sendToUser = deps.sendToUser;
  driverIdToUserId = deps.driverIdToUserId;
  riderIdToUserId = deps.riderIdToUserId;
}

// ==================== SHARED RIDE NOTIFICATIONS ====================

/**
 * Notify driver about new passenger request for their route
 */
function notifyDriverAboutPassengerRequest(payload) {
  const {
    requestId, routeId, driverId, driverUserId, passengerId,
    passengerInfo, pickupLocation, dropoffLocation,
    pickupDistance, estimatedFare, requestedSeats, timestamp
  } = payload;

  console.log(`New passenger request for driver ${driverId} on route ${routeId}`);

  const notification = {
    type: 'passenger_ride_request',
    payload: {
      requestId, routeId, passengerId, passengerInfo, pickupLocation,
      dropoffLocation, pickupDistance, estimatedFare, requestedSeats: requestedSeats || 1, timestamp
    }
  };

  let driverNotified = false;

  // Method 1: Try driverUserId from payload
  if (driverUserId) {
    const sent = sendToUser(driverUserId, notification);
    if (sent) driverNotified = true;
  }

  // Method 2: Try driverId mapping
  if (!driverNotified) {
    const mappedUserId = driverIdToUserId.get(driverId);
    if (mappedUserId) {
      const sent = sendToUser(mappedUserId, notification);
      if (sent) driverNotified = true;
    }
  }

  // Method 3: Try direct driverId
  if (!driverNotified) {
    const sent = sendToUser(driverId, notification);
    if (sent) driverNotified = true;
  }

  // Method 4: Search all connections
  if (!driverNotified) {
    connections.forEach((conn, connUserId) => {
      if (!driverNotified && conn.role === 'driver') {
        if (conn.driverId === driverId || connUserId === driverId || connUserId === driverUserId) {
          const sent = sendToUser(connUserId, notification);
          if (sent) driverNotified = true;
        }
      }
    });
  }

  return driverNotified;
}

/**
 * Notify driver about passenger request cancellation
 */
function notifyDriverAboutRequestCancellation(payload) {
  const { requestId, routeId, driverId, passengerId, reason, timestamp } = payload;

  console.log(`Passenger ${passengerId} cancelled request ${requestId} for driver ${driverId}`);

  const notification = {
    type: 'passenger_request_cancelled',
    payload: { requestId, routeId, passengerId, reason, timestamp }
  };

  let driverNotified = false;

  const driverUserId = driverIdToUserId.get(driverId);
  if (driverUserId) {
    const sent = sendToUser(driverUserId, notification);
    if (sent) driverNotified = true;
  }

  if (!driverNotified) {
    const sent = sendToUser(driverId, notification);
    if (sent) driverNotified = true;
  }

  if (!driverNotified) {
    connections.forEach((conn, userId) => {
      if (!driverNotified && conn.role === 'driver') {
        if (conn.driverId === driverId || userId === driverId) {
          const sent = sendToUser(userId, notification);
          if (sent) driverNotified = true;
        }
      }
    });
  }

  return driverNotified;
}

/**
 * Notify passenger about driver accepting their request
 */
function notifyPassengerAboutAcceptance(payload) {
  const {
    requestId, routeId, passengerId, driverId, driverInfo, vehicleInfo,
    routeInfo, pickupLocation, dropoffLocation, estimatedFare, acceptedAt, message
  } = payload;

  console.log(`Driver ${driverId} accepted passenger ${passengerId}'s request`);

  const notification = {
    type: 'driver_accepted_request',
    payload: {
      requestId, routeId, driverId, driverInfo, vehicleInfo, routeInfo,
      pickupLocation, dropoffLocation, estimatedFare, acceptedAt, message
    }
  };

  let passengerNotified = false;

  const sent = sendToUser(passengerId, notification);
  if (sent) passengerNotified = true;

  if (!passengerNotified) {
    let passengerUserId = riderIdToUserId.get(passengerId);
    if (!passengerUserId && typeof passengerId === 'number') {
      passengerUserId = riderIdToUserId.get(String(passengerId));
    } else if (!passengerUserId && typeof passengerId === 'string') {
      passengerUserId = riderIdToUserId.get(parseInt(passengerId, 10));
    }

    if (passengerUserId) {
      const sent = sendToUser(passengerUserId, notification);
      if (sent) passengerNotified = true;
    }
  }

  if (!passengerNotified) {
    connections.forEach((conn, userId) => {
      if (!passengerNotified && (conn.role === 'rider' || conn.role === 'passenger')) {
        if (conn.riderId === passengerId || userId === passengerId) {
          const sent = sendToUser(userId, notification);
          if (sent) passengerNotified = true;
        }
      }
    });
  }

  return passengerNotified;
}

/**
 * Notify passenger about driver rejecting their request
 */
function notifyPassengerAboutRejection(payload) {
  const { requestId, routeId, passengerId, driverId, reason, message } = payload;

  console.log(`Driver ${driverId} rejected passenger ${passengerId}'s request`);

  const notification = {
    type: 'driver_rejected_passenger',
    payload: {
      requestId, routeId, driverId, passengerId,
      reason: reason || 'Driver unavailable',
      message: message || 'Your ride request was declined. Please try another driver.'
    }
  };

  let passengerNotified = false;

  const sent = sendToUser(passengerId, notification);
  if (sent) passengerNotified = true;

  if (!passengerNotified) {
    let passengerUserId = riderIdToUserId.get(passengerId);
    if (!passengerUserId && typeof passengerId === 'number') {
      passengerUserId = riderIdToUserId.get(String(passengerId));
    } else if (!passengerUserId && typeof passengerId === 'string') {
      passengerUserId = riderIdToUserId.get(parseInt(passengerId, 10));
    }

    if (passengerUserId) {
      const sent = sendToUser(passengerUserId, notification);
      if (sent) passengerNotified = true;
    }
  }

  if (!passengerNotified) {
    connections.forEach((conn, userId) => {
      if (!passengerNotified && (conn.role === 'rider' || conn.role === 'passenger')) {
        if (conn.riderId === passengerId || userId === passengerId) {
          const sent = sendToUser(userId, notification);
          if (sent) passengerNotified = true;
        }
      }
    });
  }

  return passengerNotified;
}

/**
 * Notify passenger about route cancellation
 */
function notifyPassengerAboutRouteCancellation(payload) {
  const { routeId, requestId, passengerId, driverId, driverName, message, routeInfo } = payload;

  console.log(`Notifying passenger ${passengerId} that driver cancelled route ${routeId}`);

  const notification = {
    type: 'route_cancelled',
    payload: {
      routeId, requestId, driverId, driverName,
      message: message || 'The driver has cancelled the route. Your ride request has been cancelled.',
      routeInfo, timestamp: new Date().toISOString()
    }
  };

  let passengerNotified = false;

  const sent = sendToUser(passengerId, notification);
  if (sent) passengerNotified = true;

  if (!passengerNotified) {
    const passengerUserId = riderIdToUserId.get(passengerId);
    if (passengerUserId) {
      const sent = sendToUser(passengerUserId, notification);
      if (sent) passengerNotified = true;
    }
  }

  if (!passengerNotified) {
    connections.forEach((conn, userId) => {
      if (!passengerNotified && (conn.role === 'rider' || conn.role === 'passenger')) {
        if (conn.riderId === passengerId || userId === passengerId) {
          const sent = sendToUser(userId, notification);
          if (sent) passengerNotified = true;
        }
      }
    });
  }

  return passengerNotified;
}

// ==================== SUBSCRIPTION NOTIFICATIONS ====================

/**
 * Notify driver about new subscription request
 */
function notifyDriverAboutSubscriptionRequest(payload) {
  const { targetDriverId, requestId, passengerId, passengerName, destinationName, proposedPrice, monthlyPrice } = payload;

  console.log(`New subscription request for driver ${targetDriverId}`);

  const driverUserId = driverIdToUserId.get(parseInt(targetDriverId)) || targetDriverId;

  const notification = {
    type: 'subscription_request',
    payload: { requestId, passengerId, passengerName, destinationName, proposedPrice, monthlyPrice, timestamp: new Date().toISOString() }
  };

  if (sendToUser(driverUserId, notification)) {
    console.log(`Notified driver ${targetDriverId} about subscription request`);
    return true;
  }
  console.log(`Failed to notify driver ${targetDriverId} - not connected`);
  return false;
}

/**
 * Notify passenger about subscription request status
 */
function notifyPassengerAboutSubscriptionStatus(payload) {
  const { passengerId, requestId, status, driverName, finalPrice, counterPrice } = payload;

  console.log(`Notifying passenger ${passengerId} - status: ${status}`);

  const passengerUserId = riderIdToUserId.get(parseInt(passengerId)) || passengerId;

  const notification = {
    type: status === 'accepted' ? 'subscription_request_accepted' :
          status === 'rejected' ? 'subscription_request_rejected' :
          'subscription_counter_offer',
    payload: { requestId, driverName, finalPrice, counterPrice, timestamp: new Date().toISOString() }
  };

  if (sendToUser(passengerUserId, notification)) {
    console.log(`Notified passenger ${passengerId} about subscription ${status}`);
    return true;
  }
  return false;
}

/**
 * Notify both parties about subscription confirmation
 */
function notifySubscriptionConfirmed(payload) {
  const { subscriptionId, passengerId, driverId, destinationName, startDate, monthlyPrice } = payload;

  console.log(`Notifying about confirmed subscription ${subscriptionId}`);

  const passengerUserId = riderIdToUserId.get(parseInt(passengerId)) || passengerId;
  const driverUserId = driverIdToUserId.get(parseInt(driverId)) || driverId;

  const passengerNotification = {
    type: 'subscription_confirmed',
    payload: { subscriptionId, destinationName, startDate, monthlyPrice, timestamp: new Date().toISOString() }
  };

  const driverNotification = {
    type: 'new_subscriber',
    payload: { subscriptionId, destinationName, startDate, monthlyPrice, timestamp: new Date().toISOString() }
  };

  sendToUser(passengerUserId, passengerNotification);
  sendToUser(driverUserId, driverNotification);
}

/**
 * Notify about subscription trip (daily scheduled trip)
 */
function notifySubscriptionTrip(payload) {
  const { tripId, passengerId, driverId, scheduledTime, status } = payload;

  console.log(`Subscription trip ${tripId} - status: ${status}`);

  const passengerUserId = riderIdToUserId.get(parseInt(passengerId)) || passengerId;
  const driverUserId = driverIdToUserId.get(parseInt(driverId)) || driverId;

  const notification = {
    type: 'subscription_trip_update',
    payload: { tripId, scheduledTime, status, timestamp: new Date().toISOString() }
  };

  sendToUser(passengerUserId, notification);
  sendToUser(driverUserId, notification);
}

// ==================== CITY-TO-CITY NOTIFICATIONS ====================

/**
 * Notify about city-to-city trip request
 */
function notifyCityTripRequest(payload) {
  const { tripId, passengerId, fromCity, toCity, scheduledDate, proposedPrice } = payload;

  console.log(`New city trip request ${tripId} from ${fromCity} to ${toCity}`);

  const notification = {
    type: 'city_trip_request',
    payload: { tripId, passengerId, fromCity, toCity, scheduledDate, proposedPrice, timestamp: new Date().toISOString() }
  };

  // Broadcast to all connected drivers
  connections.forEach((conn, userId) => {
    if (conn.role === 'DRIVER') {
      sendToUser(userId, notification);
    }
  });
}

/**
 * Notify specific driver about direct trip request
 */
function notifyCityTripDirectRequest(payload) {
  const { tripId, userId, passengerId, passengerName, fromCity, toCity, scheduledDate, proposedPrice } = payload;

  console.log(`City trip direct request ${tripId} sent to driver userId: ${userId}`);

  let driverClerkId = driverIdToUserId.get(userId);
  if (!driverClerkId) driverClerkId = driverIdToUserId.get(String(userId));
  if (!driverClerkId) driverClerkId = driverIdToUserId.get(parseInt(userId));

  if (!driverClerkId) {
    console.error(`Could not find Clerk ID for driver userId: ${userId}`);
    return;
  }

  const notification = {
    type: 'city_trip_direct_request',
    payload: { tripId, passengerId, passengerName, fromCity, toCity, scheduledDate, proposedPrice, timestamp: new Date().toISOString() }
  };

  sendToUser(driverClerkId, notification);
}

/**
 * Notify passenger that driver accepted trip
 */
function notifyCityTripAccepted(payload) {
  const { tripId, userId, driverId, fromCity, toCity, scheduledDate, finalPrice, vehicle } = payload;

  console.log(`Driver ${driverId} accepted city trip ${tripId}`);

  const passengerUserId = riderIdToUserId.get(parseInt(userId)) || userId;

  const notification = {
    type: 'city_trip_accepted',
    payload: { tripId, driverId, fromCity, toCity, scheduledDate, finalPrice, vehicle, timestamp: new Date().toISOString() }
  };

  sendToUser(passengerUserId, notification);
}

/**
 * Notify passenger that driver rejected trip
 */
function notifyCityTripRejected(payload) {
  const { tripId, userId, driverId, fromCity, toCity } = payload;

  console.log(`Driver ${driverId} rejected city trip ${tripId}`);

  const passengerUserId = riderIdToUserId.get(parseInt(userId)) || userId;

  const notification = {
    type: 'city_trip_rejected',
    payload: { tripId, driverId, fromCity, toCity, timestamp: new Date().toISOString() }
  };

  sendToUser(passengerUserId, notification);
}

/**
 * Notify passenger about driver counter offer
 */
function notifyCityTripCounterOffer(payload) {
  const { tripId, userId, driverId, fromCity, toCity, driverProposedPrice, passengerProposedPrice } = payload;

  console.log(`Driver ${driverId} sent counter offer for city trip ${tripId}: PKR ${driverProposedPrice}`);

  const passengerUserId = riderIdToUserId.get(parseInt(userId)) || userId;

  const notification = {
    type: 'city_trip_counter_offer',
    payload: { tripId, driverId, fromCity, toCity, driverProposedPrice, passengerProposedPrice, timestamp: new Date().toISOString() }
  };

  sendToUser(passengerUserId, notification);
}

/**
 * Notify driver that passenger accepted counter offer
 */
function notifyCityTripPriceAgreed(payload) {
  const { tripId, userId, passengerName, fromCity, toCity, finalPrice } = payload;

  console.log(`Passenger agreed to city trip ${tripId} price: PKR ${finalPrice}`);

  const driverUserId = driverIdToUserId.get(parseInt(userId)) || userId;

  const notification = {
    type: 'city_trip_price_agreed',
    payload: { tripId, passengerName, fromCity, toCity, finalPrice, timestamp: new Date().toISOString() }
  };

  sendToUser(driverUserId, notification);
}

/**
 * Notify passenger that trip started
 */
function notifyCityTripStarted(payload) {
  const { tripId, userId } = payload;

  console.log(`City trip ${tripId} has started for passenger userId: ${userId}`);

  let passengerClerkId = riderIdToUserId.get(parseInt(userId));
  if (!passengerClerkId) passengerClerkId = riderIdToUserId.get(String(userId));
  if (!passengerClerkId) passengerClerkId = riderIdToUserId.get(userId);
  if (!passengerClerkId) passengerClerkId = userId;

  const notification = {
    type: 'city_trip_started',
    payload: { tripId, timestamp: new Date().toISOString() }
  };

  sendToUser(passengerClerkId, notification);
}

/**
 * Notify passenger that trip completed
 */
function notifyCityTripCompleted(payload) {
  const { tripId, userId, finalPrice } = payload;

  console.log(`City trip ${tripId} completed. Final price: PKR ${finalPrice}`);

  let passengerClerkId = riderIdToUserId.get(parseInt(userId));
  if (!passengerClerkId) passengerClerkId = riderIdToUserId.get(String(userId));
  if (!passengerClerkId) passengerClerkId = riderIdToUserId.get(userId);
  if (!passengerClerkId) passengerClerkId = userId;

  const notification = {
    type: 'city_trip_completed',
    payload: { tripId, finalPrice, timestamp: new Date().toISOString() }
  };

  sendToUser(passengerClerkId, notification);
}

/**
 * Notify about city trip status updates
 */
function notifyCityTripUpdate(payload) {
  const { tripId, passengerId, driverId, status, finalPrice, counterPrice } = payload;

  console.log(`City trip ${tripId} status update: ${status}`);

  const passengerUserId = riderIdToUserId.get(parseInt(passengerId)) || passengerId;
  const driverUserId = driverId ? (driverIdToUserId.get(parseInt(driverId)) || driverId) : null;

  const notification = {
    type: 'city_trip_update',
    payload: { tripId, status, finalPrice, counterPrice, timestamp: new Date().toISOString() }
  };

  sendToUser(passengerUserId, notification);
  if (driverUserId) {
    sendToUser(driverUserId, notification);
  }
}

// ==================== DRIVER VERIFICATION NOTIFICATION ====================

/**
 * Notify driver about verification status change
 */
function notifyDriverVerified(payload) {
  const { driverId, userId, verificationStatus, message, targetDriverId } = payload;

  const targetId = targetDriverId || driverId;

  console.log(`Notifying driver ${targetId} about verification status: ${verificationStatus}`);

  const notification = {
    type: 'driver_verified',
    payload: {
      driverId: targetId, userId, verificationStatus,
      message: message || 'Your driver account has been verified!',
      timestamp: new Date().toISOString()
    }
  };

  let driverNotified = false;

  // Method 1: Try driverId mapping
  const driverUserId = driverIdToUserId.get(parseInt(targetId));
  if (driverUserId) {
    const sent = sendToUser(driverUserId, notification);
    if (sent) driverNotified = true;
  }

  // Method 2: Try direct driverId
  if (!driverNotified && targetId) {
    const sent = sendToUser(targetId.toString(), notification);
    if (sent) driverNotified = true;
  }

  // Method 3: Try with provided userId
  if (!driverNotified && userId) {
    const sent = sendToUser(userId.toString(), notification);
    if (sent) driverNotified = true;
  }

  // Method 4: Search all connections
  if (!driverNotified) {
    connections.forEach((conn, connectionUserId) => {
      if (!driverNotified && conn.role === 'driver') {
        if (conn.driverId === parseInt(targetId) ||
            connectionUserId === targetId.toString() ||
            (userId && connectionUserId === userId.toString())) {
          const sent = sendToUser(connectionUserId, notification);
          if (sent) driverNotified = true;
        }
      }
    });
  }

  return driverNotified;
}

module.exports = {
  init,
  // Shared Ride
  notifyDriverAboutPassengerRequest,
  notifyDriverAboutRequestCancellation,
  notifyPassengerAboutAcceptance,
  notifyPassengerAboutRejection,
  notifyPassengerAboutRouteCancellation,
  // Subscription
  notifyDriverAboutSubscriptionRequest,
  notifyPassengerAboutSubscriptionStatus,
  notifySubscriptionConfirmed,
  notifySubscriptionTrip,
  // City Trip
  notifyCityTripRequest,
  notifyCityTripDirectRequest,
  notifyCityTripAccepted,
  notifyCityTripRejected,
  notifyCityTripCounterOffer,
  notifyCityTripPriceAgreed,
  notifyCityTripStarted,
  notifyCityTripCompleted,
  notifyCityTripUpdate,
  // Driver Verification
  notifyDriverVerified,
};
