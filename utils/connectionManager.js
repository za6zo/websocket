/**
 * WebSocket Connection Manager
 * Handles connection tracking, user mappings, and connection limits
 */

const { RATE_LIMITS } = require('../config/constants');

// Connection storage
const connections = new Map(); // userId -> { ws, connectionId, role, tripId, location, lastHeartbeat, driverId, riderId }
const userConnections = new Map(); // userId -> Set of connectionIds
const tripConnections = new Map(); // tripId -> Set of userIds
const driverIdToUserId = new Map(); // driverId -> userId mapping
const riderIdToUserId = new Map(); // riderId -> userId mapping

let connectionIdCounter = 0;

/**
 * Generate unique connection ID
 * @returns {string} Unique connection ID
 */
function generateConnectionId() {
  return `conn_${++connectionIdCounter}_${Date.now()}`;
}

/**
 * Check if user has reached connection limit
 * @param {string} userId - User ID
 * @returns {boolean} True if allowed, false if limit reached
 */
function checkUserConnectionLimit(userId) {
  if (userId === 'api-server') return true;

  const userConns = userConnections.get(userId);
  if (!userConns || userConns.size < RATE_LIMITS.MAX_CONNECTIONS_PER_USER) {
    return true;
  }

  console.log(`[WS Limit] User ${userId} has ${userConns.size} connections (max: ${RATE_LIMITS.MAX_CONNECTIONS_PER_USER})`);
  return false;
}

/**
 * Check if server has reached total connection limit
 * @returns {boolean} True if allowed, false if limit reached
 */
function checkTotalConnectionLimit() {
  if (connections.size >= RATE_LIMITS.MAX_TOTAL_CONNECTIONS) {
    console.log(`[WS Limit] Server at max connections: ${connections.size}`);
    return false;
  }
  return true;
}

/**
 * Track new connection for a user
 * @param {string} userId - User ID
 * @param {string} connectionId - Unique connection ID
 */
function trackUserConnection(userId, connectionId) {
  if (!userConnections.has(userId)) {
    userConnections.set(userId, new Set());
  }
  userConnections.get(userId).add(connectionId);
}

/**
 * Remove connection tracking for a user
 * @param {string} userId - User ID
 * @param {string} connectionId - Unique connection ID
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
 * Store a new connection
 * @param {string} userId - User ID
 * @param {WebSocket} ws - WebSocket instance
 * @param {string} connectionId - Connection ID
 */
function storeConnection(userId, ws, connectionId) {
  connections.set(userId, {
    ws,
    connectionId,
    role: null,
    tripId: null,
    location: null,
    lastHeartbeat: Date.now(),
    driverId: null,
    riderId: null,
  });
  trackUserConnection(userId, connectionId);
}

/**
 * Get connection by user ID
 * @param {string} userId - User ID
 * @returns {object|undefined} Connection object
 */
function getConnection(userId) {
  return connections.get(userId);
}

/**
 * Update connection properties
 * @param {string} userId - User ID
 * @param {object} updates - Properties to update
 */
function updateConnection(userId, updates) {
  const conn = connections.get(userId);
  if (conn) {
    Object.assign(conn, updates);
  }
}

/**
 * Remove connection and clean up all mappings
 * @param {string} userId - User ID
 * @param {string} connectionId - Connection ID
 */
function removeConnection(userId, connectionId) {
  const userConn = connections.get(userId);

  // Untrack connection
  untrackUserConnection(userId, connectionId);

  // Clean up driver ID mappings
  if (userConn?.driverId) {
    const driverId = userConn.driverId;
    [driverId, String(driverId), parseInt(String(driverId)), userId, String(userId)]
      .filter(key => key !== undefined && key !== null && !isNaN(key))
      .forEach(key => driverIdToUserId.delete(key));
    console.log(`Cleaned up driver ID mappings for driver ${driverId}`);
  }

  // Clean up rider ID mappings
  if (userConn?.riderId) {
    const riderId = userConn.riderId;
    [riderId, String(riderId), parseInt(String(riderId)), userId, String(userId)]
      .filter(key => key !== undefined && key !== null && !isNaN(key))
      .forEach(key => riderIdToUserId.delete(key));
    console.log(`Cleaned up rider ID mappings for rider ${riderId}`);
  }

  // Remove from all trip connections
  tripConnections.forEach((tripUsers, tripId) => {
    if (tripUsers.has(userId)) {
      tripUsers.delete(userId);
      console.log(`Removed user ${userId} from trip ${tripId}`);
      if (tripUsers.size === 0) {
        tripConnections.delete(tripId);
        console.log(`Deleted empty trip connection for trip ${tripId}`);
      }
    }
  });

  connections.delete(userId);
  console.log(`User ${userId} fully cleaned up`);
}

/**
 * Map driver ID to user ID
 * @param {string|number} driverId - Driver ID
 * @param {string} userId - User ID
 */
function mapDriverToUser(driverId, userId) {
  driverIdToUserId.set(driverId, userId);
  driverIdToUserId.set(String(driverId), userId);
  const parsed = parseInt(String(driverId));
  if (!isNaN(parsed)) {
    driverIdToUserId.set(parsed, userId);
  }
}

/**
 * Map rider ID to user ID
 * @param {string|number} riderId - Rider ID
 * @param {string} userId - User ID
 */
function mapRiderToUser(riderId, userId) {
  riderIdToUserId.set(riderId, userId);
  riderIdToUserId.set(String(riderId), userId);
  const parsed = parseInt(String(riderId));
  if (!isNaN(parsed)) {
    riderIdToUserId.set(parsed, userId);
  }
}

/**
 * Get user ID from driver ID
 * @param {string|number} driverId - Driver ID
 * @returns {string|undefined} User ID
 */
function getUserIdFromDriverId(driverId) {
  return driverIdToUserId.get(driverId) ||
         driverIdToUserId.get(String(driverId)) ||
         driverIdToUserId.get(parseInt(String(driverId)));
}

/**
 * Get user ID from rider ID
 * @param {string|number} riderId - Rider ID
 * @returns {string|undefined} User ID
 */
function getUserIdFromRiderId(riderId) {
  return riderIdToUserId.get(riderId) ||
         riderIdToUserId.get(String(riderId)) ||
         riderIdToUserId.get(parseInt(String(riderId)));
}

/**
 * Add user to trip connection group
 * @param {string} tripId - Trip ID
 * @param {string} userId - User ID
 */
function addToTripConnection(tripId, userId) {
  if (!tripConnections.has(tripId)) {
    tripConnections.set(tripId, new Set());
  }
  tripConnections.get(tripId).add(userId);
}

/**
 * Get all user IDs for a trip
 * @param {string} tripId - Trip ID
 * @returns {Set|undefined} Set of user IDs
 */
function getTripUsers(tripId) {
  return tripConnections.get(tripId);
}

/**
 * Get connection statistics
 * @returns {object} Connection stats
 */
function getConnectionStats() {
  let totalUserConnections = 0;
  let maxConnectionsPerUser = 0;
  let usersWithMultipleConnections = 0;

  for (const [userId, conns] of userConnections.entries()) {
    totalUserConnections += conns.size;
    if (conns.size > maxConnectionsPerUser) {
      maxConnectionsPerUser = conns.size;
    }
    if (conns.size > 1) {
      usersWithMultipleConnections++;
    }
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
 * Get all connections (for iteration)
 * @returns {Map} Connections map
 */
function getAllConnections() {
  return connections;
}

/**
 * Get all driver connections
 * @returns {Array} Array of [userId, connection] pairs for drivers
 */
function getDriverConnections() {
  return Array.from(connections.entries())
    .filter(([_, conn]) => conn.role === 'driver');
}

module.exports = {
  generateConnectionId,
  checkUserConnectionLimit,
  checkTotalConnectionLimit,
  trackUserConnection,
  untrackUserConnection,
  storeConnection,
  getConnection,
  updateConnection,
  removeConnection,
  mapDriverToUser,
  mapRiderToUser,
  getUserIdFromDriverId,
  getUserIdFromRiderId,
  addToTripConnection,
  getTripUsers,
  getConnectionStats,
  getAllConnections,
  getDriverConnections,
};
