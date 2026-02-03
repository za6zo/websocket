/**
 * WebSocket Server Configuration Constants
 * Centralized configuration for ports, security, and rate limiting
 */

// Server ports
const WS_PORT = process.env.WS_PORT || 8080;
const HTTP_PORT = process.env.HTTP_PORT || 8090;
const API_URL = process.env.API_URL || 'http://localhost:3000';

// Security settings
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET;
const EFFECTIVE_JWT_SECRET = JWT_SECRET || 'dev-secret-change-in-production-12345678';
const NOTIFY_API_KEY = process.env.NOTIFY_API_KEY || EFFECTIVE_JWT_SECRET;

// Heartbeat configuration
const CONNECTION_TIMEOUT = 60000; // 60 seconds - close if no heartbeat
const HEARTBEAT_INTERVAL = 30000; // 30 seconds - check interval

// Rate limit configuration
const RATE_LIMITS = {
  CONNECTION_ATTEMPTS: {
    maxAttempts: 20,
    windowMs: 60 * 1000, // 1 minute
  },
  MESSAGES: {
    maxMessages: 100,
    windowMs: 60 * 1000, // 1 minute
  },
  MAX_CONNECTIONS_PER_USER: 3,
  MAX_TOTAL_CONNECTIONS: 10000,
};

// JWT settings
const JWT_OPTIONS = {
  issuer: 'za6zo-backend',
  audience: 'za6zo-mobile',
  gracePeriod: 7 * 24 * 60 * 60, // 7 days in seconds
  refreshWarningThreshold: 86400, // 1 day in seconds
};

// Rate limit cleanup interval (5 minutes)
const RATE_LIMIT_CLEANUP_INTERVAL = 5 * 60 * 1000;

/**
 * Validate required environment variables for production
 * @param {object} logger - Logger instance
 * @returns {boolean} True if valid, exits process if invalid in production
 */
function validateProductionConfig(logger) {
  if (!JWT_SECRET) {
    if (IS_PRODUCTION) {
      logger.error('CRITICAL: JWT_SECRET is not set! Server cannot start in production without it.');
      process.exit(1);
    } else {
      logger.warn('JWT_SECRET not set - using development default (NOT SAFE FOR PRODUCTION)');
    }
  }
  return true;
}

module.exports = {
  WS_PORT,
  HTTP_PORT,
  API_URL,
  IS_PRODUCTION,
  JWT_SECRET,
  EFFECTIVE_JWT_SECRET,
  NOTIFY_API_KEY,
  CONNECTION_TIMEOUT,
  HEARTBEAT_INTERVAL,
  RATE_LIMITS,
  JWT_OPTIONS,
  RATE_LIMIT_CLEANUP_INTERVAL,
  validateProductionConfig,
};
