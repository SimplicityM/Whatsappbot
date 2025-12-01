// server.js (updated to use external worker)
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');       // server io for frontend
const { io: socketIoClient } = require('socket.io-client'); // client to worker
const mongoose = require('mongoose');
const path = require('path');
const cors = require("cors");
const app = express();



// ALWAYS return CORS headers — even for 404 routes or before DB loads
app.use((req, res, next) => {
 res.header("Access-Control-Allow-Origin", req.headers.origin || "https://tagthemall.com.ng");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");

  // Handle preflight for ALL paths
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  next();
});

// Standard CORS middleware
app.use(cors({
  origin: [
    "https://tagthemall.com.ng", 
    "http://localhost:3000",
    "https://whatsappbot-u5yq.onrender.com"  // Add this
  ],
  credentials: true
}));

// ⚠️ Don't import models here - they'll be imported after DB connection
let User, Session, Usage, SavedGroupList;

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
app.set('workerSocket', workerSocket);

// workerSocket.on('connect', () => {
//   console.log('🔌 Server: connected to worker at', WORKER_URL);
// });

workerSocket.on('connect_error', (err) => {
  console.error('❌ Server: worker connect_error', err.message);
});

workerSocket.on('disconnect', (reason) => {
  console.warn('⚠ Server: disconnected from worker:', reason);
});

const { startBroadcastScheduler } = require('./utils/broadcastScheduler');


// Start after DB connection
workerSocket.on('connect', () => {
    console.log('🔌 Server: connected to worker at', WORKER_URL);
    startBroadcastScheduler(workerSocket);
});

// Forward worker events to frontend sockets
const workerEventNames = ['qrCode', 'sessionReady', 'authFailure', 'disconnected', 'newMessage'];
workerEventNames.forEach(evt => {
  workerSocket.on(evt, (payload) => {
    try {
      console.log(`🔁 Server: forwarding worker event ${evt}`, payload && payload.sessionId ? payload.sessionId : '');
      if (payload && payload.userId) {
        io.to(`user-${payload.userId}`).emit(evt, payload);
      } else {
        io.emit(evt, payload);
      }
    } catch (e) {
      console.error('Error forwarding worker event', e);
    }
  });
});


// Add headers for Google Sign-In
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
  next();
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========================================
// 🩺 HEALTH CHECK ENDPOINT (SAFE, NO DB)
// ========================================
app.get('/health', (req, res) => {
    const mongooseReady = mongoose.connection.readyState === 1;
    const workerSocket = app.get('workerSocket');
    const workerConnected = workerSocket?.connected || false;

    res.json({
        success: true,
        server: true,
        mongodb: mongooseReady ? "connected" : `not-ready(${mongoose.connection.readyState})`,
        worker: workerConnected
    });
});

const { authenticate, authenticateAdmin } = require('../middleware/auth');

// DB connection
const connectDB = async () => {
  try {
    const mongoURI = process.env.MONGODB_URI;
    if (!mongoURI) throw new Error("MONGODB_URI not defined");

    console.log("🔄 Connecting to MongoDB…");
    console.log("📍 MongoDB URI:", mongoURI.replace(/\/\/([^:]+):([^@]+)@/, "//***:***@"));

    // ===== GLOBAL MONGOOSE SETTINGS =====
    mongoose.set("strictQuery", false);
    mongoose.set("bufferCommands", true);
    mongoose.set("autoIndex", false);

    // ===== CONNECTION EVENT LOGGERS =====
    mongoose.connection.on("connected", () => console.log("🟢 MongoDB connected."));
    mongoose.connection.on("reconnected", () => console.log("🔄 MongoDB reconnected."));
    mongoose.connection.on("disconnected", () =>
      console.warn("⚠️ MongoDB disconnected — retrying automatically…")
    );
    mongoose.connection.on("error", (err) =>
      console.error("❌ MongoDB error:", err.message)
    );

    // ===== CONNECT TO MONGODB =====
    await mongoose.connect(mongoURI, {
      maxPoolSize: 20,
      minPoolSize: 5,
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      socketTimeoutMS: 60000,
      retryWrites: true,
      w: "majority",
      bufferCommands: true
    });

    console.log("🟢 Initial MongoDB connection established");

    // ===== WAIT FOR STABLE READY STATE =====
    let attempts = 0;
    const maxAttempts = 15;

    while (mongoose.connection.readyState !== 1 && attempts < maxAttempts) {
      console.log(
        `⏳ Waiting for DB ready… Attempt ${attempts + 1}/${maxAttempts} (State: ${
          mongoose.connection.readyState
        })`
      );
      await new Promise((resolve) => setTimeout(resolve, 800));
      attempts++;
    }

    if (mongoose.connection.readyState !== 1) {
      throw new Error(
        `MongoDB did not stabilize. Final readyState: ${mongoose.connection.readyState}`
      );
    }

    console.log("✅ MongoDB readyState confirmed: 1 (connected)");

    // ===== VERIFY CONNECTION WITH A PING =====
    if (mongoose.connection.db) {
      await mongoose.connection.db.admin().ping();
      console.log("✅ MongoDB ping successful");
    } else {
      console.warn("⚠️ Skipping ping — connection.db not ready");
    }

    // ===== EXTRA STABILIZATION WAIT =====
    await new Promise((resolve) => setTimeout(resolve, 2000));
    console.log("✅ MongoDB connection stabilized");

    // ===== LOAD MODELS AFTER STABLE CONNECTION =====
    const User = require("./models/User");
    const Session = require("./models/Session");
    const Usage = require("./models/Usage");
    const SavedGroupList = require("./models/SavedGroupList");

    global.User = User;
    global.Session = Session;
    global.Usage = Usage;
    global.SavedGroupList = SavedGroupList;

    console.log("✅ Models loaded");

    // ===== TEST DATABASE OPERATIONS =====
    try {
      await User.countDocuments();
      await Session.countDocuments();
      console.log("✅ Database operations verified");
    } catch (dbError) {
      console.error("❌ Database operation test failed:", dbError);
      throw dbError;
    }

    // ===== START TRIAL MONITORING =====
    const { checkExpiredTrials } = require("./utils/trialMonitor");
    checkExpiredTrials();
    console.log("✅ Trial monitoring started");

    return true;
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err);
    throw err;
  }
};

   

        app.post('/api/admin/sessions/create', authenticateAdmin, async (req, res) => {
        try {
        console.log('🔄 ADMIN: Creating session for admin:', req.user.id);
        const sessionId = `admin-session-${req.user.id}-${Date.now()}`;

        await createWhatsAppSession(req.user.id, sessionId);
        
        res.json({
            success: true,
            data: { sessionId },
            message: 'Admin session created successfully'
        });
        } catch (error) {
        console.error('❌ ADMIN: Session creation error:', error);
        res.status(400).json({
            success: false,
            message: error.message
        });
    }
});

// Global variables
const activeClients = new Map();

// Subscription tiers and their features
const subscriptionPlans = {
  free: {
    name: 'Free Plan',
    maxSessions: 1, // ✅ 1 session only
    amount: 0, // Free
    allowedCommands: ['ping', 'help','list','tag', 'status'],
    features: ['basic_messaging','limited_commands'],
    description: 'Perfect for trying out the bot',
    limits: {
      dailyMessages: 50,
      monthlyMessages: 1000,
      groupsPerSession: 5
    }
  },
  starter: {
    name: 'Starter Plan',
    maxSessions: 1, // ✅ Changed from 5 to 1
    amount: 700, // $7/month (in cents)
    allowedCommands: ['ping', 'help', 'status', 'broadcast', 'auto_reply', 'tag', 'tagexcept'],
    features: ['basic_messaging', 'broadcast', 'auto_reply', 'group_tagging'],
    description: 'Essential features for small businesses',
    limits: {
      dailyMessages: 500,
      monthlyMessages: 10000,
      groupsPerSession: 10
    }
  },
  professional: {
    name: 'Professional Plan',
    maxSessions: 1, // ✅ Changed from 25 to 1
    amount: 1500, // $15/month (in cents)
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
    maxSessions: 1, // ✅ Changed from 100 to 1
    amount: 2200, // $22/month (in cents)
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
    maxSessions: -1, // ✅ Unlimited (unchanged)
    amount: 3800, // $38/month (in cents)
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



// ------------------ session creation: ask worker to create ------------------
async function createWhatsAppSession(userId, sessionId) {
  try {
    console.log('🔄 SERVER: Requesting worker to create session:', sessionId);

    // Store initial session record BEFORE asking worker
    const session = new Session({
      userId,
      sessionId,
      status: 'waiting_qr',
      subscriptionAtTime: (await User.findById(userId)).subscription,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    await session.save();

    // Check if worker is connected
    if (!workerSocket.connected) {
      throw new Error('Worker service is not connected. Please try again later.');
    }

    // Emit to worker and wait for response
    const ack = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Worker did not respond in time'));
      }, 20000);

      workerSocket.emit('worker:create_session', { userId, sessionId }, (err, result) => {
        clearTimeout(timeout);
        if (err) return reject(new Error(String(err)));
        resolve(result);
      });
    });

    console.log('✅ SERVER: Worker acked create_session:', ack);
    return sessionId;
  } catch (error) {
    console.error('❌ SERVER: createWhatsAppSession error:', error);
    
    // Mark session as failed
    try {
      await Session.findOneAndUpdate({ sessionId }, {
        status: 'failed',
        errorMessage: error.message,
        updatedAt: new Date()
      });
    } catch (dbErr) {
      console.error('❌ SERVER: failed to update session status', dbErr);
    }
    throw error;
  }
}



// Page routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});


app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/payment', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'payment.html'));
});


// User endpoints
app.get('/api/users/profile', authenticate, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-password');
        res.json({ success: true, data: { user } });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching user profile' });
    }
});

app.get('/api/users/settings', authenticate, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('settings');
        res.json({ success: true, data: { settings: user.settings || {} } });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching user settings' });
    }
});

app.put('/api/users/settings', authenticate, async (req, res) => {
    try {
        const { settings } = req.body;
        await User.findByIdAndUpdate(req.user.id, { settings });
        res.json({ success: true, message: 'Settings saved successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error saving settings' });
    }
});

// Session endpoints
app.get('/api/sessions/my-sessions', authenticate, async (req, res) => {
    try {
        const sessions = await Session.find({ userId: req.user.id }).sort({ createdAt: -1 });
        res.json({ success: true, data: { sessions } });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching sessions' });
    }
});


app.post('/api/sessions/:sessionId/restart', authenticate, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = await Session.findOne({ sessionId, userId: req.user.id });

        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found'
            });
        }
        
        res.json({
            success: true,
            message: 'Session restart initiated'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error restarting session'
        });
    }
});

app.delete('/api/sessions/:sessionId', authenticate, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = await Session.findOne({ sessionId, userId: req.user.id });

        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found'
            });
        }
        
        if (activeClients.has(sessionId)) {
    const sessionData = activeClients.get(sessionId);
    try {
        // First disconnect gracefully
        if (sessionData.client.pupPage) {
            await sessionData.client.pupPage.close();
        }
        
        // Add delay before destroying
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Destroy with force flag
        await sessionData.client.destroy();
        
        // Additional cleanup delay
        await new Promise(resolve => setTimeout(resolve, 1000));
        
    } catch (error) {
        console.error(`Error during graceful session cleanup ${sessionId}:`, error);
        // Force cleanup even if error occurs
        try {
            await sessionData.client.destroy();
        } catch (forceError) {
            console.error(`Force cleanup also failed for ${sessionId}:`, forceError);
        }
    } finally {
        activeClients.delete(sessionId);
    }
}
        
        await Session.deleteOne({ sessionId });
        
        res.json({
            success: true,
            message: 'Session deleted successfully'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error deleting session'
        });
    }
});

// Payment endpoints
app.get('/api/payments/subscription-status', authenticate, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        
        // Calculate real days remaining
        let daysRemaining = 0;
        let paymentStatus = user.paymentStatus || 'trial';
        
        if (user.subscriptionExpiry) {
            const now = new Date();
            const expiry = new Date(user.subscriptionExpiry);
            const diffTime = expiry - now;
            daysRemaining = Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
            
            // Auto-update status if trial expired
            if (daysRemaining === 0 && user.paymentStatus === 'trial') {
                user.paymentStatus = 'expired';
                await user.save();
                paymentStatus = 'expired';
            }
        }
        
        res.json({
            success: true,
            data: {
                subscription: user.subscription,
                paymentStatus: paymentStatus,
                daysRemaining: daysRemaining,
                subscriptionExpiry: user.subscriptionExpiry,
                limits: subscriptionPlans[user.subscription],
                isExpired: paymentStatus === 'expired'
            }
        });
    } catch (error) {
        console.error('Subscription status error:', error);
        res.status(500).json({ success: false, message: 'Error fetching subscription status' });
    }
});

app.get('/api/payments/plans', async (req, res) => {
    try {
        const plans = [
            {
                id: 'starter',
                name: 'Starter Plan',
                amount: 2900,
                features: [
                    'Basic group tagging (tagall)',
                    'Contact auto-save',
                    'Basic media sharing',
                    '5 active sessions',
                    'Standard support'
                ]
            },
            {
                id: 'professional',
                name: 'Professional Plan',
                amount: 7900,
                features: [
                    'All Starter features',
                    'Advanced tagging (tagallexcept)',
                    'Event & meeting scheduling',
                    'Reminder management',
                    '25 active sessions',
                    'Priority support'
                ]
            }
        ];

        res.json({
            success: true,
            data: { plans }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error fetching plans'
        });
    }
});

app.get('/api/payments/history', authenticate, async (req, res) => {
    try {
        res.json({
            success: true,
            data: {
                transactions: [],
                stats: {
                    totalSpent: 0,
                    paymentsCount: 0,
                    lastPayment: null
                }
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching payment history' });
    }
});

// Add this route to server.js
app.post('/api/webhooks/payment-success', async (req, res) => {
    try {
        const { userId, planType, transactionId, expiresAt } = req.body;

        // Update user subscription
        const user = await User.findByIdAndUpdate(
            userId,
            {
                'subscription.status': 'active',
                'subscription.planType': planType,
                'subscription.paymentStatus': 'paid',
                'subscription.expiresAt': new Date(expiresAt),
                'subscription.lastPaymentDate': new Date(),
                'subscription.nextBillingDate': new Date(expiresAt)
            },
            { new: true }
        );

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        console.log(`✅ Payment confirmed for user ${userId}, plan: ${planType}`);

        // ================================================
        // 🔥 Instead of calling bot.js, notify WORKER
        // ================================================
        const suspendedSessions = await Session.find({
            userId: userId,
            status: 'suspended'
        });

        let resumedCount = 0;

        for (const session of suspendedSessions) {
            io.emit("worker:resume_session", {
                userId,
                sessionId: session.sessionId
            });

            resumedCount++;
        }

        console.log(`🚀 Worker notified to resume ${resumedCount} sessions`);

        return res.json({
            success: true,
            message: 'Payment processed. Worker will resume suspended sessions.',
            resumedSessions: resumedCount
        });

    } catch (error) {
        console.error('❌ Payment webhook error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});


// Admin route to exempt users from payment
app.post('/api/admin/exempt-user', authenticateAdmin, async (req, res) => {
    try {
        const { userId, reason, exempt } = req.body;
        
        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'User ID is required'
            });
        }

        const user = await User.findByIdAndUpdate(userId, {
            exemptFromPayment: exempt === true,
            exemptedBy: exempt === true ? req.user.id : null,
            exemptedAt: exempt === true ? new Date() : null,
            exemptionReason: exempt === true ? reason : null
        }, { new: true });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        console.log(`🛡️ Admin ${req.user.email} ${exempt ? 'exempted' : 'removed exemption for'} user ${userId}`);

        res.json({
            success: true,
            message: `User ${exempt ? 'exempted from' : 'exemption removed from'} payment requirements`,
            user: {
                id: user._id,
                email: user.email,
                exemptFromPayment: user.exemptFromPayment,
                exemptionReason: user.exemptionReason
            }
        });

    } catch (error) {
        console.error('❌ Admin exemption error:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating user exemption'
        });
    }
});

// Admin route to set user as admin by email
app.post('/api/admin/set-admin', authenticateAdmin, async (req, res) => {
    try {
        const { email, adminLevel, reason } = req.body;
        
        if (!email || !adminLevel) {
            return res.status(400).json({
                success: false,
                message: 'Email and admin level are required'
            });
        }

        // Validate admin level
        const validLevels = ['secondary', 'primary', 'owner'];
        if (!validLevels.includes(adminLevel)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid admin level. Must be: secondary, primary, or owner'
            });
        }

        // Find user by email (case-insensitive)
        let user = await User.findOne({ email: email.toLowerCase() });

        // If user doesn't exist, create a placeholder account
        if (!user) {
            user = new User({
                email: email.toLowerCase(),
                fullName: email.split('@')[0], // Use email prefix as temporary name
                password: require('crypto').randomBytes(32).toString('hex'), // Random password
                status: 'pending', // They need to complete registration
                subscription: 'starter',
                adminLevel: adminLevel,
                isAdmin: true,
                exemptFromPayment: true,
                exemptionReason: reason || `${adminLevel} admin privileges`,
                exemptedBy: req.user.id,
                exemptedAt: new Date()
            });
            await user.save();

            console.log(`👨‍💼 Created placeholder admin account for ${email} with level: ${adminLevel}`);

            return res.json({
                success: true,
                message: `Admin account created for ${email}. They will have admin access when they register and connect WhatsApp.`,
                user: {
                    id: user._id,
                    email: user.email,
                    adminLevel: user.adminLevel,
                    exemptFromPayment: user.exemptFromPayment
                }
            });
        }

        // User exists - update their admin level
        await user.setAdminLevel(adminLevel);

        console.log(`👨‍💼 Admin ${req.user.email} granted ${adminLevel} access to ${user.email}`);

        res.json({
            success: true,
            message: `${user.email} has been granted ${adminLevel} admin access${user.whatsappNumber ? ' and can use the bot immediately' : ' and will have access when they connect WhatsApp'}`,
            user: {
                id: user._id,
                email: user.email,
                adminLevel: user.adminLevel,
                exemptFromPayment: user.exemptFromPayment,
                whatsappNumber: user.whatsappNumber
            }
        });

    } catch (error) {
        console.error('❌ Set admin error:', error);
        res.status(500).json({
            success: false,
            message: 'Error setting admin privileges'
        });
    }
});

// Admin route to get all admin users
app.get('/api/admin/admin-users', authenticateAdmin, async (req, res) => {
    try {
        const admins = await User.find({
            $or: [
                { isAdmin: true },
                { adminLevel: { $ne: 'none' } }
            ]
        }).select('fullName email whatsappNumber adminLevel exemptFromPayment isAdmin createdAt').lean();

        res.json({
            success: true,
            admins
        });
    } catch (error) {
        console.error('❌ Get admin users error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching admin users'
        });
    }
});

// Admin route to remove admin access
app.post('/api/admin/remove-admin', authenticateAdmin, async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'User ID is required'
            });
        }

        const user = await User.findById(userId);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Prevent removing the system owner
        if (user.role === 'system_admin') {
            return res.status(403).json({
                success: false,
                message: 'Cannot remove system admin privileges'
            });
        }

        // Remove admin privileges
        user.adminLevel = 'none';
        user.isAdmin = false;
        user.exemptFromPayment = false;
        user.exemptionReason = null;
        user.exemptedBy = null;
        user.exemptedAt = null;

        await user.save();

        console.log(`👨‍💼 Admin ${req.user.email} removed admin access from ${user.email}`);

        res.json({
            success: true,
            message: `Admin access removed from ${user.email}`
        });

    } catch (error) {
        console.error('❌ Remove admin error:', error);
        res.status(500).json({
            success: false,
            message: 'Error removing admin privileges'
        });
    }
});

// Admin route to get all users with exemption status
app.get('/api/admin/users-exemption-status', authenticateAdmin, async (req, res) => {
    try {
        const users = await User.find({}, {
            email: 1,
            whatsappNumber: 1,
            exemptFromPayment: 1,
            exemptionReason: 1,
            exemptedAt: 1,
            subscription: 1,
            createdAt: 1
        }).populate('exemptedBy', 'email');

        res.json({
            success: true,
            data: { users }
        });

    } catch (error) {
        console.error('❌ Error fetching users exemption status:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching users'
        });
    }
});

// Admin route to get owner information
app.get('/api/admin/owner-info', authenticateAdmin, async (req, res) => {
    try {
        const ownerNumber = CONFIG.owner ? CONFIG.owner.replace(/[^0-9]/g, '') : null;
        
        res.json({
            success: true,
            data: {
                ownerNumber: ownerNumber,
                configOwner: CONFIG.owner,
                isOwnerConfigured: !!ownerNumber
            }
        });

    } catch (error) {
        console.error('❌ Error fetching owner info:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching owner information'
        });
    }
});

// Statistics endpoint
app.get('/api/statistics/user', authenticate, async (req, res) => {
    try {

        // ================================
        // 1️⃣  DATABASE READY GUARD
        // ================================
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({
                success: false,
                message: "Database temporarily unavailable"
            });
        }

        // ================================
        // 2️⃣  MODEL LOAD GUARDS
        // (Prevents "Usage is not defined" / "SavedGroupList is undefined")
        // ================================
        if (!global.Usage && typeof Usage === "undefined") {
            return res.status(500).json({
                success: false,
                message: "Usage model not loaded"
            });
        }

        if (!global.SavedGroupList && typeof SavedGroupList === "undefined") {
            return res.status(500).json({
                success: false,
                message: "SavedGroupList model not loaded"
            });
        }

        // ================================
        // 3️⃣  GET USER SESSIONS
        // ================================
        const sessions = await Session.find({ userId: req.user.id });

        if (!sessions || sessions.length === 0) {
            return res.json({
                success: true,
                data: {
                    totalMessages: 0,
                    totalGroups: 0,
                    commandsUsed: 0,
                    messagesToday: 0,
                    groupsManaged: 0
                }
            });
        }

        // ================================
        // 4️⃣ CALCULATE SESSION USAGE
        // ================================
        let totalMessages = 0;
        let totalCommands = 0;
        let totalGroups = 0;

        for (const session of sessions) {
            totalMessages += session.usage?.messagesProcessed || 0;
            totalCommands += session.usage?.commandsExecuted || 0;
            totalGroups += session.usage?.groupsTagged || 0;
        }

        // ================================
        // 5️⃣ GET TODAY'S USAGE
        // ================================
        const today = new Date().toISOString().split('T')[0];

        const todayUsage = await Usage.findOne({
            userId: req.user.id,
            date: today
        });

        // ================================
        // 6️⃣ GET GROUPS MANAGED (SAFE AGGREGATION)
        // ================================
        let adminGroupsCount = [];

        try {
            adminGroupsCount = await SavedGroupList.aggregate([
                {
                    $match: {
                        sessionId: { $in: sessions.map(s => s.sessionId) }
                    }
                },
                { $unwind: "$groups" },
                { $group: { _id: null, count: { $sum: 1 } } }
            ]);
        } catch (err) {
            console.error("Aggregation error:", err.message);
            adminGroupsCount = [];
        }

        // ================================
        // 7️⃣ FINAL STATS
        // ================================
        const stats = {
            totalMessages,
            totalGroups,
            commandsUsed: totalCommands,
            messagesToday: todayUsage?.messagesCount || 0,
            groupsManaged: adminGroupsCount[0]?.count || 0
        };

        return res.json({
            success: true,
            data: stats
        });

    } catch (error) {
        console.error("Statistics error:", error.stack || error);
        res.status(500).json({
            success: false,
            message: "Error fetching statistics"
        });
    }
});



// Public stats API
app.get('/api/public/stats', async (req, res) => {
    try {
        const totalUsers = await User.countDocuments();
        const totalSessions = await Session.countDocuments();

        res.json({
            totalUsers,
            messagesSent: 0,
            groupsManaged: totalSessions
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

app.get('/api/public/recent-activity', async (req, res) => {
    try {
        const activities = [
            { user: 'Sarah M.', action: 'upgraded to Premium plan', timeAgo: '2 minutes ago' },
            { user: 'TechCorp', action: 'sent 1,500 automated messages', timeAgo: '5 minutes ago' }
        ];

        res.json(activities);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get activity' });
    }
});

// Serve robots.txt
app.get('/robots.txt', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'robots.txt'));
});

// Serve sitemap.xml
app.get('/sitemap.xml', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'sitemap.xml'));
});

// Add security headers for SEO
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

// Usage API for dashboard
app.get('/api/user/usage', authenticate, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        const plan = subscriptionPlans[user.subscription || 'free'];

        res.json({
            messagesCount: 0,
            messageLimit: plan.maxSessions * 100,
            sessionsActive: 0,
            sessionLimit: plan.maxSessions,
            planType: user.subscription,
            upgradeUrl: '/payment'
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get usage' });
    }
});

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


// Start server ONLY after MongoDB is connected with retry logic
let serverStarted = false; // Add flag to prevent multiple starts

const startServer = async () => {
  if (serverStarted) {
    console.log('⚠️ Server already started, skipping...');
    return;
  }

  let retries = 5;
  let connected = false;
  
  while (retries > 0 && !connected) {
    try {
      console.log(`🔄 Connection attempt ${6 - retries}/5...`);
      await connectDB();
      connected = true;

       // Register auth routes AFTER models are loaded
    app.use("/api/auth", require("./routes/auth"));
    console.log('✅ Auth routes registered');

    app.use("/api/user", require("./routes/user"));
    console.log('✅ User routes registered');

    app.use("/api/admin", require("./routes/admin"));
    console.log('✅ Admin routes registered');

    app.use("/api/sessions", require("./routes/sessions"));
    console.log('✅ Session routes registered');

    // ============================================
// 📱 MOBILE APP: Create Session with Phone Number
// ============================================
app.post('/api/sessions/create-with-phone', authenticate, async (req, res) => {
    try {
        console.log('📱 MOBILE: Creating session with phone number for user:', req.user.id);
        
        const { phoneNumber } = req.body;
        
        // Validate phone number
        if (!phoneNumber) {
            return res.status(400).json({
                success: false,
                message: 'Phone number is required'
            });
        }

        // Format and validate phone number
        const formattedPhone = phoneNumber.replace(/[^0-9]/g, '');
        
        // Check if phone number is valid (Nigerian format)
        if (formattedPhone.length < 10 || formattedPhone.length > 13) {
            return res.status(400).json({
                success: false,
                message: 'Invalid phone number format. Use format: +234XXXXXXXXXX or 0XXXXXXXXXX'
            });
        }

        // Normalize to international format
        let normalizedPhone = formattedPhone;
        if (formattedPhone.startsWith('0')) {
            normalizedPhone = '234' + formattedPhone.substring(1);
        } else if (!formattedPhone.startsWith('234')) {
            normalizedPhone = '234' + formattedPhone;
        }

        console.log('📱 MOBILE: Formatted phone number:', normalizedPhone);

        // Check subscription limits
        const user = await User.findById(req.user.id);
        const userSessions = await Session.find({ 
            userId: req.user.id, 
            status: { $in: ['connected', 'waiting_qr', 'connecting'] } 
        });
        
        const maxSessions = subscriptionPlans[user.subscription]?.maxSessions || 1;
        
        if (maxSessions !== -1 && userSessions.length >= maxSessions) {
            return res.status(403).json({
                success: false,
                message: `Session limit reached. ${user.subscription} plan allows ${maxSessions} sessions. Please upgrade your plan.`
            });
        }

        const sessionId = `session-${req.user.id}-${Date.now()}`;

        // Create session record in database
        const session = new Session({
            userId: req.user.id,
            sessionId,
            phone: normalizedPhone,
            status: 'waiting_qr',
            subscriptionAtTime: user.subscription,
            createdAt: new Date(),
            updatedAt: new Date()
        });
        await session.save();
        
        console.log('✅ MOBILE: Session record created in database');

        // Create WhatsApp session
        await createWhatsAppSession(req.user.id, sessionId);
        
        console.log('✅ MOBILE: WhatsApp session initialized');

        res.json({
            success: true,
            data: { 
                sessionId, 
                phoneNumber: normalizedPhone,
                status: 'waiting_qr',
                message: 'Session created successfully'
            },
            message: 'WhatsApp session created. Please scan the QR code that will appear, or wait for a pairing code on your WhatsApp.'
        });

    } catch (error) {
        console.error('❌ MOBILE: Phone session creation error:', error);
        res.status(400).json({
            success: false,
            message: error.message || 'Failed to create session'
        });
    }
});

// ============================================
// 📱 MOBILE APP: Check Session Status
// ============================================
app.get('/api/sessions/status/:sessionId', authenticate, async (req, res) => {
    try {
        const { sessionId } = req.params;
        
        const session = await Session.findOne({ 
            sessionId, 
            userId: req.user.id 
        });

        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found'
            });
        }

        res.json({
            success: true,
            data: {
                sessionId: session.sessionId,
                status: session.status,
                phone: session.phone,
                connectedAt: session.connectedAt,
                updatedAt: session.updatedAt
            }
        });

    } catch (error) {
        console.error('❌ MOBILE: Session status check error:', error);
        res.status(500).json({
            success: false,
            message: 'Error checking session status'
        });
    }
    });
      
      const PORT = process.env.PORT || 3000;
      server.listen(PORT, () => {
        serverStarted = true; // Mark as started
        console.log(`🚀 Server running on port ${PORT}`);
        console.log('✅ All systems ready!');
      });
      
    } catch (error) {
      retries--;
      console.error(`❌ Failed to start server (${retries} retries left):`, error.message);
      
      if (retries === 0) {
        console.error('❌ All connection attempts failed. Exiting...');
        console.error('💡 Please check:');
        console.error('   1. MONGODB_URI environment variable is set correctly');
        console.error('   2. MongoDB Atlas Network Access allows your IP (0.0.0.0/0)');
        console.error('   3. Database user credentials are correct');
        console.error('   4. Your internet connection is stable');
        process.exit(1);
      }
      
      console.log(`⏳ Retrying in 5 seconds...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
};

// Export for use in other modules
module.exports = {
    subscriptionPlans,
    isCommandAllowed,
    hasFeature,
    getPlanDetails,
    checkUsageLimit,
     createWhatsAppSession 
    };
startServer();
