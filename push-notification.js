// Push Notification Service for sending notifications via Supabase Edge Function
const SUPABASE_FUNCTION_URL = process.env.SUPABASE_URL
  ? `${process.env.SUPABASE_URL}/functions/v1/send-push`
  : null;

const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

class PushNotificationService {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
  }

  /**
   * Send push notification to a single user
   * @param {string} expoPushToken - Expo push token
   * @param {string} title - Notification title
   * @param {string} body - Notification body
   * @param {object} data - Additional data to send with notification
   * @param {object} options - Additional options (sound, badge, priority, etc.)
   */
  async sendToUser(expoPushToken, title, body, data = {}, options = {}) {
    if (!expoPushToken || !expoPushToken.startsWith('ExponentPushToken[')) {
      console.error('Invalid Expo push token:', expoPushToken);
      return { success: false, error: 'Invalid push token' };
    }

    return this.sendBatch([{
      to: expoPushToken,
      title,
      body,
      data,
      ...options
    }]);
  }

  /**
   * Send push notifications to multiple users
   * @param {Array} messages - Array of message objects
   */
  async sendBatch(messages) {
    if (!SUPABASE_FUNCTION_URL) {
      console.error('Supabase function URL not configured');
      return { success: false, error: 'Push notifications not configured' };
    }

    try {
      const response = await fetch(SUPABASE_FUNCTION_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        },
        body: JSON.stringify({ messages })
      });

      const result = await response.json();

      if (!response.ok) {
        console.error('Push notification error:', result);
        return { success: false, error: result.error };
      }

      return { success: true, ...result };
    } catch (error) {
      console.error('Failed to send push notifications:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Queue a notification for later delivery
   */
  queueNotification(notification) {
    this.queue.push(notification);
    this.processQueue();
  }

  /**
   * Process queued notifications
   */
  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;

    try {
      // Process in batches of 100 (Expo's limit)
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, 100);
        await this.sendBatch(batch);

        // Small delay to avoid rate limiting
        if (this.queue.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Send notification for new trip request to driver
   */
  async notifyNewTripRequest(driverToken, tripRequest) {
    return this.sendToUser(
      driverToken,
      '🚗 New Trip Request',
      `New ride request from ${tripRequest.pickupLocation?.address || 'passenger'}`,
      {
        type: 'new_trip_request',
        tripRequestId: tripRequest.id,
        tripRequest
      },
      {
        priority: 'high',
        sound: 'default',
        categoryId: 'trip_request'
      }
    );
  }

  /**
   * Send notification for bid accepted to driver
   */
  async notifyBidAccepted(driverToken, bidData) {
    return this.sendToUser(
      driverToken,
      '✅ Bid Accepted!',
      'Your bid has been accepted! Get ready to pick up the passenger.',
      {
        type: 'bid_accepted',
        tripId: bidData.tripId,
        ...bidData
      },
      {
        priority: 'high',
        sound: 'default',
        categoryId: 'bid_accepted'
      }
    );
  }

  /**
   * Send notification for driver arrived to passenger
   */
  async notifyDriverArrived(passengerToken, driverData) {
    return this.sendToUser(
      passengerToken,
      '🚗 Driver Has Arrived!',
      'Your driver has arrived at the pickup location.',
      {
        type: 'driver_arrived',
        tripId: driverData.tripId,
        ...driverData
      },
      {
        priority: 'high',
        sound: 'default',
        categoryId: 'driver_arrived'
      }
    );
  }

  /**
   * Send notification for trip started to passenger
   */
  async notifyTripStarted(passengerToken, tripData) {
    return this.sendToUser(
      passengerToken,
      '🚀 Trip Started!',
      'Your journey has begun. Have a safe trip!',
      {
        type: 'trip_started',
        tripId: tripData.tripId,
        ...tripData
      },
      {
        priority: 'normal',
        sound: 'default',
        categoryId: 'trip_started'
      }
    );
  }

  /**
   * Send notification for trip completed
   */
  async notifyTripCompleted(userToken, tripData) {
    return this.sendToUser(
      userToken,
      '🎉 Trip Completed!',
      `Your trip has been completed. Fare: Rs.${tripData.fare}`,
      {
        type: 'trip_completed',
        tripId: tripData.tripId,
        ...tripData
      },
      {
        priority: 'normal',
        sound: 'default',
        categoryId: 'trip_completed'
      }
    );
  }

  /**
   * Send notification for trip cancelled
   */
  async notifyTripCancelled(userToken, tripData) {
    return this.sendToUser(
      userToken,
      '❌ Trip Cancelled',
      tripData.reason || 'The trip has been cancelled.',
      {
        type: 'trip_cancelled',
        tripId: tripData.tripId,
        ...tripData
      },
      {
        priority: 'high',
        sound: 'default',
        categoryId: 'trip_cancelled'
      }
    );
  }

  /**
   * Send notification for new bid to passenger
   */
  async notifyNewBid(passengerToken, bidData) {
    return this.sendToUser(
      passengerToken,
      '💰 New Bid Received',
      `Driver placed a bid of Rs.${bidData.bidAmount}`,
      {
        type: 'new_bid',
        tripRequestId: bidData.tripRequestId,
        ...bidData
      },
      {
        priority: 'high',
        sound: 'default',
        categoryId: 'new_bid'
      }
    );
  }
}

const pushNotificationService = new PushNotificationService();
module.exports = pushNotificationService;
