/**
 * Rate Limiter Module
 * Handles connection and message rate limiting
 */

const { RATE_LIMITS, RATE_LIMIT_CLEANUP_INTERVAL } = require('../config/constants');

// Rate limit tracking
const connectionAttempts = new Map(); // IP -> { count, firstAttempt }
const messageRateLimits = new Map(); // userId -> { count, windowStart }

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
    console.log(`[WS Rate Limit] Connection blocked for IP ${ip}: ${attempts.count} attempts`);
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
    console.log(`[WS Rate Limit] Messages blocked for user ${userId}: ${limit.count} messages/min`);
    return false;
  }

  limit.count++;
  return true;
}

/**
 * Cleanup old rate limit entries
 */
function cleanupRateLimits() {
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
}

/**
 * Start rate limit cleanup interval
 * @returns {NodeJS.Timeout} Interval ID
 */
function startCleanupInterval() {
  return setInterval(cleanupRateLimits, RATE_LIMIT_CLEANUP_INTERVAL);
}

/**
 * Get rate limit statistics
 * @returns {object} Rate limit stats
 */
function getRateLimitStats() {
  return {
    connectionAttemptTracking: connectionAttempts.size,
    messageRateLimitTracking: messageRateLimits.size,
  };
}

module.exports = {
  checkConnectionRateLimit,
  checkMessageRateLimit,
  cleanupRateLimits,
  startCleanupInterval,
  getRateLimitStats,
};
