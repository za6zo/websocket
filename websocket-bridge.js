const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 8090; // Bridge runs on 8090, WebSocket server on 8080
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