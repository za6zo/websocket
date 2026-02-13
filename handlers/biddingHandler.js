/**
 * Bidding Handler Module
 * Handles bidding system for trip requests
 */

const WebSocket = require('ws');
const fetch = require('node-fetch');

// Try to load push notification service
let pushNotificationService = null;
try {
  pushNotificationService = require('../push-notification');
} catch (e) {
  console.warn('Push notification service not available in bidding handler');
}

// Will be initialized from main server
let connections = null;
let sendToUser = null;
let driverIdToUserId = null;
let riderIdToUserId = null;
let joinTrip = null;
let liveTrackingSessions = null;

// API URL for fetching push tokens
const API_URL = process.env.API_URL || 'https://admin.za6zo.cloud';

/**
 * Initialize bidding handler with shared state
 */
function init(deps) {
  connections = deps.connections;
  sendToUser = deps.sendToUser;
  driverIdToUserId = deps.driverIdToUserId;
  riderIdToUserId = deps.riderIdToUserId;
  joinTrip = deps.joinTrip;
  liveTrackingSessions = deps.liveTrackingSessions;
}

/**
 * Send push notification to a driver for new trip request
 * @param {string|number} driverId - Driver ID
 * @param {object} tripRequest - Trip request payload
 */
async function sendDriverPushNotification(driverId, tripRequest) {
  if (!pushNotificationService) return;

  try {
    // Get driver's push token from the API
    const response = await fetch(`${API_URL}/api/drivers/${driverId}/push-token`);
    if (!response.ok) {
      // Try alternate endpoint
      const altResponse = await fetch(`${API_URL}/api/users/${driverId}/push-token`);
      if (!altResponse.ok) {
        console.log(`No push token found for driver ${driverId}`);
        return;
      }
      const { expoPushToken } = await altResponse.json();
      if (expoPushToken) {
        await pushNotificationService.notifyNewTripRequest(expoPushToken, tripRequest);
        console.log(`Push notification sent to driver ${driverId}`);
      }
      return;
    }

    const { expoPushToken } = await response.json();
    if (expoPushToken) {
      await pushNotificationService.notifyNewTripRequest(expoPushToken, tripRequest);
      console.log(`Push notification sent to driver ${driverId}`);
    }
  } catch (error) {
    console.error(`Failed to send push notification to driver ${driverId}:`, error.message);
  }
}

/**
 * Broadcast new trip request to drivers
 * @param {object} data - Trip request data
 */
async function broadcastToDrivers(data) {
  const { tripRequest, targetDriverIds, estimatedFare, vehicleType } = data;

  console.log('[WS-SERVER] Broadcasting trip request to drivers');
  console.log('[WS-SERVER] Target driver IDs:', targetDriverIds);

  let driversNotified = 0;
  const driversToNotifyPush = [];

  // Prepare the payload with bidding information
  const broadcastPayload = {
    id: tripRequest?.id || tripRequest?.tripRequestId,
    tripRequestId: tripRequest?.id || tripRequest?.tripRequestId,
    riderId: tripRequest?.riderId,
    pickupLocation: tripRequest?.pickupLocation,
    dropoffLocation: tripRequest?.dropoffLocation,
    estimatedFare: estimatedFare || tripRequest?.estimatedFare,
    rideTypeId: tripRequest?.rideTypeId,
    status: tripRequest?.status,
    requestType: 'broadcast',
    allowBidding: true,
    vehicleType,
    minBidAmount: tripRequest?.minBidAmount,
    maxBidAmount: tripRequest?.maxBidAmount,
    riderName: tripRequest?.rider?.name || 'Passenger',
    riderRating: tripRequest?.rider?.rating
  };

  connections.forEach((userConn, userId) => {
    if (userConn.role === 'driver') {
      // If targetDriverIds provided, only send to those drivers
      if (targetDriverIds && targetDriverIds.length > 0) {
        const targetDriverIdsStr = targetDriverIds.map(id => String(id));
        const userIdStr = String(userId);
        const driverIdStr = userConn.driverId ? String(userConn.driverId) : null;

        const isTargetDriver = targetDriverIdsStr.includes(userIdStr) ||
                              (driverIdStr && targetDriverIdsStr.includes(driverIdStr));

        if (!isTargetDriver) return;
      }

      // Track driver for push notification
      const driverId = userConn.driverId || userId;
      driversToNotifyPush.push(driverId);

      if (userConn.ws.readyState === WebSocket.OPEN) {
        userConn.ws.send(JSON.stringify({
          type: 'new_trip_request',
          payload: broadcastPayload
        }));
        driversNotified++;
        console.log(`[WS-SERVER] Notified driver ${userId} about new trip request`);
      }
    }
  });

  console.log(`Broadcast sent to ${driversNotified} drivers`);

  // Also send push notifications to all target drivers for reliability
  // This ensures drivers receive notification even if WebSocket message is lost
  if (pushNotificationService && driversToNotifyPush.length > 0) {
    console.log(`[PUSH] Sending push notifications to ${driversToNotifyPush.length} drivers`);
    for (const driverId of driversToNotifyPush) {
      sendDriverPushNotification(driverId, broadcastPayload).catch(err => {
        console.error(`[PUSH] Error sending to driver ${driverId}:`, err.message);
      });
    }
  }

  // If targetDriverIds specified but no connected drivers found, send push to all targets
  if (targetDriverIds && targetDriverIds.length > 0 && driversNotified === 0) {
    console.log(`[PUSH] No connected drivers, sending push to ${targetDriverIds.length} target drivers`);
    for (const driverId of targetDriverIds) {
      sendDriverPushNotification(driverId, broadcastPayload).catch(err => {
        console.error(`[PUSH] Error sending to target driver ${driverId}:`, err.message);
      });
    }
  }
}

/**
 * Handle driver placing a bid
 * @param {string} driverId - Driver ID
 * @param {object} payload - Bid payload
 */
function handleDriverBid(driverId, payload) {
  const { tripRequestId, bidAmount, message, riderId } = payload;

  console.log(`Driver ${driverId} placed bid Rs${bidAmount} for trip ${tripRequestId}`);

  const bidNotification = {
    type: 'new_bid',
    payload: {
      tripRequestId,
      driverId,
      bidAmount,
      message,
      timestamp: new Date().toISOString(),
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

  // Fallback: broadcast to all riders
  if (!riderNotified) {
    connections.forEach((conn, userId) => {
      if (conn.role === 'rider' || conn.role === 'passenger') {
        sendToUser(userId, bidNotification);
      }
    });
  }

  console.log(`Notified rider about bid from driver ${driverId}`);
}

/**
 * Handle rider accepting a bid
 * @param {string} riderId - Rider ID
 * @param {object} payload - Acceptance payload
 */
function handleBidAcceptance(riderId, payload) {
  const { tripRequestId, bidId, driverId, bidAmount, tripId } = payload;

  console.log(`Rider ${riderId} accepted bid ${bidId} from driver ${driverId}`);

  // Join both users to trip room for real-time tracking
  const effectiveTripId = tripId || tripRequestId;
  if (effectiveTripId && joinTrip) {
    console.log(`Auto-joining driver ${driverId} and rider ${riderId} to trip ${effectiveTripId}`);
    joinTrip(driverId, effectiveTripId);
    joinTrip(riderId, effectiveTripId);

    // Auto-start live tracking session
    if (liveTrackingSessions) {
      liveTrackingSessions.set(effectiveTripId, {
        driverId,
        riderId,
        startTime: new Date().toISOString(),
        isActive: true
      });
      console.log(`Auto-started live tracking for trip ${effectiveTripId}`);
    }
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

  console.log(`Notified all drivers about trip ${tripRequestId} being taken`);
}

/**
 * Handle rider rejecting a bid
 * @param {string} riderId - Rider ID
 * @param {object} payload - Rejection payload
 */
function handleBidRejection(riderId, payload) {
  const { tripRequestId, bidId, driverId, reason } = payload;

  console.log(`Rider ${riderId} rejected bid ${bidId} from driver ${driverId}`);

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
  console.log(`Notified driver ${driverId} about bid rejection`);
}

/**
 * Notify driver that their bid was accepted (from API server)
 * @param {object} payload - Acceptance payload
 */
function notifyDriverBidAccepted(payload) {
  const { driverId, tripId, tripRequestId, bidId, bidAmount, riderId, message, pickupLocation, dropoffLocation, pickupAddress, dropoffAddress } = payload;

  console.log(`Notifying driver ${driverId} that bid was accepted`);

  // Try to find driver by driverId mapping
  const driverUserId = driverIdToUserId.get(driverId);

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

  // Method 1: Using driverId to userId mapping
  if (driverUserId) {
    const sent = sendToUser(driverUserId, notification);
    if (sent) notificationSent = true;
  }

  // Method 2: Try direct driverId as connection key
  if (!notificationSent) {
    const sent = sendToUser(driverId, notification);
    if (sent) notificationSent = true;
  }

  // Method 3: Search all connections
  if (!notificationSent) {
    for (const [userId, conn] of connections.entries()) {
      if (conn.driverId === driverId && !notificationSent) {
        const sent = sendToUser(userId, notification);
        if (sent) {
          notificationSent = true;
          break;
        }
      }
    }
  }

  if (!notificationSent) {
    console.log(`Could not find driver ${driverId} in any connection!`);
  }

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
    if (conn.role === 'driver' && userId !== driverUserId && userId !== driverId) {
      sendToUser(userId, tripUnavailableNotification);
    }
  });
}

/**
 * Notify driver that their bid was rejected
 * @param {object} payload - Rejection payload
 */
function notifyDriverBidRejected(payload) {
  const { driverId, tripRequestId, bidId, reason } = payload;

  console.log(`Notifying driver ${driverId} that bid was rejected`);

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
  } else {
    sendToUser(driverId, notification);
  }
}

/**
 * Notify rider about a new bid
 * @param {object} payload - Bid payload
 */
function notifyRiderAboutBid(payload) {
  const { riderId, tripRequestId, bid } = payload;

  console.log(`Notifying rider ${riderId} about new bid for trip ${tripRequestId}`);

  // Try multiple ways to find the rider
  let riderUserId = null;

  // 1. Try to find by riderId in mapping
  if (riderIdToUserId.has(riderId)) {
    riderUserId = riderIdToUserId.get(riderId);
  }

  // 2. Check if riderId is directly a connection userId
  if (!riderUserId && connections.has(riderId)) {
    riderUserId = riderId;
  }

  // 3. Look through all connections
  if (!riderUserId) {
    for (const [userId, userConn] of connections.entries()) {
      if (userConn.riderId === riderId || userId === riderId) {
        riderUserId = userId;
        break;
      }
    }
  }

  if (!riderUserId) {
    console.log(`Rider ${riderId} not connected via WebSocket`);
    return;
  }

  const riderConn = connections.get(riderUserId);
  if (riderConn && riderConn.ws.readyState === WebSocket.OPEN) {
    const message = {
      type: 'new_bid',
      payload: { tripRequestId, bid }
    };
    riderConn.ws.send(JSON.stringify(message));
    console.log(`Sent new bid notification to rider ${riderId}`);
  }
}

/**
 * Notify rider about trip acceptance
 * @param {object} payload - Acceptance payload
 */
function notifyRiderTripAccepted(payload) {
  const { riderId, tripId, driverInfo, vehicle, estimatedArrival } = payload;

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
    console.log(`Notified rider ${riderId} about trip acceptance`);

    // Join both rider and driver to the trip
    if (joinTrip) {
      joinTrip(riderId, tripId);
      if (payload.driverId) {
        joinTrip(payload.driverId, tripId);
      }
    }
  } else {
    console.log(`Could not notify rider ${riderId} - not connected`);
  }
}

module.exports = {
  init,
  broadcastToDrivers,
  handleDriverBid,
  handleBidAcceptance,
  handleBidRejection,
  notifyDriverBidAccepted,
  notifyDriverBidRejected,
  notifyRiderAboutBid,
  notifyRiderTripAccepted,
};
