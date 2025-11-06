#!/usr/bin/env node
/**
 * Za6Zo WebSocket Services Launcher
 * Starts both WebSocket Server (8080) and Bridge (8090) in a single process
 */

require('dotenv').config();
const { spawn } = require('child_process');

console.log('🚀 Starting Za6Zo WebSocket Services...\n');
console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`📡 WebSocket Server Port: ${process.env.WS_PORT || 8080}`);
console.log(`🌉 Bridge HTTP Port: ${process.env.HTTP_PORT || 8090}`);
console.log(`🔗 API URL: ${process.env.API_URL || 'Not set'}\n`);

// Track if services are ready
let wsServerReady = false;
let wsBridgeReady = false;

// Start WebSocket Server (port 8080)
const wsServer = spawn('node', ['websocket-server.js'], {
  env: { ...process.env },
  stdio: ['inherit', 'pipe', 'pipe']
});

// Start WebSocket Bridge (port 8090)
const wsBridge = spawn('node', ['websocket-bridge.js'], {
  env: { ...process.env },
  stdio: ['inherit', 'pipe', 'pipe']
});

// Handle WebSocket Server output
wsServer.stdout.on('data', (data) => {
  const output = data.toString();
  process.stdout.write(`[WS-SERVER] ${output}`);

  if (output.includes('WebSocket server listening') || output.includes('Server running')) {
    wsServerReady = true;
    checkAllReady();
  }
});

wsServer.stderr.on('data', (data) => {
  process.stderr.write(`[WS-SERVER ERROR] ${data}`);
});

// Handle WebSocket Bridge output
wsBridge.stdout.on('data', (data) => {
  const output = data.toString();
  process.stdout.write(`[WS-BRIDGE] ${output}`);

  if (output.includes('WebSocket Bridge Server running') || output.includes('Bridge running')) {
    wsBridgeReady = true;
    checkAllReady();
  }
});

wsBridge.stderr.on('data', (data) => {
  process.stderr.write(`[WS-BRIDGE ERROR] ${data}`);
});

// Check if all services are ready
function checkAllReady() {
  if (wsServerReady && wsBridgeReady) {
    console.log('\n✅ All WebSocket services are running and ready!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📡 WebSocket Server: ws://localhost:' + (process.env.WS_PORT || 8080));
    console.log('🌉 Bridge HTTP API: http://localhost:' + (process.env.HTTP_PORT || 8090));
    console.log('🏥 Health Check: http://localhost:' + (process.env.HTTP_PORT || 8090) + '/health');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  }
}

// Handle WebSocket Server process errors
wsServer.on('error', (err) => {
  console.error('❌ WebSocket Server failed to start:', err);
  process.exit(1);
});

wsServer.on('exit', (code, signal) => {
  if (code !== 0) {
    console.error(`❌ WebSocket Server exited with code ${code}, signal ${signal}`);
    wsBridge.kill();
    process.exit(code || 1);
  }
});

// Handle WebSocket Bridge process errors
wsBridge.on('error', (err) => {
  console.error('❌ WebSocket Bridge failed to start:', err);
  process.exit(1);
});

wsBridge.on('exit', (code, signal) => {
  if (code !== 0) {
    console.error(`❌ WebSocket Bridge exited with code ${code}, signal ${signal}`);
    wsServer.kill();
    process.exit(code || 1);
  }
});

// Handle graceful shutdown
function gracefulShutdown(signal) {
  console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);

  wsServer.kill('SIGTERM');
  wsBridge.kill('SIGTERM');

  // Force kill after 5 seconds if not gracefully stopped
  setTimeout(() => {
    console.log('⚠️ Forcing shutdown...');
    wsServer.kill('SIGKILL');
    wsBridge.kill('SIGKILL');
    process.exit(0);
  }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  gracefulShutdown('EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('REJECTION');
});
