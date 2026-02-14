/**
 * Firebase Cloud Messaging (FCM) Service
 * Sends push notifications directly via Firebase Admin SDK
 */

const admin = require('firebase-admin');
const fetch = require('node-fetch');

// Initialize Firebase Admin SDK
let firebaseApp = null;

function initializeFirebase() {
  if (firebaseApp) return firebaseApp;

  try {
    // Check for service account credentials
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
      ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
      : null;

    if (serviceAccount) {
      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: serviceAccount.project_id || process.env.FIREBASE_PROJECT_ID
      });
      console.log('[FCM] Firebase initialized with service account');
    } else if (process.env.FIREBASE_PROJECT_ID) {
      // Use application default credentials
      firebaseApp = admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        projectId: process.env.FIREBASE_PROJECT_ID
      });
      console.log('[FCM] Firebase initialized with application default credentials');
    } else {
      console.warn('[FCM] Firebase not initialized - no credentials provided');
      console.warn('[FCM] Set FIREBASE_SERVICE_ACCOUNT or FIREBASE_PROJECT_ID environment variable');
      return null;
    }

    return firebaseApp;
  } catch (error) {
    console.error('[FCM] Failed to initialize Firebase:', error.message);
    return null;
  }
}

// Initialize on module load
initializeFirebase();

const API_URL = process.env.API_URL || process.env.EXPO_PUBLIC_API_URL;

class FCMNotificationService {
  constructor() {
    this.messaging = firebaseApp ? admin.messaging() : null;
  }

  /**
   * Check if FCM is available
   */
  isAvailable() {
    return !!this.messaging;
  }

  /**
   * Send notification to a single device
   * @param {string} fcmToken - FCM device token
   * @param {string} title - Notification title
   * @param {string} body - Notification body
   * @param {object} data - Additional data
   * @param {object} options - Android/iOS specific options
   */
  async sendToDevice(fcmToken, title, body, data = {}, options = {}) {
    if (!this.messaging) {
      console.error('[FCM] Firebase not initialized');
      return { success: false, error: 'FCM not initialized' };
    }

    if (!fcmToken) {
      console.error('[FCM] No FCM token provided');
      return { success: false, error: 'No FCM token' };
    }

    try {
      // Ensure all data values are strings (FCM requirement)
      const stringifiedData = {};
      for (const [key, value] of Object.entries(data)) {
        stringifiedData[key] = typeof value === 'string' ? value : JSON.stringify(value);
      }

      const message = {
        token: fcmToken,
        notification: {
          title,
          body
        },
        data: stringifiedData,
        android: {
          priority: options.priority || 'high',
          notification: {
            channelId: options.channelId || 'default',
            sound: options.sound || 'default',
            priority: 'max',
            defaultVibrateTimings: true,
            defaultSound: true
          }
        },
        apns: {
          payload: {
            aps: {
              alert: {
                title,
                body
              },
              sound: options.sound || 'default',
              badge: options.badge || 1,
              'content-available': 1
            }
          }
        }
      };

      const response = await this.messaging.send(message);
      console.log(`[FCM] Notification sent successfully: ${response}`);
      return { success: true, messageId: response };
    } catch (error) {
      console.error('[FCM] Failed to send notification:', error.message);

      // Handle invalid token
      if (error.code === 'messaging/invalid-registration-token' ||
          error.code === 'messaging/registration-token-not-registered') {
        return { success: false, error: 'Invalid token', invalidToken: true };
      }

      return { success: false, error: error.message };
    }
  }

  /**
   * Send notification to multiple devices
   * @param {string[]} fcmTokens - Array of FCM tokens
   * @param {string} title - Notification title
   * @param {string} body - Notification body
   * @param {object} data - Additional data
   */
  async sendToMultipleDevices(fcmTokens, title, body, data = {}, options = {}) {
    if (!this.messaging) {
      return { success: false, error: 'FCM not initialized' };
    }

    if (!fcmTokens || fcmTokens.length === 0) {
      return { success: false, error: 'No FCM tokens' };
    }

    // Ensure all data values are strings
    const stringifiedData = {};
    for (const [key, value] of Object.entries(data)) {
      stringifiedData[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }

    try {
      const message = {
        notification: {
          title,
          body
        },
        data: stringifiedData,
        android: {
          priority: options.priority || 'high',
          notification: {
            channelId: options.channelId || 'default',
            sound: options.sound || 'default'
          }
        },
        apns: {
          payload: {
            aps: {
              sound: options.sound || 'default'
            }
          }
        },
        tokens: fcmTokens
      };

      const response = await this.messaging.sendEachForMulticast(message);
      console.log(`[FCM] Multicast sent: ${response.successCount} success, ${response.failureCount} failed`);

      return {
        success: true,
        successCount: response.successCount,
        failureCount: response.failureCount,
        responses: response.responses
      };
    } catch (error) {
      console.error('[FCM] Multicast failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send notification to a topic
   * @param {string} topic - Topic name
   * @param {string} title - Notification title
   * @param {string} body - Notification body
   * @param {object} data - Additional data
   */
  async sendToTopic(topic, title, body, data = {}, options = {}) {
    if (!this.messaging) {
      return { success: false, error: 'FCM not initialized' };
    }

    // Ensure all data values are strings
    const stringifiedData = {};
    for (const [key, value] of Object.entries(data)) {
      stringifiedData[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }

    try {
      const message = {
        topic,
        notification: {
          title,
          body
        },
        data: stringifiedData,
        android: {
          priority: options.priority || 'high',
          notification: {
            channelId: options.channelId || 'default',
            sound: options.sound || 'default'
          }
        }
      };

      const response = await this.messaging.send(message);
      console.log(`[FCM] Topic notification sent: ${response}`);
      return { success: true, messageId: response };
    } catch (error) {
      console.error('[FCM] Topic send failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get FCM token for a user from API
   * @param {string|number} userId - User ID
   * @param {string} userType - 'driver' or 'rider'
   */
  async getUserFcmToken(userId, userType = 'rider') {
    try {
      const endpoint = userType === 'driver'
        ? `${API_URL}/api/drivers/${userId}/fcm-token`
        : `${API_URL}/api/users/${userId}/fcm-token`;

      const response = await fetch(endpoint);
      if (!response.ok) return null;

      const data = await response.json();
      return data.fcmToken || null;
    } catch (error) {
      console.error(`[FCM] Failed to get FCM token for ${userType} ${userId}:`, error.message);
      return null;
    }
  }

  // ============================================
  // TRIP NOTIFICATIONS
  // ============================================

  async notifyNewTripRequest(fcmToken, tripRequest) {
    return this.sendToDevice(
      fcmToken,
      '🚗 New Trip Request',
      `New ride request from ${tripRequest.pickupLocation?.address || 'passenger'}`,
      {
        type: 'NEW_TRIP_REQUEST',
        tripRequestId: String(tripRequest.id || tripRequest.tripRequestId),
        pickupAddress: tripRequest.pickupLocation?.address || '',
        dropoffAddress: tripRequest.dropoffLocation?.address || ''
      },
      { channelId: 'trip_request', priority: 'high' }
    );
  }

  async notifyBidAccepted(fcmToken, bidData) {
    return this.sendToDevice(
      fcmToken,
      '✅ Bid Accepted!',
      'Your bid has been accepted! Get ready to pick up the passenger.',
      {
        type: 'BID_ACCEPTED',
        tripId: String(bidData.tripId),
        bidAmount: String(bidData.bidAmount || bidData.fare || ''),
        passengerName: bidData.passengerName || ''
      },
      { channelId: 'bid_accepted', priority: 'high' }
    );
  }

  async notifyDriverArrived(fcmToken, driverData) {
    return this.sendToDevice(
      fcmToken,
      '🚗 Driver Has Arrived!',
      'Your driver has arrived at the pickup location.',
      {
        type: 'DRIVER_ARRIVED',
        tripId: String(driverData.tripId),
        driverName: driverData.driverName || '',
        vehicleNumber: driverData.vehicleNumber || ''
      },
      { channelId: 'driver_arrived', priority: 'high' }
    );
  }

  async notifyTripStarted(fcmToken, tripData) {
    return this.sendToDevice(
      fcmToken,
      '🚀 Trip Started!',
      'Your journey has begun. Have a safe trip!',
      {
        type: 'TRIP_STARTED',
        tripId: String(tripData.tripId)
      },
      { channelId: 'trip_status', priority: 'high' }
    );
  }

  async notifyTripCompleted(fcmToken, tripData) {
    return this.sendToDevice(
      fcmToken,
      '🎉 Trip Completed!',
      `Your trip has been completed. Fare: Rs.${tripData.fare}`,
      {
        type: 'TRIP_COMPLETED',
        tripId: String(tripData.tripId),
        fare: String(tripData.fare),
        driverId: String(tripData.driverId || ''),
        driverName: tripData.driverName || ''
      },
      { channelId: 'trip_status', priority: 'high' }
    );
  }

  async notifyTripCancelled(fcmToken, tripData) {
    return this.sendToDevice(
      fcmToken,
      '❌ Trip Cancelled',
      tripData.reason || 'The trip has been cancelled.',
      {
        type: 'TRIP_CANCELLED_BY_DRIVER',
        tripId: String(tripData.tripId),
        reason: tripData.reason || ''
      },
      { channelId: 'trip_cancelled', priority: 'high' }
    );
  }

  async notifyNewBid(fcmToken, bidData) {
    return this.sendToDevice(
      fcmToken,
      '💰 New Bid Received',
      `Driver placed a bid of Rs.${bidData.bidAmount}`,
      {
        type: 'NEW_BID_AVAILABLE',
        tripRequestId: String(bidData.tripRequestId),
        bidAmount: String(bidData.bidAmount),
        driverName: bidData.driverName || ''
      },
      { channelId: 'new_bid', priority: 'high' }
    );
  }

  // ============================================
  // SHARED RIDE NOTIFICATIONS
  // ============================================

  async notifySharedRideAccepted(fcmToken, data) {
    return this.sendToDevice(
      fcmToken,
      '✅ Ride Accepted!',
      `${data.driverName || 'Driver'} accepted your request`,
      {
        type: 'SHARED_RIDE_ACCEPTED',
        routeId: String(data.routeId || ''),
        tripId: String(data.tripId || ''),
        driverName: data.driverName || '',
        estimatedArrival: data.estimatedArrival || ''
      },
      { channelId: 'shared_ride', priority: 'high' }
    );
  }

  async notifySharedRideRejected(fcmToken, data) {
    return this.sendToDevice(
      fcmToken,
      '❌ Request Declined',
      'Driver declined your request. Try another route.',
      {
        type: 'SHARED_RIDE_REJECTED',
        routeId: String(data.routeId || ''),
        requestId: String(data.requestId || '')
      },
      { channelId: 'shared_ride', priority: 'default' }
    );
  }

  async notifyPassengerRideRequest(fcmToken, data) {
    return this.sendToDevice(
      fcmToken,
      '🚕 New Passenger Request',
      `${data.passengerName || 'Passenger'} wants to join - Rs.${data.fare}`,
      {
        type: 'PASSENGER_RIDE_REQUEST',
        routeId: String(data.routeId || ''),
        requestId: String(data.requestId || ''),
        passengerName: data.passengerName || '',
        fare: String(data.fare || '')
      },
      { channelId: 'passenger_request', priority: 'high' }
    );
  }

  // ============================================
  // CITY-TO-CITY NOTIFICATIONS
  // ============================================

  async notifyCityTripRequest(fcmToken, data) {
    return this.sendToDevice(
      fcmToken,
      '🏙️ City-to-City Request',
      `Trip from ${data.fromCity} to ${data.toCity} - Rs.${data.fare}`,
      {
        type: 'CITY_TRIP_REQUEST',
        cityTripId: String(data.cityTripId || ''),
        fromCity: data.fromCity || '',
        toCity: data.toCity || '',
        fare: String(data.fare || '')
      },
      { channelId: 'city_trip', priority: 'high' }
    );
  }

  async notifyCityTripAccepted(fcmToken, data) {
    return this.sendToDevice(
      fcmToken,
      '✅ City Trip Confirmed!',
      `${data.driverName || 'Driver'} accepted your trip`,
      {
        type: 'CITY_TRIP_ACCEPTED',
        cityTripId: String(data.cityTripId || ''),
        driverName: data.driverName || '',
        vehicleModel: data.vehicleModel || ''
      },
      { channelId: 'city_trip', priority: 'high' }
    );
  }

  async notifyCityTripPriceAgreed(fcmToken, data) {
    return this.sendToDevice(
      fcmToken,
      '✅ Price Agreed!',
      `Rs.${data.agreedFare} confirmed. Trip is scheduled!`,
      {
        type: 'CITY_TRIP_PRICE_AGREED',
        cityTripId: String(data.cityTripId || ''),
        agreedFare: String(data.agreedFare || '')
      },
      { channelId: 'city_trip', priority: 'high' }
    );
  }

  // ============================================
  // SUBSCRIPTION NOTIFICATIONS
  // ============================================

  async notifySubscriptionRequest(fcmToken, data) {
    return this.sendToDevice(
      fcmToken,
      '📅 Subscription Request',
      `${data.passengerName || 'Passenger'} wants monthly rides`,
      {
        type: 'SUBSCRIPTION_REQUEST',
        subscriptionId: String(data.subscriptionId || ''),
        passengerName: data.passengerName || '',
        route: data.route || ''
      },
      { channelId: 'subscription', priority: 'high' }
    );
  }

  async notifySubscriptionStatus(fcmToken, data) {
    const isAccepted = data.status === 'ACCEPTED';
    return this.sendToDevice(
      fcmToken,
      isAccepted ? '✅ Subscription Confirmed!' : '❌ Subscription Declined',
      isAccepted
        ? `${data.driverName || 'Driver'} will be your regular driver!`
        : data.reason || 'Driver is not available for monthly subscription.',
      {
        type: 'SUBSCRIPTION_STATUS',
        subscriptionId: String(data.subscriptionId || ''),
        status: data.status || '',
        driverName: data.driverName || ''
      },
      { channelId: 'subscription', priority: 'high' }
    );
  }

  // ============================================
  // DRIVER NOTIFICATIONS
  // ============================================

  async notifyDriverVerified(fcmToken, data) {
    return this.sendToDevice(
      fcmToken,
      '✅ Account Verified!',
      'Your account is now verified. You can start accepting rides!',
      {
        type: 'DRIVER_VERIFIED',
        driverId: String(data.driverId || ''),
        status: 'VERIFIED'
      },
      { channelId: 'driver_status', priority: 'high' }
    );
  }
}

const fcmNotificationService = new FCMNotificationService();
module.exports = fcmNotificationService;
