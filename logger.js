/**
 * Production-Safe Logger for WebSocket Server
 * Automatically disables verbose logging in production
 * Preserves error logging for debugging production issues
 */

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const LOG_LEVEL = process.env.LOG_LEVEL || (IS_PRODUCTION ? 'error' : 'debug');

// Log levels: debug < info < warn < error
const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

const currentLevel = LOG_LEVELS[LOG_LEVEL] || 0;

/**
 * Format log message with timestamp
 */
function formatMessage(level, args) {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] [${level.toUpperCase()}]`;
}

const logger = {
  /**
   * Debug messages - only in development
   */
  debug(...args) {
    if (currentLevel <= LOG_LEVELS.debug) {
      console.log(formatMessage('debug', args), ...args);
    }
  },

  /**
   * Info messages - development and verbose production
   */
  info(...args) {
    if (currentLevel <= LOG_LEVELS.info) {
      console.log(formatMessage('info', args), ...args);
    }
  },

  /**
   * Log messages - alias for info
   */
  log(...args) {
    if (currentLevel <= LOG_LEVELS.info) {
      console.log(formatMessage('info', args), ...args);
    }
  },

  /**
   * Warning messages - always in development, errors in production
   */
  warn(...args) {
    if (currentLevel <= LOG_LEVELS.warn) {
      console.warn(formatMessage('warn', args), ...args);
    }
  },

  /**
   * Error messages - always logged
   */
  error(...args) {
    if (currentLevel <= LOG_LEVELS.error) {
      console.error(formatMessage('error', args), ...args);
    }
  },

  /**
   * Check if we're in production
   */
  isProduction() {
    return IS_PRODUCTION;
  },

  /**
   * Get current log level
   */
  getLevel() {
    return LOG_LEVEL;
  }
};

module.exports = logger;
