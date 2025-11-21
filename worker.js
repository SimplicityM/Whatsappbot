// worker.js
require('dotenv').config();
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');
const logger = console; // swap for a logger if you have one

// Ensure environment
const PORT = process.env.WORKER_PORT || 5001;
const WORKER_ALLOW_ORIGINS = process.env.WORKER_ALLOW_ORIGINS || '*';

// connect DB (same URI as server so bot models work)
async function connectDB() {
  const mongoURI = process.env.MONGODB_URI;
  if (!mongoURI) {
    logger.error('MONGODB_URI not defined in worker env');
    process.exit(1);
  }
  await mongoose.connect(mongoURI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });
  logger.log('✅ Worker: Connected to MongoDB');
}
connectDB().catch(err => {
  logger.error('Worker DB connection error', err);
  process.exit(1);
});

// load bot implementation (uses LocalAuth / createBotSession / restoreAllSessions)
const bot = require('./bot.js'); // uses your existing bot.js (unchanged). :contentReference[oaicite:2]{index=2}

const server = http.createServer();
const io = socketIo(server, {
  cors: {
    origin: WORKER_ALLOW_ORIGINS,
    methods: ["GET", "POST"]
  }
});

// expose io globally so bot.js that relies on global.io can use it
global.io = io;

io.on('connection', (socket) => {
  logger.log('🔌 Worker: client connected to worker socket:', socket.id);

  // Handle requests from server process (server.js will connect as a client)
  socket.on('create_session', async (payload, callback) => {
    const { userId, sessionId } = payload || {};
    logger.log(`🔔 Worker: create_session request for user:${userId} session:${sessionId}`);

    if (!userId || !sessionId) {
      const err = 'userId and sessionId are required';
      logger.error('❌ Worker create_session error:', err);
      if (typeof callback === 'function') callback(err);
      return;
    }

    try {
      // createBotSession returns the created client (or session id wrapper) or throws
      await bot.createBotSession(userId, sessionId, io);
      logger.log(`✅ Worker: createBotSession accepted for ${sessionId}`);
      if (typeof callback === 'function') callback(null, { success: true, sessionId });
    } catch (e) {
      logger.error('❌ Worker: createBotSession error', e);
      if (typeof callback === 'function') callback(e.message || 'create failed');
    }
  });

  socket.on('restore_all_sessions', async (payload, callback) => {
    logger.log('🔁 Worker: restore_all_sessions request received');
    try {
      await bot.restoreAllSessions(io);
      if (typeof callback === 'function') callback(null, { success: true });
    } catch (e) {
      logger.error('❌ Worker: restoreAllSessions error', e);
      if (typeof callback === 'function') callback(e.message || 'restore failed');
    }
  });

  socket.on('disconnect', () => {
    logger.log('❌ Worker: client disconnected', socket.id);
  });
});

// Start worker socket server
server.listen(PORT, () => {
  logger.log(`🚀 Worker socket.io running on port ${PORT}`);
  // Optionally restore sessions on worker startup
  (async () => {
    try {
      logger.log('♻ Worker: starting restoreAllSessions...');
      await bot.restoreAllSessions(io);
      logger.log('🎉 Worker: restoreAllSessions finished');
    } catch (e) {
      logger.error('Worker restoreAllSessions failed', e);
    }
  })();
});

// Graceful shutdown
async function shutdown() {
  logger.log('Worker shutting down...');
  try {
    if (bot && bot.gracefulShutdown) {
      await bot.gracefulShutdown();
    } else if (bot && bot.clients) {
      for (const [sid, client] of bot.clients.entries()) {
        try { await client.destroy(); } catch (e) { logger.error('destroy client error', e); }
      }
    }
    await mongoose.connection.close();
  } catch (e) {
    logger.error('Worker shutdown error', e);
  }
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
