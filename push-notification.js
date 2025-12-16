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

  // ============================================
  // SHARED RIDE NOTIFICATIONS
  // ============================================

  /**
   * Notify passenger shared ride request was accepted
   */
  async notifySharedRideAccepted(passengerToken, data) {
    const { driverName, vehicleModel, estimatedArrival, routeId, tripId } = data;
    return this.sendToUser(
      passengerToken,
      '✅ Ride Accepted!',
      `${driverName || 'Driver'} accepted your request. Arriving in ${estimatedArrival || '10 mins'}`,
      {
        type: 'SHARED_RIDE_ACCEPTED',
        routeId,
        tripId,
        driverName,
        vehicleModel,
        estimatedArrival,
        screen: 'WaitingForDriverPanel'
      },
      {
        priority: 'high',
        sound: 'default',
        channelId: 'shared_ride'
      }
    );
  }

  /**
   * Notify passenger shared ride request was rejected
   */
  async notifySharedRideRejected(passengerToken, data) {
    const { routeId, requestId } = data;
    return this.sendToUser(
      passengerToken,
      '❌ Request Declined',
      'Driver declined your request. Try another route.',
      {
        type: 'SHARED_RIDE_REJECTED',
        routeId,
        requestId,
        screen: 'HomeScreen'
      },
      {
        priority: 'default',
        sound: 'default',
        channelId: 'shared_ride'
      }
    );
  }

  /**
   * Notify passenger about route update
   */
  async notifySharedRideRouteUpdated(passengerToken, data) {
    const { routeId, tripId, newETA } = data;
    return this.sendToUser(
      passengerToken,
      '🔄 Route Updated',
      `Driver updated the route. New ETA: ${newETA}`,
      {
        type: 'SHARED_RIDE_ROUTE_UPDATED',
        routeId,
        tripId,
        newETA,
        screen: 'WaitingForDriverPanel'
      },
      {
        priority: 'default',
        sound: 'default',
        channelId: 'shared_ride'
      }
    );
  }

  /**
   * Notify passenger another passenger joined
   */
  async notifyOtherPassengerJoined(passengerToken, data) {
    const { routeId, tripId, seatsAvailable } = data;
    return this.sendToUser(
      passengerToken,
      '👥 Passenger Joined',
      `Another passenger joined the ride. Seats left: ${seatsAvailable}`,
      {
        type: 'OTHER_PASSENGER_JOINED',
        routeId,
        tripId,
        seatsAvailable,
        screen: 'WaitingForDriverPanel'
      },
      {
        priority: 'default',
        sound: 'default',
        channelId: 'shared_ride'
      }
    );
  }

  /**
   * Notify passenger that route was cancelled
   */
  async notifyRouteCancelled(passengerToken, data) {
    const { routeId, reason } = data;
    return this.sendToUser(
      passengerToken,
      '❌ Route Cancelled',
      reason || 'The driver cancelled this route.',
      {
        type: 'ROUTE_CANCELLED',
        routeId,
        reason,
        screen: 'HomeScreen'
      },
      {
        priority: 'high',
        sound: 'default',
        channelId: 'shared_ride'
      }
    );
  }

  /**
   * Notify driver about new passenger request
   */
  async notifyPassengerRideRequest(driverToken, data) {
    const { passengerName, fare, pickupLocation, routeId, requestId } = data;
    return this.sendToUser(
      driverToken,
      '🚕 New Passenger Request',
      `${passengerName || 'Passenger'} wants to join - Rs.${fare}`,
      {
        type: 'PASSENGER_RIDE_REQUEST',
        routeId,
        requestId,
        passengerName,
        fare,
        pickupLocation,
        screen: 'ActiveRoutePanel'
      },
      {
        priority: 'high',
        sound: 'default',
        channelId: 'passenger_request'
      }
    );
  }

  /**
   * Notify driver passenger cancelled request
   */
  async notifyPassengerRequestCancelled(driverToken, data) {
    const { passengerName, routeId, requestId } = data;
    return this.sendToUser(
      driverToken,
      '❌ Request Cancelled',
      `${passengerName || 'Passenger'} cancelled their request`,
      {
        type: 'PASSENGER_REQUEST_CANCELLED',
        routeId,
        requestId,
        passengerName,
        screen: 'ActiveRoutePanel'
      },
      {
        priority: 'default',
        sound: 'default',
        channelId: 'passenger_request'
      }
    );
  }

  // ============================================
  // CITY-TO-CITY NOTIFICATIONS
  // ============================================

  /**
   * Notify driver about city trip request
   */
  async notifyCityTripRequest(driverToken, data) {
    const { fromCity, toCity, fare, cityTripId, passengerId } = data;
    return this.sendToUser(
      driverToken,
      '🏙️ City-to-City Request',
      `Trip from ${fromCity} to ${toCity} - Rs.${fare}`,
      {
        type: 'CITY_TRIP_REQUEST',
        cityTripId,
        passengerId,
        fromCity,
        toCity,
        fare,
        screen: 'CityTripRequests'
      },
      {
        priority: 'high',
        sound: 'default',
        channelId: 'city_trip'
      }
    );
  }

  /**
   * Notify driver about direct city trip request
   */
  async notifyCityTripDirectRequest(driverToken, data) {
    const { passengerName, fromCity, toCity, fare, cityTripId } = data;
    return this.sendToUser(
      driverToken,
      '🎯 Direct Trip Request',
      `${passengerName || 'Passenger'} requested you for ${fromCity} to ${toCity}`,
      {
        type: 'CITY_TRIP_DIRECT_REQUEST',
        cityTripId,
        passengerName,
        fromCity,
        toCity,
        fare,
        screen: 'CityTripRequests'
      },
      {
        priority: 'high',
        sound: 'default',
        channelId: 'city_trip'
      }
    );
  }

  /**
   * Notify passenger city trip was accepted
   */
  async notifyCityTripAccepted(passengerToken, data) {
    const { driverName, vehicleModel, cityTripId, departureTime } = data;
    return this.sendToUser(
      passengerToken,
      '✅ City Trip Confirmed!',
      `${driverName || 'Driver'} accepted your trip. Vehicle: ${vehicleModel}`,
      {
        type: 'CITY_TRIP_ACCEPTED',
        cityTripId,
        driverName,
        vehicleModel,
        departureTime,
        screen: 'CityTripDetails'
      },
      {
        priority: 'high',
        sound: 'default',
        channelId: 'city_trip'
      }
    );
  }

  /**
   * Notify passenger city trip was rejected
   */
  async notifyCityTripRejected(passengerToken, data) {
    const { cityTripId, reason } = data;
    return this.sendToUser(
      passengerToken,
      '❌ Trip Request Declined',
      reason || 'Driver is not available for this trip.',
      {
        type: 'CITY_TRIP_REJECTED',
        cityTripId,
        reason,
        screen: 'HomeScreen'
      },
      {
        priority: 'default',
        sound: 'default',
        channelId: 'city_trip'
      }
    );
  }

  /**
   * Notify passenger about counter offer
   */
  async notifyCityTripCounterOffer(passengerToken, data) {
    const { driverName, originalFare, offeredFare, cityTripId } = data;
    return this.sendToUser(
      passengerToken,
      '💰 Counter Offer',
      `${driverName || 'Driver'} offers Rs.${offeredFare} (original: Rs.${originalFare})`,
      {
        type: 'CITY_TRIP_COUNTER_OFFER',
        cityTripId,
        driverName,
        originalFare,
        offeredFare,
        screen: 'CityTripDetails'
      },
      {
        priority: 'high',
        sound: 'default',
        channelId: 'city_trip'
      }
    );
  }

  /**
   * Notify driver passenger accepted counter offer
   */
  async notifyCityTripPriceAgreed(driverToken, data) {
    const { passengerName, agreedFare, cityTripId } = data;
    return this.sendToUser(
      driverToken,
      '✅ Price Agreed!',
      `${passengerName || 'Passenger'} accepted Rs.${agreedFare}. Trip confirmed!`,
      {
        type: 'CITY_TRIP_PRICE_AGREED',
        cityTripId,
        passengerName,
        agreedFare,
        screen: 'CityTripDetails'
      },
      {
        priority: 'high',
        sound: 'default',
        channelId: 'city_trip'
      }
    );
  }

  /**
   * Notify passenger city trip started
   */
  async notifyCityTripStarted(passengerToken, data) {
    const { driverName, cityTripId, destination } = data;
    return this.sendToUser(
      passengerToken,
      '🚗 Trip Started',
      `Your city trip to ${destination} has begun!`,
      {
        type: 'CITY_TRIP_STARTED',
        cityTripId,
        driverName,
        destination,
        screen: 'CityTripTracking'
      },
      {
        priority: 'high',
        sound: 'default',
        channelId: 'city_trip'
      }
    );
  }

  /**
   * Notify passenger city trip completed
   */
  async notifyCityTripCompleted(passengerToken, data) {
    const { fare, cityTripId, driverName } = data;
    return this.sendToUser(
      passengerToken,
      '🎉 Trip Completed!',
      `Your city trip is complete. Fare: Rs.${fare}. Please rate ${driverName || 'your driver'}.`,
      {
        type: 'CITY_TRIP_COMPLETED',
        cityTripId,
        fare,
        driverName,
        screen: 'RatingScreen'
      },
      {
        priority: 'high',
        sound: 'default',
        channelId: 'city_trip'
      }
    );
  }

  // ============================================
  // SUBSCRIPTION NOTIFICATIONS
  // ============================================

  /**
   * Notify driver about new subscription request
   */
  async notifySubscriptionRequest(driverToken, data) {
    const { passengerName, route, monthlyFare, subscriptionId } = data;
    return this.sendToUser(
      driverToken,
      '📅 Subscription Request',
      `${passengerName || 'Passenger'} wants monthly rides on ${route}`,
      {
        type: 'SUBSCRIPTION_REQUEST',
        subscriptionId,
        passengerName,
        route,
        monthlyFare,
        screen: 'SubscriptionRequests'
      },
      {
        priority: 'high',
        sound: 'default',
        channelId: 'subscription'
      }
    );
  }

  /**
   * Notify passenger about subscription status
   */
  async notifySubscriptionStatus(passengerToken, data) {
    const { status, driverName, subscriptionId, reason } = data;
    const isAccepted = status === 'ACCEPTED';
    return this.sendToUser(
      passengerToken,
      isAccepted ? '✅ Subscription Confirmed!' : '❌ Subscription Declined',
      isAccepted
        ? `${driverName || 'Driver'} will be your regular driver!`
        : reason || 'Driver is not available for monthly subscription.',
      {
        type: 'SUBSCRIPTION_STATUS',
        subscriptionId,
        status,
        driverName,
        reason,
        screen: isAccepted ? 'SubscriptionDetails' : 'HomeScreen'
      },
      {
        priority: 'high',
        sound: 'default',
        channelId: 'subscription'
      }
    );
  }

  /**
   * Notify about subscription trip reminder
   */
  async notifySubscriptionTripReminder(userToken, data) {
    const { driverName, passengerName, pickupTime, route, subscriptionId, isDriver } = data;
    return this.sendToUser(
      userToken,
      '⏰ Upcoming Subscription Ride',
      isDriver
        ? `Pickup ${passengerName} at ${pickupTime} on ${route}`
        : `${driverName} will pick you up at ${pickupTime}`,
      {
        type: 'SUBSCRIPTION_TRIP_REMINDER',
        subscriptionId,
        pickupTime,
        route,
        screen: 'SubscriptionDetails'
      },
      {
        priority: 'high',
        sound: 'default',
        channelId: 'subscription'
      }
    );
  }

  /**
   * Notify about subscription trip update
   */
  async notifySubscriptionTripUpdate(userToken, data) {
    const { subscriptionId, message, updateType } = data;
    return this.sendToUser(
      userToken,
      '📅 Subscription Update',
      message,
      {
        type: 'SUBSCRIPTION_TRIP_UPDATE',
        subscriptionId,
        updateType,
        screen: 'SubscriptionDetails'
      },
      {
        priority: 'default',
        sound: 'default',
        channelId: 'subscription'
      }
    );
  }

  // ============================================
  // SPECIAL RIDE NOTIFICATIONS
  // ============================================

  /**
   * Notify passenger about special ride available nearby
   */
  async notifySpecialRideAvailable(passengerToken, data) {
    const { eventName, eventType, startDate, location, specialRideId } = data;
    return this.sendToUser(
      passengerToken,
      '🎉 Special Event Nearby!',
      `${eventName} - Book your ride now!`,
      {
        type: 'SPECIAL_RIDE_AVAILABLE',
        specialRideId,
        eventName,
        eventType,
        startDate,
        location,
        screen: 'SpecialRides'
      },
      {
        priority: 'high',
        sound: 'default',
        channelId: 'special_ride'
      }
    );
  }

  /**
   * Notify passenger special ride booking confirmed
   */
  async notifySpecialRideConfirmed(passengerToken, data) {
    const { eventName, driverName, pickupTime, specialRideId } = data;
    return this.sendToUser(
      passengerToken,
      '✅ Special Ride Confirmed!',
      `Your ride to ${eventName} with ${driverName || 'driver'} at ${pickupTime}`,
      {
        type: 'SPECIAL_RIDE_CONFIRMED',
        specialRideId,
        eventName,
        driverName,
        pickupTime,
        screen: 'SpecialRideDetails'
      },
      {
        priority: 'high',
        sound: 'default',
        channelId: 'special_ride'
      }
    );
  }

  /**
   * Notify passenger about special ride reminder
   */
  async notifySpecialRideReminder(passengerToken, data) {
    const { eventName, pickupTime, driverName, specialRideId, reminderType } = data;
    const reminderMessages = {
      '1_day': `Don't forget your ride to ${eventName} tomorrow!`,
      '2_hours': `Your ride to ${eventName} is in 2 hours. Get ready!`,
      '30_mins': `${driverName || 'Your driver'} will pick you up in 30 minutes for ${eventName}`
    };
    return this.sendToUser(
      passengerToken,
      '⏰ Special Event Reminder',
      reminderMessages[reminderType] || `Your ride to ${eventName} at ${pickupTime}`,
      {
        type: 'SPECIAL_RIDE_REMINDER',
        specialRideId,
        eventName,
        pickupTime,
        reminderType,
        screen: 'SpecialRideDetails'
      },
      {
        priority: 'high',
        sound: 'default',
        channelId: 'special_ride'
      }
    );
  }

  /**
   * Notify passenger special ride cancelled
   */
  async notifySpecialRideCancelled(passengerToken, data) {
    const { eventName, specialRideId, reason } = data;
    return this.sendToUser(
      passengerToken,
      '❌ Special Ride Cancelled',
      reason || `Your ride to ${eventName} has been cancelled.`,
      {
        type: 'SPECIAL_RIDE_CANCELLED',
        specialRideId,
        eventName,
        reason,
        screen: 'HomeScreen'
      },
      {
        priority: 'high',
        sound: 'default',
        channelId: 'special_ride'
      }
    );
  }

  // ============================================
  // PROMOTIONAL NOTIFICATIONS
  // ============================================

  /**
   * Notify user about a promotional offer
   */
  async notifyPromotion(userToken, data) {
    const { promoCode, discountType, discountValue, validUntil, promotionId, title, description } = data;
    const discountText = discountType === 'PERCENTAGE'
      ? `${discountValue}% off`
      : `Rs.${discountValue} off`;
    return this.sendToUser(
      userToken,
      title || `🎁 ${discountText} Your Next Ride!`,
      description || `Use code ${promoCode}. Valid until ${validUntil}`,
      {
        type: 'PROMOTION',
        promotionId,
        promoCode,
        discountType,
        discountValue,
        validUntil,
        screen: 'Promotions'
      },
      {
        priority: 'default',
        sound: 'default',
        channelId: 'promotion'
      }
    );
  }

  /**
   * Notify user about expiring promo code
   */
  async notifyPromoExpiring(userToken, data) {
    const { promoCode, expiresIn, discountValue, promotionId } = data;
    return this.sendToUser(
      userToken,
      '⚠️ Promo Code Expiring Soon!',
      `Your ${promoCode} code expires in ${expiresIn}. Use it before it's gone!`,
      {
        type: 'PROMO_EXPIRING',
        promotionId,
        promoCode,
        discountValue,
        expiresIn,
        screen: 'Promotions'
      },
      {
        priority: 'high',
        sound: 'default',
        channelId: 'promotion'
      }
    );
  }

  /**
   * Notify user about referral bonus
   */
  async notifyReferralBonus(userToken, data) {
    const { bonusAmount, referredUserName, totalReferrals } = data;
    return this.sendToUser(
      userToken,
      '🎉 Referral Bonus Earned!',
      `You earned Rs.${bonusAmount} for referring ${referredUserName || 'a friend'}!`,
      {
        type: 'REFERRAL_BONUS',
        bonusAmount,
        referredUserName,
        totalReferrals,
        screen: 'Wallet'
      },
      {
        priority: 'high',
        sound: 'default',
        channelId: 'promotion'
      }
    );
  }

  /**
   * Notify user about loyalty reward
   */
  async notifyLoyaltyReward(userToken, data) {
    const { rewardType, rewardValue, tripsCompleted, nextMilestone } = data;
    return this.sendToUser(
      userToken,
      '🏆 Loyalty Reward Unlocked!',
      `You've completed ${tripsCompleted} trips! Enjoy your ${rewardType === 'DISCOUNT' ? `Rs.${rewardValue} discount` : 'reward'}!`,
      {
        type: 'LOYALTY_REWARD',
        rewardType,
        rewardValue,
        tripsCompleted,
        nextMilestone,
        screen: 'Rewards'
      },
      {
        priority: 'high',
        sound: 'default',
        channelId: 'promotion'
      }
    );
  }

  /**
   * Notify about welcome offer for new users
   */
  async notifyWelcomeOffer(userToken, data) {
    const { promoCode, discountValue, validDays } = data;
    return this.sendToUser(
      userToken,
      '👋 Welcome to Za6Zo!',
      `Use code ${promoCode} for Rs.${discountValue} off your first ${validDays || 3} rides!`,
      {
        type: 'WELCOME_OFFER',
        promoCode,
        discountValue,
        validDays,
        screen: 'HomeScreen'
      },
      {
        priority: 'high',
        sound: 'default',
        channelId: 'promotion'
      }
    );
  }

  // ============================================
  // DRIVER VERIFICATION NOTIFICATIONS
  // ============================================

  /**
   * Notify driver about verification status
   */
  async notifyDriverVerified(driverToken, data) {
    const { status, driverId } = data;
    const isVerified = status === 'VERIFIED';
    return this.sendToUser(
      driverToken,
      isVerified ? '✅ Account Verified!' : '⚠️ Verification Update',
      isVerified
        ? 'Your account is now verified. You can start accepting rides!'
        : 'Your verification status has been updated. Please check the app.',
      {
        type: 'DRIVER_VERIFIED',
        driverId,
        status,
        screen: 'HomeScreen'
      },
      {
        priority: 'high',
        sound: 'default',
        channelId: 'default'
      }
    );
  }

  // ============================================
  // SCHEDULED NOTIFICATION HELPERS
  // ============================================

  /**
   * Schedule subscription trip reminders via the admin API
   * @param {object} data - Trip data
   */
  async scheduleSubscriptionTripReminders(data) {
    const adminApiUrl = process.env.ADMIN_API_URL || 'http://localhost:3001';

    try {
      const response = await fetch(`${adminApiUrl}/api/notifications/scheduled/subscription-trips`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data)
      });

      if (!response.ok) {
        const error = await response.json();
        console.error('Failed to schedule subscription reminders:', error);
        return { success: false, error: error.error };
      }

      const result = await response.json();
      console.log('Scheduled subscription reminders:', result);
      return result;
    } catch (error) {
      console.error('Error scheduling subscription reminders:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Cancel scheduled subscription trip reminders
   * @param {number} subscriptionTripId - Trip ID
   */
  async cancelSubscriptionTripReminders(subscriptionTripId) {
    const adminApiUrl = process.env.ADMIN_API_URL || 'http://localhost:3001';

    try {
      const response = await fetch(
        `${adminApiUrl}/api/notifications/scheduled/subscription-trips?subscriptionTripId=${subscriptionTripId}`,
        { method: 'DELETE' }
      );

      if (!response.ok) {
        const error = await response.json();
        console.error('Failed to cancel subscription reminders:', error);
        return { success: false, error: error.error };
      }

      return await response.json();
    } catch (error) {
      console.error('Error cancelling subscription reminders:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Schedule a generic notification for future delivery
   * @param {object} notification - Notification data
   * @param {Date|string} sendAt - When to send
   */
  async scheduleNotification(notification, sendAt) {
    const adminApiUrl = process.env.ADMIN_API_URL || 'http://localhost:3001';

    try {
      const response = await fetch(`${adminApiUrl}/api/notifications/scheduled`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...notification,
          sendAt: typeof sendAt === 'string' ? sendAt : sendAt.toISOString()
        })
      });

      if (!response.ok) {
        const error = await response.json();
        console.error('Failed to schedule notification:', error);
        return { success: false, error: error.error };
      }

      return await response.json();
    } catch (error) {
      console.error('Error scheduling notification:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get user's notification preferences via the admin API
   * @param {number} userId - User ID
   */
  async getUserNotificationPreferences(userId) {
    const adminApiUrl = process.env.ADMIN_API_URL || 'http://localhost:3001';

    try {
      const response = await fetch(
        `${adminApiUrl}/api/notifications/preferences?userId=${userId}`
      );

      if (!response.ok) {
        return null;
      }

      return await response.json();
    } catch (error) {
      console.error('Error fetching user preferences:', error);
      return null;
    }
  }

  /**
   * Check if notification should be sent based on user preferences
   * @param {number} userId - User ID
   * @param {string} notificationType - Type of notification
   */
  async shouldSendNotification(userId, notificationType) {
    const preferences = await this.getUserNotificationPreferences(userId);

    if (!preferences || preferences.isDefault) {
      return true; // No preferences set, send all
    }

    // Check quiet hours
    if (preferences.quietHoursEnabled && preferences.quietHoursStart && preferences.quietHoursEnd) {
      const timezone = preferences.timezone || 'Asia/Karachi';
      const now = new Date();
      const userTime = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(now);

      const [currentHour, currentMinute] = userTime.split(':').map(Number);
      const currentMinutes = currentHour * 60 + currentMinute;

      const [startHour, startMinute] = preferences.quietHoursStart.split(':').map(Number);
      const startMinutes = startHour * 60 + startMinute;

      const [endHour, endMinute] = preferences.quietHoursEnd.split(':').map(Number);
      const endMinutes = endHour * 60 + endMinute;

      // Handle overnight quiet hours
      const inQuietHours = startMinutes > endMinutes
        ? (currentMinutes >= startMinutes || currentMinutes <= endMinutes)
        : (currentMinutes >= startMinutes && currentMinutes <= endMinutes);

      if (inQuietHours) {
        console.log(`Notification blocked - user ${userId} is in quiet hours`);
        return false;
      }
    }

    // Check notification type preferences
    const typeKey = notificationType.toLowerCase();

    if (typeKey.includes('subscription') || typeKey.includes('reminder')) {
      return preferences.subscriptionReminders !== false && preferences.reminders !== false;
    }

    if (typeKey.includes('bid')) {
      return preferences.bidNotifications !== false;
    }

    if (typeKey.includes('driver')) {
      return preferences.driverUpdates !== false;
    }

    if (typeKey.includes('trip')) {
      return preferences.tripUpdates !== false;
    }

    if (typeKey.includes('promo')) {
      return preferences.promotions !== false;
    }

    return true;
  }
}

const pushNotificationService = new PushNotificationService();
module.exports = pushNotificationService;
