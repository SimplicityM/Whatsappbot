// server.js (updated to use external worker)
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');       // server io for frontend
const { io: socketIoClient } = require('socket.io-client'); // client to worker
const mongoose = require('mongoose');
const path = require('path');

const User = require('./models/User');
const Session = require('./models/Session');
const { authenticate, authenticateAdmin } = require('./middleware/auth');

const app = express();
const server = http.createServer(app);

// Server io - front-end connects here
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});
app.set('io', io);

// Worker socket client
const WORKER_URL = process.env.WORKER_URL || (process.env.WORKER_HOST ? `http://${process.env.WORKER_HOST}:5001` : 'http://localhost:5001');
const workerSocket = require('socket.io-client')(WORKER_URL, {
  reconnection: true,
  reconnectionAttempts: Infinity,
  timeout: 20000
});

workerSocket.on('connect', () => {
  console.log('🔌 Server: connected to worker at', WORKER_URL);
});

workerSocket.on('connect_error', (err) => {
  console.error('❌ Server: worker connect_error', err.message);
});

workerSocket.on('disconnect', (reason) => {
  console.warn('⚠ Server: disconnected from worker:', reason);
});

// Forward worker events to frontend sockets (when worker emits qrCode/sessionReady/authFailure/disconnected)
const workerEventNames = ['qrCode', 'sessionReady', 'authFailure', 'disconnected', 'newMessage'];
workerEventNames.forEach(evt => {
  workerSocket.on(evt, (payload) => {
    try {
      console.log(`🔁 Server: forwarding worker event ${evt}`, payload && payload.sessionId ? payload.sessionId : '');
      // If payload contains userId, emit to that user's room
      if (payload && payload.userId) {
        io.to(`user-${payload.userId}`).emit(evt, payload);
      } else {
        // broadcast as fallback
        io.emit(evt, payload);
      }
    } catch (e) {
      console.error('Error forwarding worker event', e);
    }
  });
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// CORS — keep as you had it or add worker origin if needed
const cors = require('cors');
app.use(cors({
  origin: [
    "https://whatsappbot-u5yq.onrender.com",
    "https://whatsappbot-tsya.onrender.com"
  ],
  credentials: true
}));

// DB connection
const connectDB = async () => {
  try {
    const mongoURI = process.env.MONGODB_URI;
    if (!mongoURI) throw new Error('MONGODB_URI not defined');
    await mongoose.connect(mongoURI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('✅ Server: Connected to MongoDB');
    // do NOT call restoreAllSessions here — worker is responsible for restoration
  } catch (err) {
    console.error('❌ Server DB error', err);
    process.exit(1);
  }
};
connectDB();

// Global variables
const activeClients = new Map();

// Subscription tiers and their features
const subscriptionPlans = {
    free: {
        name: 'Free Plan',
        maxSessions: 1,
        amount: 0, // Free
        allowedCommands: ['ping', 'help','list','tag', 'status'],
        features: ['basic_messaging'],
        description: 'Perfect for trying out the bot',
        limits: {
            dailyMessages: 50,
            monthlyMessages: 1000,
            groupsPerSession: 5
        }
    },
    starter: {
        name: 'Starter Plan',
        maxSessions: 5,
        amount: 2900, // ₦29/month (in kobo)
        allowedCommands: ['ping', 'help', 'status', 'broadcast', 'auto_reply', 'tag', 'tagexcept'],
        features: ['basic_messaging', 'broadcast', 'auto_reply', 'group_tagging'],
        description: 'Essential features for small businesses',
        limits: {
            dailyMessages: 500,
            monthlyMessages: 10000,
            groupsPerSession: 20
        }
    },
    professional: {
        name: 'Professional Plan',
        maxSessions: 25,
        amount: 7900, // ₦79/month (in kobo)
        allowedCommands: ['ping', 'help', 'status', 'broadcast', 'auto_reply', 'analytics', 'scheduler', 'tag', 'tagexcept', 'list'],
        features: ['basic_messaging', 'broadcast', 'auto_reply', 'analytics', 'scheduling', 'group_tagging', 'advanced_commands'],
        description: 'Advanced features for growing businesses',
        limits: {
            dailyMessages: 2000,
            monthlyMessages: 50000,
            groupsPerSession: 50
        }
    },
    business: {
        name: 'Business Plan',
        maxSessions: 100,
        amount: 14900, // ₦149/month (in kobo)
        allowedCommands: ['ping', 'help', 'status', 'broadcast', 'auto_reply', 'analytics', 'scheduler', 'custom_commands', 'tag', 'tagexcept', 'list', 'export'],
        features: ['basic_messaging', 'broadcast', 'auto_reply', 'analytics', 'scheduling', 'custom_commands', 'group_tagging', 'advanced_commands', 'priority_support', 'data_export'],
        description: 'Comprehensive solution for established businesses',
        limits: {
            dailyMessages: 10000,
            monthlyMessages: 250000,
            groupsPerSession: 200
        }
    },
    enterprise: {
        name: 'Enterprise Plan',
        maxSessions: -1, // Unlimited
        amount: 27900, // ₦279/month (in kobo)
        allowedCommands: 'all', // All commands available
        features: ['all_features', 'unlimited_messaging', 'dedicated_support', 'custom_integrations', 'white_label', 'api_access', 'advanced_analytics', 'multi_user_access'],
        description: 'Full-featured solution for large organizations',
        limits: {
            dailyMessages: -1, // Unlimited
            monthlyMessages: -1, // Unlimited
            groupsPerSession: -1 // Unlimited
        }
    }
};

// Helper function to check if a command is allowed for a subscription plan
function isCommandAllowed(subscription, command) {
    const plan = subscriptionPlans[subscription] || subscriptionPlans.free;
    
    // Enterprise has all commands
    if (plan.allowedCommands === 'all') {
        return true;
    }
    
    // Check if command is in the allowed list
    return plan.allowedCommands.includes(command);
}

// Helper function to check if a feature is available for a subscription plan
function hasFeature(subscription, feature) {
    const plan = subscriptionPlans[subscription] || subscriptionPlans.free;
    
    // Enterprise has all features
    if (plan.features.includes('all_features')) {
        return true;
    }
    
    return plan.features.includes(feature);
}

// Helper function to get subscription plan details
function getPlanDetails(subscription) {
    return subscriptionPlans[subscription] || subscriptionPlans.free;
}

// Helper function to check usage limits
function checkUsageLimit(subscription, limitType, currentUsage) {
    const plan = subscriptionPlans[subscription] || subscriptionPlans.free;
    const limit = plan.limits[limitType];
    
    // -1 means unlimited
    if (limit === -1) {
        return { allowed: true, remaining: -1, limit: -1 };
    }
    
    const allowed = currentUsage < limit;
    const remaining = limit - currentUsage;
    
    return { allowed, remaining, limit };
}

// Export for use in other modules
module.exports = {
    subscriptionPlans,
    isCommandAllowed,
    hasFeature,
    getPlanDetails,
    checkUsageLimit
};

// ------------------ session creation: ask worker to create ------------------
async function createWhatsAppSession(userId, sessionId) {
  try {
    console.log('🔄 SERVER: Requesting worker to create session:', sessionId);

    // Store initial session record BEFORE asking worker (helps UI show a waiting state)
    const session = new Session({
      userId,
      sessionId,
      status: 'waiting_qr',
      subscriptionAtTime: (await User.findById(userId)).subscription,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    await session.save();

    // Emit to worker and wait for response via ack callback with timeout
    const ack = await new Promise((resolve, reject) => {
      // use socket.timeout if available on client
      try {
        workerSocket.timeout(20000).emit('create_session', { userId, sessionId }, (err, result) => {
          if (err) return reject(new Error(String(err)));
          return resolve(result);
        });
      } catch (e) {
        // fallback
        let called = false;
        workerSocket.emit('create_session', { userId, sessionId }, (err, result) => {
          if (called) return;
          called = true;
          if (err) return reject(new Error(String(err)));
          resolve(result);
        });
        // safety timeout
        setTimeout(() => {
          if (!called) {
            called = true;
            reject(new Error('Worker did not respond in time'));
          }
        }, 20000);
      }
    });

    console.log('✅ SERVER: Worker acked create_session:', ack);
    return sessionId;
  } catch (error) {
    console.error('❌ SERVER: createWhatsAppSession error:', error);
    // mark session failed in DB
    try {
      await Session.findOneAndUpdate({ sessionId }, {
        status: 'failed',
        errorMessage: error.message,
        updatedAt: new Date()
      });
    } catch (dbErr) {
      console.error('❌ SERVER: failed to update session status after worker error', dbErr);
    }
    throw error;
  }
}

// Replace any route that previously called createBotSession directly
app.post('/api/sessions/create', require('./middleware/auth').authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const sessionId = `session-${userId}-${Date.now()}`;
    await createWhatsAppSession(userId, sessionId);
    res.json({ success: true, data: { sessionId }, message: 'Session creation requested' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message || 'failed' });
  }
});

// Keep the rest of your routes, substituting createWhatsAppSession where needed instead of createBotSession
// e.g. admin session creation route should call createWhatsAppSession(req.user.id, sessionId)

// Socket.io (frontend) handling remains the same — users join rooms, etc.
io.on('connection', (socket) => {
  console.log('🔌 Frontend client connected', socket.id);
  socket.on('join-user-room', (userId) => {
    if (!userId) return;
    socket.join(`user-${userId}`);
    socket.emit('room-joined', { roomName: `user-${userId}`, userId });
  });
  socket.on('join-admin-room', (adminId) => {
    if (!adminId) return;
    socket.join(`admin-${adminId}`);
    socket.emit('admin-room-joined', { roomName: `admin-${adminId}`, adminId });
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
