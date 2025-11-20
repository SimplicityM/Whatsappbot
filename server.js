const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
require('dotenv').config();


// Import models and routes
const User = require('./models/User');
const Session = require('./models/Session');
const { authenticate, authenticateAdmin } = require('./middleware/auth');
const paymentsRoute = require('./routes/payment.js');



// Add this after your imports in server.js
console.log('🛑 Disabling periodic checks for testing');
// Add this near the top of server.js to disable email marketing
process.env.DISABLE_EMAIL_MARKETING = 'true';

// Import bot functionality
const { 
    createBotSession, 
    restoreAllSessions,
    restoreUserSessionAfterPayment,
    clients 
} = require('./bot.js');


// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.set('io', io); 

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const cors = require('cors');
app.use(cors({
    origin: ["http://localhost:3000", "http://127.0.0.1:3000"],
    credentials: true
}));

// Middleware to check trial expiration
const checkTrialExpiration = async (req, res, next) => {
    try {
        if (req.user && req.user.paymentStatus === 'trial') {
            const now = new Date();
            const expiry = new Date(req.user.subscriptionExpiry);
            
            // If trial expired, update status
            if (expiry < now) {
                req.user.paymentStatus = 'expired';
                await req.user.save();
                
                return res.status(403).json({
                    success: false,
                    message: 'Your free trial has expired. Please subscribe to continue.',
                    code: 'TRIAL_EXPIRED',
                    redirectTo: '/pricing.html'
                });
            }
        }
        next();
    } catch (error) {
        console.error('Trial check error:', error);
        next();
    }
};

// Apply to protected routes
app.use('/api/bot/*', authenticate, checkTrialExpiration);
app.use('/api/sessions/*', authenticate, checkTrialExpiration);


// Content Security Policy
app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', 
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.socket.io https://cdnjs.cloudflare.com; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; " +
        "style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; " +
        "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; " +
        "connect-src 'self' ws: wss: https: http://localhost:* ws://localhost:*; " +
        "img-src 'self' data: https: blob:; " +
        "object-src 'none'; " +
        "base-uri 'self';"
    );
    next();
});

// Database connection
// Database connection
const connectDB = async (io) => {
    try {
        const mongoURI = process.env.MONGODB_URI;

        if (!mongoURI) {
            throw new Error('MONGODB_URI environment variable is not defined');
        }
        
        await mongoose.connect(mongoURI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        
        console.log('✅ Connected to MongoDB');
        console.log(`📊 Database: ${mongoose.connection.name}`);

        // 🔥 Restore WhatsApp sessions ONLY after DB connection is ready
        console.log("♻ Restoring previous WhatsApp sessions...");
        restoreAllSessions(io);

    } catch (error) {
        console.error('❌ MongoDB connection error:', error.message);
        process.exit(1);
    }
};

connectDB(io);

// Global variables
const activeClients = new Map();

// Subscription tiers and their features
const subscriptionPlans = {
    free: {
        name: 'Free Plan',
        maxSessions: 1,
        amount: 0, // Free
        allowedCommands: ['ping', 'help', 'status'],
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


// WhatsApp session creation using bot.js
async function createWhatsAppSession(userId, sessionId) {
    try {
        console.log('='.repeat(60));
        console.log('🔄 SERVER: Creating WhatsApp session using bot.js');
        console.log('👤 User ID:', userId);
        console.log('📱 Session ID:', sessionId);
        console.log('🔍 SERVER: io object exists?', !!io);

        const user = await User.findById(userId);
        if (!user) {
            throw new Error('User not found');
        }
        console.log('✅ SERVER: User found:', user.email);

        const userSessions = await Session.find({ 
            userId, 
            status: { $in: ['connected', 'waiting_qr', 'connecting'] } 
        });
        
        const maxSessions = subscriptionPlans[user.subscription]?.maxSessions || 1;
        
        if (maxSessions !== -1 && userSessions.length >= maxSessions) {
            throw new Error(`Session limit reached. ${user.subscription} plan allows ${maxSessions} sessions.`);
        }

        console.log('🔄 SERVER: Calling createBotSession...');
        console.log('🔍 SERVER: Available sessions:', userSessions.length, '/', maxSessions);
        
        // Add error handling around createBotSession
        let client;
        try {
            client = await createBotSession(userId, sessionId, io);
            console.log('✅ SERVER: Bot session created successfully');
            console.log('🔍 SERVER: Client type:', typeof client);
        } catch (botError) {
            console.error('❌ SERVER: createBotSession failed:', botError);
            console.error('❌ SERVER: Bot error stack:', botError.stack);
            throw new Error(`Bot session creation failed: ${botError.message}`);
        }

        activeClients.set(sessionId, {
            client,
            userId,
            subscription: user.subscription
        });

        const session = new Session({
            userId,
            sessionId,
            status: 'waiting_qr',
            subscriptionAtTime: user.subscription
        });
        await session.save();
        console.log('✅ SERVER: Session record saved to database');

        // Enhanced event handlers with better error handling
        client.on('ready', async () => {
    console.log('✅ SERVER: Client ready event received for session:', sessionId);
    
    try {
        // 🔑 IMPORTANT: Save user's WhatsApp number to database
        const userWhatsAppNumber = client.info.wid.user;
        console.log(`📱 Saving WhatsApp number for user ${userId}: ${userWhatsAppNumber}`);
        
        await User.findByIdAndUpdate(userId, {
            whatsappNumber: userWhatsAppNumber,
            phone: userWhatsAppNumber
        });
        
        console.log(`✅ WhatsApp number saved for user ${userId}`);
        
        await Session.findOneAndUpdate(
            { sessionId },
            { 
                status: 'connected',
                phone: userWhatsAppNumber,
                connectedAt: new Date(),
                updatedAt: new Date()
            }
        );
        console.log('✅ SERVER: Session status updated to connected');
        console.log('📱 SERVER: Phone number:', userWhatsAppNumber);
        
        // Emit success to frontend
        io.to(`user-${userId}`).emit('sessionReady', {
            sessionId,
            phone: userWhatsAppNumber,
            message: 'WhatsApp connected successfully!'
        });
        
    } catch (dbError) {
        console.error('❌ SERVER: Error updating session status:', dbError);
    }
});

        // Add QR event handler with detailed logging
        client.on('qr', (qr) => {
            console.log('📱 SERVER: QR CODE EVENT RECEIVED!');
            console.log('📱 SERVER: Session ID:', sessionId);
            console.log('📱 SERVER: User ID:', userId);
            console.log('📱 SERVER: QR Data Length:', qr.length);
            console.log('📱 SERVER: QR Preview:', qr.substring(0, 50) + '...');
            
            const roomName = `user-${userId}`;
            console.log('📤 SERVER: Emitting QR to room:', roomName);
            
            // Check room membership
            const room = io.sockets.adapter.rooms.get(roomName);
            console.log('👥 SERVER: Clients in room:', room ? room.size : 0);
            
            if (!room || room.size === 0) {
                console.warn('⚠️ SERVER: No clients in target room!');
            }
            
            // Emit QR code
            io.to(roomName).emit('qrCode', {
                sessionId,
                qr,
                message: 'Scan this QR code with WhatsApp',
                userId: userId
            });
            
            console.log('✅ SERVER: QR code emitted to room:', roomName);
            
            // Also broadcast to all as backup
            io.emit('qrCode', {
                sessionId,
                qr,
                message: 'Scan this QR code with WhatsApp',
                userId: userId,
                broadcast: true
            });
            
            console.log('✅ SERVER: QR code also broadcasted globally');
        });

        // Add disconnected event handler
        client.on('disconnected', async (reason) => {
            console.log('❌ SERVER: Client disconnected:', reason);
            
            try {
                await Session.findOneAndUpdate(
                    { sessionId },
                    { 
                        status: 'disconnected',
                        errorMessage: reason,
                        disconnectedAt: new Date()
                    }
                );
                
                // Remove from active clients
                activeClients.delete(sessionId);
                console.log('✅ SERVER: Session cleaned up after disconnect');
                
            } catch (dbError) {
                console.error('❌ SERVER: Error updating session status:', dbError);
            }
        });

        // Add authentication failure handler
        client.on('auth_failure', async (message) => {
            console.log('❌ SERVER: Authentication failed:', message);
            
            try {
                await Session.findOneAndUpdate(
                    { sessionId },
                    { 
                        status: 'auth_failed',
                        errorMessage: message,
                        updatedAt: new Date()
                    }
                );
                
                // Remove from active clients
                activeClients.delete(sessionId);
                console.log('✅ SERVER: Session cleaned up after auth failure');
                
                // Emit failure to frontend
                io.to(`user-${userId}`).emit('authFailure', {
                    sessionId,
                    message: 'WhatsApp authentication failed'
                });
                
            } catch (dbError) {
                console.error('❌ SERVER: Error updating session status:', dbError);
            }
        });

        console.log('✅ SERVER: All event handlers attached');
        console.log('🔄 SERVER: WhatsApp session creation completed');
        console.log('='.repeat(60));
        
        return sessionId;

    } catch (error) {
        console.error('❌ SERVER: Error creating WhatsApp session:', error);
        console.error('❌ SERVER: Error stack:', error.stack);
        
        // Update session status to failed if session was created
        try {
            await Session.findOneAndUpdate(
                { sessionId },
                { 
                    status: 'failed',
                    errorMessage: error.message,
                    updatedAt: new Date()
                }
            );
        } catch (dbError) {
            console.error('❌ SERVER: Error updating failed session status:', dbError);
        }
        
        throw error;
    }
}

// Handle incoming messages with permission checking
async function handleIncomingMessage(userId, sessionId, message) {
    try {
        const user = await User.findById(userId);
        const sessionData = activeClients.get(sessionId);

        if (!user || !sessionData) return;

        const command = message.body.split(' ')[0].toLowerCase();
        const allowedCommands = subscriptionPlans[user.subscription].allowedCommands;

        if (command.startsWith('!') && !allowedCommands.includes(command.substring(1))) {
            await message.reply(`❌ Command "${command}" is not available in your ${user.subscription} plan.`);
            return;
        }

        await executeCommand(user, sessionId, command, message);

        io.emit('newMessage', {
            userId,
            sessionId,
            from: message.from,
            body: message.body,
            timestamp: new Date(),
            isGroup: message.from.endsWith('@g.us')
        });

    } catch (error) {
        console.error('Error handling message:', error);
    }
}

// Execute commands based on subscription
async function executeCommand(user, sessionId, command, message) {
    const sessionData = activeClients.get(sessionId);
    if (!sessionData) return;

    switch (command) {
        case '!ping':
            await message.reply('🏓 pong');
            break;
            
        case '!help':
            const availableCommands = subscriptionPlans[user.subscription].allowedCommands;
            await message.reply(`Available commands: ${availableCommands.join(', ')}`);
            break;
            
        case '!status':
            await message.reply(`✅ Bot is running on ${user.subscription} plan`);
            break;
            
        case '!broadcast':
            if (subscriptionPlans[user.subscription].features.includes('broadcast')) {
                await message.reply('📢 Broadcast feature - coming soon!');
            }
            break;
            
        default:
            break;
    }
}

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id);
    
    // 🔑 EXISTING: User room handling
    socket.on('join-user-room', (userId) => {
        if (!userId) {
            console.log('❌ Cannot join room: user ID is null/undefined');
            return;
        }
        
        const roomName = `user-${userId}`;
        socket.join(roomName);
        console.log(`✅ User ${userId} (socket ${socket.id}) joined room: ${roomName}`);
        
        // Send confirmation back to client
        socket.emit('room-joined', { roomName, userId });
    });

    // 🔑 NEW: Admin room handling
    socket.on('join-admin-room', (adminId) => {
        if (!adminId) {
            console.log('❌ Cannot join admin room: admin ID is null/undefined');
            return;
        }
        
        const roomName = `admin-${adminId}`;
        socket.join(roomName);
        console.log(`✅ Admin ${adminId} (socket ${socket.id}) joined room: ${roomName}`);
        
        // Send confirmation back to client
        socket.emit('admin-room-joined', { roomName, adminId });
    });

    // 🔑 UPDATED: Room verification for both users and admins
    socket.on('verify-room', (data, callback) => {
        let roomName, userId;
        
        // Handle both old format (userId) and new format ({ userId, isAdmin })
        if (typeof data === 'string') {
            userId = data;
            roomName = `user-${userId}`;
        } else {
            userId = data.userId || data.adminId;
            roomName = data.isAdmin ? `admin-${userId}` : `user-${userId}`;
        }
        
        const rooms = Array.from(socket.rooms);
        const inRoom = rooms.includes(roomName);
        
        console.log(`🔍 Room verification for ${userId} (${data.isAdmin ? 'admin' : 'user'}):`, {
            socketId: socket.id,
            rooms: rooms,
            targetRoom: roomName,
            inRoom: inRoom
        });
        
        if (callback) {
            callback({
                inRoom: inRoom,
                rooms: rooms,
                targetRoom: roomName
            });
        }
    });

    socket.on('disconnect', () => {
        console.log('❌ Client disconnected:', socket.id);
    });
});

app.use((req, res, next) => {
    req.io = io;
    next();
});


// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/user'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/sessions', require('./routes/sessions'));

app.post('/api/sessions/create', authenticate, async (req, res) => {
    try {
        console.log('🔄 API: Creating session for user:', req.user.id);
        const sessionId = `session-${req.user.id}-${Date.now()}`;

        await createWhatsAppSession(req.user.id, sessionId);
        
        res.json({
            success: true,
            data: { sessionId },
            message: 'Session created successfully'
        });
    } catch (error) {
        console.error('❌ API: Session creation error:', error);
        res.status(400).json({
            success: false,
            message: error.message
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

// Static file serving
app.use(express.static(path.join(__dirname, 'public')));

// Page routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// app.get('/admin-dashboard', (req, res) => {
//     res.sendFile(path.join(__dirname, 'public', 'admin-dashboard.html'));
// });

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
// app.get('/api/payments/subscription-status', authenticate, async (req, res) => {
//     try {
//         const user = await User.findById(req.user.id);
//         res.json({
//             success: true,
//             data: {
//                 subscription: user.subscription,
//                 paymentStatus: 'active',
//                 daysRemaining: 30,
//                 limits: subscriptionPlans[user.subscription]
//             }
//         });
//     } catch (error) {
//         res.status(500).json({ success: false, message: 'Error fetching subscription status' });
//     }
// });

app.get('/api/payments/subscription-status', authenticate, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        
        // Calculate real days remaining
        let daysRemaining = 0;
        if (user.subscriptionExpiry) {
            const now = new Date();
            const expiry = new Date(user.subscriptionExpiry);
            const diffTime = expiry - now;
            daysRemaining = Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
        }
        
        res.json({
            success: true,
            data: {
                subscription: user.subscription,
                paymentStatus: user.paymentStatus || 'trial',
                daysRemaining: daysRemaining,
                subscriptionExpiry: user.subscriptionExpiry,
                limits: subscriptionPlans[user.subscription]
            }
        });
    } catch (error) {
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
        const user = await User.findByIdAndUpdate(userId, {
            'subscription.status': 'active',
            'subscription.planType': planType,
            'subscription.paymentStatus': 'paid',
            'subscription.expiresAt': new Date(expiresAt),
            'subscription.lastPaymentDate': new Date(),
            'subscription.nextBillingDate': new Date(expiresAt)
        }, { new: true });

        if (user) {
            console.log(`✅ Payment confirmed for user ${userId}, plan: ${planType}`);
            
            // 🔑 KEY ADDITION: Try to resume suspended sessions
            const { resumeUserSession } = require('./bot.js');
            const Session = require('./models/Session');
            
            // Find suspended sessions for this user
            const suspendedSessions = await Session.find({ 
                userId: userId, 
                status: 'suspended' 
            });

            let resumedCount = 0;
            for (const session of suspendedSessions) {
                const resumed = await resumeUserSession(userId, session.sessionId, io);
                if (resumed) {
                    resumedCount++;
                }
            }

            console.log(`✅ Resumed ${resumedCount} suspended sessions for user ${userId}`);
            
            res.json({ 
                success: true, 
                message: 'Payment processed successfully',
                resumedSessions: resumedCount
            });
        } else {
            res.status(404).json({ success: false, message: 'User not found' });
        }
        
    } catch (error) {
        console.error('❌ Payment webhook error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
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

// // Email marketing and other routes (optional)
// try {
//     const { emailMarketing, trackEmailTriggers } = require('./Public/util/emailMarketing');
//     const abTestRoutes = require('./routes/ab-tests');

//     app.use('/api/ab-tests', abTestRoutes);
//     app.use('/api/analytics', abTestRoutes);
// } catch (error) {
//     console.log('Email marketing routes not available:', error.message);
// }

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

// Start server
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`🚀 WhatsApp Bot Server running on port ${PORT}`);
    console.log(`📱 Home Page: http://localhost:${PORT}`);
    console.log(`👤 User Dashboard: http://localhost:${PORT}/dashboard`);
    console.log(`👨‍💼 Admin Dashboard: http://localhost:${PORT}/admin-dashboard`);
    console.log(`💳 Payment Page: http://localhost:${PORT}/payment`);
});




// Export functions for use in routes
module.exports = { createWhatsAppSession };



// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down...');

    for (const [sessionId, sessionData] of activeClients) {
        try {
            await sessionData.client.destroy();
        } catch (error) {
            console.error(`Error destroying session ${sessionId}:`, error);
        }
    }
    
    await mongoose.connection.close();
    process.exit(0);
});