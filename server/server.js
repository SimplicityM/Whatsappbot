// server.js (updated to use external worker)
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');       // server io for frontend
const { io: socketIoClient } = require('socket.io-client'); // client to worker
const mongoose = require('mongoose');
const path = require('path');

const User = require('../../models/User');
const Session = require('../../models/Session');
const { authenticate, authenticateAdmin } = require('../../middleware/auth');

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

app.use("/api/auth", require("./routes/auth"));


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
        workerSocket.timeout(20000).emit('worker:create_session', { userId, sessionId }, (err, result) => {
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

app.use('/api/sessions', require('./routes/sessions'));

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
// app.post('/api/webhooks/payment-success', async (req, res) => {
//     try {
//         const { userId, planType, transactionId, expiresAt } = req.body;
        
//         // Update user subscription
//         const user = await User.findByIdAndUpdate(userId, {
//             'subscription.status': 'active',
//             'subscription.planType': planType,
//             'subscription.paymentStatus': 'paid',
//             'subscription.expiresAt': new Date(expiresAt),
//             'subscription.lastPaymentDate': new Date(),
//             'subscription.nextBillingDate': new Date(expiresAt)
//         }, { new: true });

//         if (user) {
//             console.log(`✅ Payment confirmed for user ${userId}, plan: ${planType}`);
            
//             // 🔑 KEY ADDITION: Try to resume suspended sessions
//             const { resumeUserSession } = require('./bot.js');
//             const Session = require('./models/Session');
            
//             // Find suspended sessions for this user
//             const suspendedSessions = await Session.find({ 
//                 userId: userId, 
//                 status: 'suspended' 
//             });

//             let resumedCount = 0;
//             for (const session of suspendedSessions) {
//                 const resumed = await resumeUserSession(userId, session.sessionId, io);
//                 if (resumed) {
//                     resumedCount++;
//                 }
//             }

//             console.log(`✅ Resumed ${resumedCount} suspended sessions for user ${userId}`);
            
//             res.json({ 
//                 success: true, 
//                 message: 'Payment processed successfully',
//                 resumedSessions: resumedCount
//             });
//         } else {
//             res.status(404).json({ success: false, message: 'User not found' });
//         }
        
//     } catch (error) {
//         console.error('❌ Payment webhook error:', error);
//         res.status(500).json({ success: false, message: 'Internal server error' });
//     }
// });

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
        const sessions = await Session.find({ userId: req.user.id });

        const stats = {
            totalMessages: 0,
            totalGroups: 0,
            commandsUsed: 0,
            messagesToday: 0,
            groupsManaged: sessions.length
        };
        
        res.json({
            success: true,
            data: stats
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error fetching statistics'
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
    res.sendFile(path.join(__dirname, 'Public', 'robots.txt'));
});

// Serve sitemap.xml
app.get('/sitemap.xml', (req, res) => {
    res.sendFile(path.join(__dirname, 'Public', 'sitemap.xml'));
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

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
