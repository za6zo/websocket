const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 8090; // Bridge runs on 8090, WebSocket server on 8080

// =============================================================================
// GEOCODING CACHE CONFIGURATION
// =============================================================================
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const GEOCODE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours in ms
const AUTOCOMPLETE_CACHE_TTL = 1 * 60 * 60 * 1000; // 1 hour for autocomplete
const DIRECTIONS_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours for directions (routes don't change often)
const MAX_CACHE_SIZE = 10000; // Maximum cache entries

// In-memory geocoding cache
const geocodeCache = new Map();
const autocompleteCache = new Map();
const directionsCache = new Map();

// Cache statistics for monitoring
let cacheStats = {
  hits: 0,
  misses: 0,
  evictions: 0
};

/**
 * Get cached value if not expired
 */
function getCached(cache, key, ttl) {
  const entry = cache.get(key);
  if (entry && (Date.now() - entry.timestamp) < ttl) {
    cacheStats.hits++;
    return entry.data;
  }
  if (entry) {
    cache.delete(key); // Remove expired entry
  }
  cacheStats.misses++;
  return null;
}

/**
 * Set cache value with timestamp
 */
function setCache(cache, key, data, maxSize = MAX_CACHE_SIZE) {
  // Evict oldest entries if cache is full
  if (cache.size >= maxSize) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
    cacheStats.evictions++;
  }
  cache.set(key, { data, timestamp: Date.now() });
}

/**
 * Generate cache key for reverse geocoding
 */
function reverseGeocodeKey(lat, lng, precision = 5) {
  // Round coordinates to reduce cache fragmentation
  const roundedLat = parseFloat(lat).toFixed(precision);
  const roundedLng = parseFloat(lng).toFixed(precision);
  return `reverse:${roundedLat},${roundedLng}`;
}

/**
 * Generate cache key for place details
 */
function placeDetailsKey(placeId) {
  return `place:${placeId}`;
}

/**
 * Generate cache key for autocomplete
 */
function autocompleteKey(input, lat, lng) {
  const locationPart = lat && lng ? `@${parseFloat(lat).toFixed(2)},${parseFloat(lng).toFixed(2)}` : '';
  return `auto:${input.toLowerCase().trim()}${locationPart}`;
}

/**
 * Generate cache key for directions
 * Uses 4 decimal places (~11m precision) for good cache hit rate while staying accurate
 */
function directionsKey(originLat, originLng, destLat, destLng, mode = 'driving') {
  const roundedOriginLat = parseFloat(originLat).toFixed(4);
  const roundedOriginLng = parseFloat(originLng).toFixed(4);
  const roundedDestLat = parseFloat(destLat).toFixed(4);
  const roundedDestLng = parseFloat(destLng).toFixed(4);
  return `dir:${roundedOriginLat},${roundedOriginLng}->${roundedDestLat},${roundedDestLng}:${mode}`;
}
// Read WebSocket URL from environment or use Ngrok URL as fallback
const WS_URL = process.env.WEBSOCKET_URL || 'ws://localhost:8080';

// Persistent WebSocket connection
let ws = null;
let reconnectInterval = null;

function connectWebSocket() {
  console.log(`🔗 Attempting to connect to WebSocket: ${WS_URL}`);

  ws = new WebSocket(`${WS_URL}?token=api-server`, {
    headers: {
      'ngrok-skip-browser-warning': 'true'
    }
  });

  ws.on('open', () => {
    console.log(`🟢 WebSocket connected successfully`);
    if (reconnectInterval) {
      clearInterval(reconnectInterval);
      reconnectInterval = null;
    }

    // Send identification message
    ws.send(JSON.stringify({
      type: 'identify',
      payload: { role: 'api-server' }
    }));
    console.log('📤 Identified as API server');

    // Set up ping to keep connection alive
    const pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 30000); // Ping every 30 seconds
  });

  ws.on('close', () => {
    console.log('🔴 WebSocket connection closed');
    ws = null;
    // Reconnect after 5 seconds
    if (!reconnectInterval) {
      reconnectInterval = setTimeout(() => {
        console.log('🔄 Attempting to reconnect...');
        connectWebSocket();
      }, 5000);
    }
  });

  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error.message);
  });

  ws.on('message', (data) => {
    console.log('📥 Received message:', data.toString());
  });

  ws.on('pong', () => {
    // Connection is alive
  });
}

// Connect on startup
connectWebSocket();

// Store active connections by user type
const connections = {
  drivers: new Map(),
  passengers: new Map(),
};

// =============================================================================
// GEOCODING API ENDPOINTS
// =============================================================================

/**
 * Reverse Geocoding: Convert coordinates to address
 * GET /api/geocode/reverse?lat=34.0151&lng=71.5249
 */
app.get('/api/geocode/reverse', async (req, res) => {
  const { lat, lng } = req.query;

  if (!lat || !lng) {
    return res.status(400).json({
      success: false,
      error: 'Missing required parameters: lat and lng'
    });
  }

  if (!GOOGLE_MAPS_API_KEY) {
    return res.status(500).json({
      success: false,
      error: 'Google Maps API key not configured'
    });
  }

  const cacheKey = reverseGeocodeKey(lat, lng);

  // Check cache first
  const cached = getCached(geocodeCache, cacheKey, GEOCODE_CACHE_TTL);
  if (cached) {
    console.log(`📍 [GEOCODE] Cache HIT for reverse: ${lat},${lng}`);
    return res.json({ success: true, results: cached, cached: true });
  }

  try {
    console.log(`📍 [GEOCODE] Cache MISS - Fetching reverse geocode for: ${lat},${lng}`);
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_MAPS_API_KEY}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.status === 'OK' && data.results) {
      // Cache the successful result
      setCache(geocodeCache, cacheKey, data.results);
      console.log(`✅ [GEOCODE] Cached reverse geocode result for: ${lat},${lng}`);
      return res.json({ success: true, results: data.results, cached: false });
    } else {
      console.log(`⚠️ [GEOCODE] Google API returned status: ${data.status}`);
      return res.json({
        success: false,
        error: data.status,
        error_message: data.error_message
      });
    }
  } catch (error) {
    console.error('❌ [GEOCODE] Reverse geocode error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Forward Geocoding: Get place details by place_id
 * GET /api/geocode/place-details?place_id=ChIJ...&sessiontoken=xxx
 *
 * SESSION TOKEN (Phase 3):
 * - When sessiontoken is provided, it's passed to Google's API
 * - Place Details request with matching session token = FREE (billed with autocomplete)
 * - Cache key does NOT include session token (same place_id = same cached result)
 */
app.get('/api/geocode/place-details', async (req, res) => {
  const { place_id, fields, sessiontoken } = req.query;

  if (!place_id) {
    return res.status(400).json({
      success: false,
      error: 'Missing required parameter: place_id'
    });
  }

  if (!GOOGLE_MAPS_API_KEY) {
    return res.status(500).json({
      success: false,
      error: 'Google Maps API key not configured'
    });
  }

  const cacheKey = placeDetailsKey(place_id);

  // Check cache first (session token not part of cache key)
  const cached = getCached(geocodeCache, cacheKey, GEOCODE_CACHE_TTL);
  if (cached) {
    console.log(`📍 [GEOCODE] Cache HIT for place: ${place_id.substring(0, 20)}...`);
    return res.json({ success: true, result: cached, cached: true });
  }

  try {
    console.log(`📍 [GEOCODE] Cache MISS - Fetching place details for: ${place_id.substring(0, 20)}...`);
    const fieldsParam = fields || 'geometry,formatted_address,address_components,name';
    let url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place_id}&fields=${fieldsParam}&key=${GOOGLE_MAPS_API_KEY}`;

    // Pass through session token for billing optimization (FREE Place Details with same session)
    if (sessiontoken) {
      url += `&sessiontoken=${sessiontoken}`;
      console.log(`🎫 [GEOCODE] Using session token for place details: ${sessiontoken.substring(0, 8)}...`);
    }

    const response = await fetch(url);
    const data = await response.json();

    if (data.status === 'OK' && data.result) {
      // Cache the successful result
      setCache(geocodeCache, cacheKey, data.result);
      console.log(`✅ [GEOCODE] Cached place details for: ${place_id.substring(0, 20)}...`);
      return res.json({ success: true, result: data.result, cached: false });
    } else {
      console.log(`⚠️ [GEOCODE] Google API returned status: ${data.status}`);
      return res.json({
        success: false,
        error: data.status,
        error_message: data.error_message
      });
    }
  } catch (error) {
    console.error('❌ [GEOCODE] Place details error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Places Autocomplete: Search for places
 * GET /api/geocode/autocomplete?input=peshawar&lat=34.0&lng=71.5&sessiontoken=xxx
 *
 * SESSION TOKEN (Phase 3):
 * - Groups autocomplete requests into billing sessions
 * - All autocomplete requests with same session token = 1 billable request
 * - Use same token in subsequent Place Details call = FREE Place Details
 * - Cache key does NOT include session token (same input = same cached results)
 */
app.get('/api/geocode/autocomplete', async (req, res) => {
  const { input, lat, lng, radius, types, components, sessiontoken } = req.query;

  if (!input || input.length < 2) {
    return res.status(400).json({
      success: false,
      error: 'Input must be at least 2 characters'
    });
  }

  if (!GOOGLE_MAPS_API_KEY) {
    return res.status(500).json({
      success: false,
      error: 'Google Maps API key not configured'
    });
  }

  const cacheKey = autocompleteKey(input, lat, lng);

  // Check cache first (session token not part of cache key)
  const cached = getCached(autocompleteCache, cacheKey, AUTOCOMPLETE_CACHE_TTL);
  if (cached) {
    console.log(`📍 [GEOCODE] Cache HIT for autocomplete: "${input}"`);
    return res.json({ success: true, predictions: cached, cached: true });
  }

  try {
    console.log(`📍 [GEOCODE] Cache MISS - Fetching autocomplete for: "${input}"`);
    let url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&key=${GOOGLE_MAPS_API_KEY}`;

    // Add location bias if provided
    if (lat && lng) {
      url += `&location=${lat},${lng}&radius=${radius || 50000}`;
    }

    // Add components filter (default to Pakistan)
    url += `&components=${components || 'country:pk'}`;

    // Add types filter if provided
    if (types) {
      url += `&types=${types}`;
    }

    // Pass through session token for billing optimization
    if (sessiontoken) {
      url += `&sessiontoken=${sessiontoken}`;
      console.log(`🎫 [GEOCODE] Using session token for autocomplete: ${sessiontoken.substring(0, 8)}...`);
    }

    const response = await fetch(url);
    const data = await response.json();

    if (data.status === 'OK' || data.status === 'ZERO_RESULTS') {
      const predictions = data.predictions || [];
      // Cache the result
      setCache(autocompleteCache, cacheKey, predictions, MAX_CACHE_SIZE / 2);
      console.log(`✅ [GEOCODE] Cached autocomplete (${predictions.length} results) for: "${input}"`);
      return res.json({ success: true, predictions, cached: false });
    } else {
      console.log(`⚠️ [GEOCODE] Google API returned status: ${data.status}`);
      return res.json({
        success: false,
        error: data.status,
        error_message: data.error_message
      });
    }
  } catch (error) {
    console.error('❌ [GEOCODE] Autocomplete error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Geocode by address or place_id
 * GET /api/geocode/forward?address=peshawar OR ?place_id=ChIJ...
 */
app.get('/api/geocode/forward', async (req, res) => {
  const { address, place_id } = req.query;

  if (!address && !place_id) {
    return res.status(400).json({
      success: false,
      error: 'Missing required parameter: address or place_id'
    });
  }

  if (!GOOGLE_MAPS_API_KEY) {
    return res.status(500).json({
      success: false,
      error: 'Google Maps API key not configured'
    });
  }

  const cacheKey = place_id ? placeDetailsKey(place_id) : `address:${address.toLowerCase().trim()}`;

  // Check cache first
  const cached = getCached(geocodeCache, cacheKey, GEOCODE_CACHE_TTL);
  if (cached) {
    console.log(`📍 [GEOCODE] Cache HIT for forward geocode`);
    return res.json({ success: true, results: cached, cached: true });
  }

  try {
    console.log(`📍 [GEOCODE] Cache MISS - Fetching forward geocode`);
    let url = `https://maps.googleapis.com/maps/api/geocode/json?key=${GOOGLE_MAPS_API_KEY}`;

    if (place_id) {
      url += `&place_id=${place_id}`;
    } else {
      url += `&address=${encodeURIComponent(address)}`;
    }

    const response = await fetch(url);
    const data = await response.json();

    if (data.status === 'OK' && data.results) {
      // Cache the successful result
      setCache(geocodeCache, cacheKey, data.results);
      console.log(`✅ [GEOCODE] Cached forward geocode result`);
      return res.json({ success: true, results: data.results, cached: false });
    } else {
      console.log(`⚠️ [GEOCODE] Google API returned status: ${data.status}`);
      return res.json({
        success: false,
        error: data.status,
        error_message: data.error_message
      });
    }
  } catch (error) {
    console.error('❌ [GEOCODE] Forward geocode error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================================================
// DIRECTIONS API ENDPOINT (Phase 4)
// =============================================================================

/**
 * Get directions between two points with caching
 * GET /api/directions?origin_lat=X&origin_lng=Y&dest_lat=X&dest_lng=Y&mode=driving
 *
 * Caches full route response for 6 hours.
 * Returns: polyline, distance, duration, and full legs data.
 */
app.get('/api/directions', async (req, res) => {
  const { origin_lat, origin_lng, dest_lat, dest_lng, mode = 'driving' } = req.query;

  if (!origin_lat || !origin_lng || !dest_lat || !dest_lng) {
    return res.status(400).json({
      success: false,
      error: 'Missing required parameters: origin_lat, origin_lng, dest_lat, dest_lng'
    });
  }

  if (!GOOGLE_MAPS_API_KEY) {
    return res.status(500).json({
      success: false,
      error: 'Google Maps API key not configured'
    });
  }

  const cacheKey = directionsKey(origin_lat, origin_lng, dest_lat, dest_lng, mode);

  // Check cache first
  const cached = getCached(directionsCache, cacheKey, DIRECTIONS_CACHE_TTL);
  if (cached) {
    console.log(`🛣️ [DIRECTIONS] Cache HIT for route: ${cacheKey}`);
    return res.json({ success: true, ...cached, cached: true });
  }

  try {
    console.log(`🛣️ [DIRECTIONS] Cache MISS - Fetching directions for: ${cacheKey}`);
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin_lat},${origin_lng}&destination=${dest_lat},${dest_lng}&mode=${mode}&key=${GOOGLE_MAPS_API_KEY}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.status === 'OK' && data.routes && data.routes.length > 0) {
      const route = data.routes[0];
      const leg = route.legs[0];

      // Extract the commonly needed data
      const result = {
        polyline: route.overview_polyline.points,
        distance: {
          value: leg.distance.value, // meters
          text: leg.distance.text
        },
        duration: {
          value: leg.duration.value, // seconds
          text: leg.duration.text
        },
        startAddress: leg.start_address,
        endAddress: leg.end_address,
        bounds: route.bounds,
        // Include full legs for detailed step-by-step directions if needed
        legs: route.legs
      };

      // Cache the result
      setCache(directionsCache, cacheKey, result, MAX_CACHE_SIZE / 2);
      console.log(`✅ [DIRECTIONS] Cached route: ${leg.distance.text}, ${leg.duration.text}`);

      return res.json({ success: true, ...result, cached: false });
    } else {
      console.log(`⚠️ [DIRECTIONS] Google API returned status: ${data.status}`);
      return res.json({
        success: false,
        error: data.status,
        error_message: data.error_message
      });
    }
  } catch (error) {
    console.error('❌ [DIRECTIONS] Error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Cache statistics endpoint for monitoring
 * GET /api/geocode/stats
 */
app.get('/api/geocode/stats', (req, res) => {
  const hitRate = cacheStats.hits + cacheStats.misses > 0
    ? ((cacheStats.hits / (cacheStats.hits + cacheStats.misses)) * 100).toFixed(2)
    : 0;

  res.json({
    success: true,
    stats: {
      ...cacheStats,
      hitRate: `${hitRate}%`,
      geocodeCacheSize: geocodeCache.size,
      autocompleteCacheSize: autocompleteCache.size,
      directionsCacheSize: directionsCache.size,
      maxCacheSize: MAX_CACHE_SIZE,
      geocodeTTL: `${GEOCODE_CACHE_TTL / 1000 / 60 / 60} hours`,
      autocompleteTTL: `${AUTOCOMPLETE_CACHE_TTL / 1000 / 60 / 60} hours`,
      directionsTTL: `${DIRECTIONS_CACHE_TTL / 1000 / 60 / 60} hours`
    }
  });
});

/**
 * Clear all API caches (admin endpoint)
 * POST /api/geocode/clear-cache
 */
app.post('/api/geocode/clear-cache', (req, res) => {
  const geocodeSize = geocodeCache.size;
  const autocompleteSize = autocompleteCache.size;
  const directionsSize = directionsCache.size;

  geocodeCache.clear();
  autocompleteCache.clear();
  directionsCache.clear();
  cacheStats = { hits: 0, misses: 0, evictions: 0 };

  console.log(`🗑️ [CACHE] Cleared: ${geocodeSize} geocode + ${autocompleteSize} autocomplete + ${directionsSize} directions entries`);

  res.json({
    success: true,
    message: `Cleared ${geocodeSize + autocompleteSize + directionsSize} cache entries`
  });
});

// =============================================================================
// NOTIFICATION ENDPOINTS
// =============================================================================

// HTTP endpoint to receive notification requests
app.post('/notify', async (req, res) => {
  const { type, payload } = req.body;

  console.log(`📨 Received notification request: ${type}`);
  console.log(`📦 Payload:`, JSON.stringify(payload, null, 2));

  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.log('⚠️ WebSocket not connected, attempting to reconnect...');
      connectWebSocket();
      return res.status(503).json({ success: false, error: 'WebSocket not connected' });
    }

    // Handle different event types
    switch(type) {
      case 'bid_accepted':
        console.log('🎯 BID_ACCEPTED notification received!');
        console.log('🔍 bid_accepted payload received:', JSON.stringify(payload, null, 2));
        console.log('🔍 Driver ID:', payload.driverId);
        console.log('🔍 Trip ID:', payload.tripId);
        console.log('🔍 Has pickupLocation?', !!payload.pickupLocation);
        console.log('🔍 Has dropoffLocation?', !!payload.dropoffLocation);

        // Check WebSocket connection
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          console.error('❌ WebSocket not connected! Cannot forward bid_accepted');
          return res.status(503).json({ success: false, error: 'WebSocket not connected' });
        }

        // Notify the accepted driver
        const messageToSend = {
          type: 'bid_accepted',
          payload
        };
        console.log('📤 Sending bid_accepted to WebSocket server:', JSON.stringify(messageToSend, null, 2));
        ws.send(JSON.stringify(messageToSend));
        console.log('✅ bid_accepted forwarded to WebSocket server');

        // Notify rejected drivers
        if (payload.rejectedDrivers) {
          payload.rejectedDrivers.forEach(driverId => {
            ws.send(JSON.stringify({
              type: 'bid_rejected',
              payload: { driverId, bookingId: payload.bookingId }
            }));
          });
        }
        break;

      case 'driver_arrived':
        // Notify passenger that driver has arrived
        ws.send(JSON.stringify({ type, payload }));
        break;

      case 'passenger_ready':
        // Notify driver that passenger is ready
        ws.send(JSON.stringify({ type, payload }));
        break;

      case 'trip_started':
        // Notify passenger that trip has started
        ws.send(JSON.stringify({ type, payload }));
        break;

      case 'driver_location_update':
        // Broadcast driver location to passenger
        ws.send(JSON.stringify({ type, payload }));
        break;

      case 'trip_ended':
        // Notify both driver and passenger
        ws.send(JSON.stringify({ type, payload }));
        break;

      case 'driver_accepted_request':
        // Forward driver acceptance notification to passenger
        console.log('✅ DRIVER_ACCEPTED_REQUEST notification received!');
        console.log('🔍 Passenger ID:', payload.passengerId);
        console.log('🔍 Driver ID:', payload.driverId);
        console.log('🔍 Request ID:', payload.requestId);
        ws.send(JSON.stringify({ type, payload }));
        console.log('📤 Forwarded driver_accepted_request to WebSocket server');
        break;

      case 'passenger_ride_request':
        // Forward passenger request notification to driver
        console.log('🚕 PASSENGER_RIDE_REQUEST notification received!');
        console.log('🔍 Driver ID:', payload.driverId);
        console.log('🔍 Passenger ID:', payload.passengerId);
        ws.send(JSON.stringify({ type, payload }));
        console.log('📤 Forwarded passenger_ride_request to WebSocket server');
        break;

      case 'driver_rejected_request':
        // Forward driver rejection notification to passenger
        console.log('❌ DRIVER_REJECTED_REQUEST notification received!');
        console.log('🔍 Passenger ID:', payload.passengerId);
        console.log('🔍 Request ID:', payload.requestId);
        ws.send(JSON.stringify({ type, payload }));
        console.log('📤 Forwarded driver_rejected_request to WebSocket server');
        break;

      case 'new_trip_request':
        // Forward new trip request to drivers
        console.log('🚕 NEW_TRIP_REQUEST notification received!');
        console.log('🔍 Full payload:', JSON.stringify(payload, null, 2));
        console.log('🔍 Trip Request ID:', payload.tripRequest?.id || payload.id);
        console.log('🔍 Rider ID:', payload.tripRequest?.riderId || payload.riderId);
        console.log('🔍 Vehicle Type:', payload.vehicleType);
        console.log('🔍 Estimated Fare:', payload.estimatedFare);
        ws.send(JSON.stringify({ type, payload }));
        console.log('📤 Forwarded new_trip_request to WebSocket server');
        break;

      case 'city_trip_accepted':
        // Forward city trip accepted notification
        console.log('✅ CITY_TRIP_ACCEPTED notification received!');
        console.log('🔍 Trip ID:', payload.tripId);
        console.log('🔍 Driver ID:', payload.driverId);
        console.log('🔍 Passenger ID:', payload.userId);
        ws.send(JSON.stringify({ type, payload }));
        console.log('📤 Forwarded city_trip_accepted to WebSocket server');
        break;

      case 'city_trip_rejected':
        // Forward city trip rejected notification
        console.log('❌ CITY_TRIP_REJECTED notification received!');
        console.log('🔍 Trip ID:', payload.tripId);
        console.log('🔍 Driver ID:', payload.driverId);
        console.log('🔍 Passenger ID:', payload.userId);
        ws.send(JSON.stringify({ type, payload }));
        console.log('📤 Forwarded city_trip_rejected to WebSocket server');
        break;

      case 'city_trip_counter_offer':
        // Forward city trip counter offer notification
        console.log('💰 CITY_TRIP_COUNTER_OFFER notification received!');
        console.log('🔍 Trip ID:', payload.tripId);
        console.log('🔍 Driver Proposed Price:', payload.driverProposedPrice);
        console.log('🔍 Passenger ID:', payload.userId);
        ws.send(JSON.stringify({ type, payload }));
        console.log('📤 Forwarded city_trip_counter_offer to WebSocket server');
        break;

      case 'city_trip_price_agreed':
        // Forward city trip price agreed notification
        console.log('🤝 CITY_TRIP_PRICE_AGREED notification received!');
        console.log('🔍 Trip ID:', payload.tripId);
        console.log('🔍 Final Price:', payload.finalPrice);
        console.log('🔍 Driver ID:', payload.userId);
        ws.send(JSON.stringify({ type, payload }));
        console.log('📤 Forwarded city_trip_price_agreed to WebSocket server');
        break;

      case 'city_trip_started':
        // Forward city trip started notification
        console.log('🚗 CITY_TRIP_STARTED notification received!');
        console.log('🔍 Trip ID:', payload.tripId);
        ws.send(JSON.stringify({ type, payload }));
        console.log('📤 Forwarded city_trip_started to WebSocket server');
        break;

      case 'city_trip_completed':
        // Forward city trip completed notification
        console.log('🏁 CITY_TRIP_COMPLETED notification received!');
        console.log('🔍 Trip ID:', payload.tripId);
        console.log('🔍 Final Price:', payload.finalPrice);
        ws.send(JSON.stringify({ type, payload }));
        console.log('📤 Forwarded city_trip_completed to WebSocket server');
        break;

      case 'subscription_cancelled':
      case 'subscription_paused':
        // Forward subscription cancellation/pause notification to driver
        console.log(`🔔 ${type.toUpperCase()} notification received!`);
        console.log('🔍 Driver ID:', payload.driverId);
        console.log('🔍 Passenger ID:', payload.passengerId);
        console.log('🔍 Subscription ID:', payload.subscriptionId);
        console.log('🔍 Passenger Name:', payload.passengerName);
        console.log('🔍 Destination:', payload.destinationName);
        ws.send(JSON.stringify({ type, payload }));
        console.log(`📤 Forwarded ${type} to WebSocket server`);
        break;

      default:
        // Forward any other message types
        console.log(`📨 Forwarding unknown message type: ${type}`);
        ws.send(JSON.stringify({ type, payload }));
    }

    console.log(`✅ Sent WebSocket message: ${type}`);
    res.json({ success: true, message: 'Notification sent' });

  } catch (error) {
    console.error('Failed to send WebSocket notification:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'websocket-bridge' });
});

app.listen(PORT, () => {
  console.log(`🌉 WebSocket Bridge Server running on port ${PORT}`);
  console.log(`📡 Forwarding notifications to: ${WS_URL}`);
});