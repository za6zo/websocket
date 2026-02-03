/**
 * Location Utilities Module
 * Handles distance calculation, ETA estimation, and trip destination caching
 */

// Trip destination cache
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
 * @returns {number|null} ETA in minutes
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
  console.log(`Stored destinations for trip ${tripId}`);
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
 * Remove trip destination from cache
 * @param {string} tripId - Trip ID
 */
function removeTripDestination(tripId) {
  tripDestinations.delete(tripId);
}

/**
 * Get trip destinations cache (for debugging)
 * @returns {Map} Trip destinations map
 */
function getTripDestinationsCache() {
  return tripDestinations;
}

module.exports = {
  calculateDistance,
  calculateETA,
  setTripDestination,
  updateTripStatus,
  getTripDestination,
  removeTripDestination,
  getTripDestinationsCache,
};
