const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
require('dotenv').config(); // Load environment variables

// Import models and routes
const User = require('./models/User');
const Session = require('./models/Session');
// Authentication middleware
const { authenticate, authenticateAdmin } = require('./middleware/auth');
const { createBotSession } = require('./bot');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Serve from public folder

// Database connection with environment variables
// In your server.js - make sure it uses MONGODB_URI (not MONGO_URI)
const connectDB = async () => {
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
        
    } catch (error) {
        console.error('❌ MongoDB connection error:', error.message);
        process.exit(1);
    }
};

// Initialize database connection
connectDB();

// Store active WhatsApp clients
const activeClients = new Map();

// Subscription tiers and their features
const subscriptionPlans = {
    free: {
        maxSessions: 1,
        allowedCommands: ['ping', 'help', 'status'],
        features: ['basic_messaging']
    },
    basic: {
        maxSessions: 3,
        allowedCommands: ['ping', 'help', 'status', 'broadcast', 'auto_reply'],
        features: ['basic_messaging', 'broadcast', 'auto_reply']
    },
    premium: {
        maxSessions: 10,
        allowedCommands: ['ping', 'help', 'status', 'broadcast', 'auto_reply', 'analytics', 'scheduler', 'custom_commands'],
        features: ['basic_messaging', 'broadcast', 'auto_reply', 'analytics', 'scheduling', 'custom_commands']
    }
};

// ENHANCED SERVER LOGGING - Add to your createWhatsAppSession function
async function createWhatsAppSession(userId, sessionId) {
    try {
        console.log('='.repeat(60));
        console.log('🔄 SERVER: Creating WhatsApp session');
        console.log('👤 User ID:', userId);
        console.log('📱 Session ID:', sessionId);
        
        const user = await User.findById(userId);
        if (!user) {
            console.error('❌ SERVER: User not found');
            throw new Error('User not found');
        }
        console.log('✅ SERVER: User found:', user.email);

        // Check session limit
        const userSessions = await Session.find({ 
            userId, 
            status: { $in: ['connected', 'waiting_qr'] } 
        });
        
        console.log('📊 SERVER: User sessions count:', userSessions.length);
        console.log('📊 SERVER: User subscription:', user.subscription);
        console.log('📊 SERVER: Max sessions allowed:', subscriptionPlans[user.subscription].maxSessions);
        
        if (userSessions.length >= subscriptionPlans[user.subscription].maxSessions) {
            console.error('❌ SERVER: Session limit reached');
            throw new Error(`Subscription limit reached. ${user.subscription} plan allows ${subscriptionPlans[user.subscription].maxSessions} sessions.`);
        }

        const client = await createBotSession(userId, sessionId, io);

        console.log('✅ SERVER: WhatsApp client created');

        // Store the client
        activeClients.set(sessionId, {
            client,
            userId,
            subscription: user.subscription
        });

        // Create session record
        const session = new Session({
            userId,
            sessionId,
            status: 'initializing',
            subscriptionAtTime: user.subscription
        });
        await session.save();
        console.log('✅ SERVER: Session record saved to database');

        // QR Code event with detailed logging
        client.on('qr', async (qr) => {
            console.log('📱 SERVER: QR CODE GENERATED!');
            console.log('📱 Session:', sessionId);
            console.log('📱 QR Data Length:', qr.length);
            console.log('📱 QR Preview:', qr.substring(0, 100) + '...');
            
            // Update session status
            await Session.findOneAndUpdate(
                { sessionId },
                { 
                    status: 'waiting_qr',
                    qrCode: qr
                }
            );
            console.log('✅ SERVER: Session status updated to waiting_qr');

            const roomName = `user-${userId}`;
            console.log('📤 SERVER: Emitting to room:', roomName);
            
            // Check if room has connections
            const room = io.sockets.adapter.rooms.get(roomName);
            console.log('👥 SERVER: Room connections:', room ? room.size : 0);
            
            // Emit to specific user
            io.to(roomName).emit('qrCode', {
                sessionId,
                qr,
                message: 'Scan this QR code with WhatsApp'
            });
            
            console.log('✅ SERVER: QR code emitted to room');
            console.log('='.repeat(60));
        });

        // Ready event
        client.on('ready', async () => {
            console.log('✅ SERVER: WhatsApp client ready for session:', sessionId);
            
            await Session.findOneAndUpdate(
                { sessionId },
                { 
                    status: 'connected',
                    phone: client.info.wid.user,
                    connectedAt: new Date()
                }
            );

            io.to(`user-${userId}`).emit('sessionReady', {
                sessionId,
                phone: client.info.wid.user,
                message: 'WhatsApp connected successfully!'
            });
        });

        // Initialize the client
        console.log('🔄 SERVER: Initializing WhatsApp client...');
        await client.initialize();
        console.log('✅ SERVER: WhatsApp client initialized');
        
        return sessionId;

    } catch (error) {
        console.error('❌ SERVER: Error creating WhatsApp session:', error);
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

        // Check if command is allowed
        if (command.startsWith('!') && !allowedCommands.includes(command.substring(1))) {
            await message.reply(`❌ Command "${command}" is not available in your ${user.subscription} plan.`);
            return;
        }

        // Handle allowed commands
        await executeCommand(user, sessionId, command, message);

        // Emit message to admin dashboard for monitoring
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
                // Implement broadcast logic
                await message.reply('📢 Broadcast feature - coming soon!');
            }
            break;
            
        default:
            // Handle other commands or auto-reply
            break;
    }
}

// Socket.io connection handling
// Socket.io connection handling - FIXED VERSION
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    // User joins their personal room (with authentication)
    socket.on('join-user-room', (userId) => {
        if (!userId) {
            console.log('❌ Cannot join room: user ID is null/undefined');
            return;
        }
        
        const roomName = `user-${userId}`;
        socket.join(roomName);
        console.log(`✅ User ${userId} joined room: ${roomName}`);
    });

    // Create new WhatsApp session - FIXED
    socket.on('createSession', async (data) => {
        try {
            const { userId } = data;
            
            if (!userId) {
                console.error('❌ createSession: user ID is required');
                socket.emit('sessionError', { error: 'User ID is required' });
                return;
            }
            
            console.log('🔄 Creating session for user:', userId);
            const sessionId = `session-${userId}-${Date.now()}`;
            
            await createWhatsAppSession(userId, sessionId);
            
            socket.emit('sessionCreated', {
                sessionId,
                message: 'WhatsApp session created successfully'
            });
            
        } catch (error) {
            console.error('Session creation error:', error);
            socket.emit('sessionError', { error: error.message });
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/user'));
app.use('/api/sessions', require('./routes/sessions'));

// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Serve home page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve user dashboard
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Serve admin dashboard
app.get('/admin-dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin-dashboard.html'));
});

// Serve payment page
app.get('/payment', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'payment.html'));
});

// User endpoints
app.get('/api/users/profile', authenticate, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-password');
        res.json({
            success: true,
            data: { user }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error fetching user profile'
        });
    }
});

app.get('/api/users/settings', authenticate, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('settings');
        res.json({
            success: true,
            data: { settings: user.settings || {} }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error fetching user settings'
        });
    }
});

app.put('/api/users/settings', authenticate, async (req, res) => {
    try {
        const { settings } = req.body;
        await User.findByIdAndUpdate(req.user.id, { settings });
        res.json({
            success: true,
            message: 'Settings saved successfully'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error saving settings'
        });
    }
});

// Session endpoints
app.get('/api/sessions/my-sessions', authenticate, async (req, res) => {
    try {
        const sessions = await Session.find({ userId: req.user.id }).sort({ createdAt: -1 });
        res.json({
            success: true,
            data: { sessions }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error fetching sessions'
        });
    }
});

app.post('/api/sessions/create', authenticate, async (req, res) => {
    try {
        console.log('🔄 Creating session for user:', req.user.id);
        const sessionId = `session-${req.user.id}-${Date.now()}`;
        console.log('📝 Generated sessionId:', sessionId);
        
        await createWhatsAppSession(req.user.id, sessionId);
        console.log('✅ WhatsApp session created successfully');
        
        res.json({
            success: true,
            data: { sessionId },
            message: 'Session created successfully'
        });
    } catch (error) {
        console.error('❌ Session creation error:', error);
        res.status(400).json({
            success: false,
            message: error.message
        });
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
        
        // Restart logic here
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
        
        // Destroy client if active
        if (activeClients.has(sessionId)) {
            const sessionData = activeClients.get(sessionId);
            await sessionData.client.destroy();
            activeClients.delete(sessionId);
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
        res.json({
            success: true,
            data: {
                subscription: user.subscription,
                paymentStatus: 'active',
                daysRemaining: 30, // Example
                limits: subscriptionPlans[user.subscription]
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error fetching subscription status'
        });
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
        // Return empty history for now
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
        res.status(500).json({
            success: false,
            message: 'Error fetching payment history'
        });
    }
});

// Statistics endpoint
app.get('/api/statistics/user', authenticate, async (req, res) => {
    try {
        const { timeframe } = req.query;
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

// Add to server.js
const { emailMarketing, trackEmailTriggers } = require('./Public/util/emailMarketing');
const abTestRoutes = require('./routes/ab-tests');

// Routes
app.use('/api/ab-tests', abTestRoutes);
app.use('/api/analytics', abTestRoutes); // Reuse for analytics tracking

// Public stats API for social proof
app.get('/api/public/stats', async (req, res) => {
    try {
        const stats = await getPublicStats();
        res.json(stats);
    } catch (error) {
        console.error('Error fetching public stats:', error);
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

app.get('/api/public/recent-activity', async (req, res) => {
    try {
        const activities = await getRecentActivity();
        res.json(activities);
    } catch (error) {
        console.error('Error fetching recent activity:', error);
        res.status(500).json({ error: 'Failed to get activity' });
    }
});

// Usage API for dashboard
app.get('/api/user/usage', authenticate, async (req, res) => {
    try {
        const usage = await getUserUsageWithLimits(req.user.id);
        res.json(usage);
    } catch (error) {
        console.error('Error fetching user usage:', error);
        res.status(500).json({ error: 'Failed to get usage' });
    }
});

// Helper Functions
async function getPublicStats() {
    try {
        const totalUsers = await User.countDocuments({ status: 'active' });
        const totalMessages = await Usage.aggregate([
            { $group: { _id: null, total: { $sum: '$messagesCount' } } }
        ]);
        const totalGroups = await Session.countDocuments({ status: 'active' });

        return {
            totalUsers,
            messagesSent: totalMessages[0]?.total || 0,
            groupsManaged: totalGroups
        };
    } catch (error) {
        console.error('Error in getPublicStats:', error);
        throw error;
    }
}

async function getRecentActivity() {
    try {
        // Mock recent activity - replace with real data from your analytics
        const activities = [
            {
                user: 'Sarah M.',
                action: 'upgraded to Premium plan',
                timeAgo: '2 minutes ago'
            },
            {
                user: 'TechCorp',
                action: 'sent 1,500 automated messages',
                timeAgo: '5 minutes ago'
            },
            {
                user: 'Marketing Team',
                action: 'tagged 250 members',
                timeAgo: '8 minutes ago'
            },
            {
                user: 'John D.',
                action: 'created 3 new sessions',
                timeAgo: '12 minutes ago'
            },
            {
                user: 'StartupXYZ',
                action: 'scheduled 50 reminders',
                timeAgo: '15 minutes ago'
            }
        ];

        return activities;
    } catch (error) {
        console.error('Error in getRecentActivity:', error);
        throw error;
    }
}

async function getUserUsageWithLimits(userId) {
    try {
        const user = await User.findById(userId).populate('subscription');
        const plan = subscriptionPlans[user.subscription?.planType || 'free'];
        const today = new Date().toISOString().split('T')[0];
        
        const usage = await Usage.findOne({ userId: userId, date: today }) || { 
            messagesCount: 0, 
            sessionsActive: 0 
        };

        return {
            messagesCount: usage.messagesCount,
            messageLimit: plan.maxMessagesPerDay,
            sessionsActive: usage.sessionsActive,
            sessionLimit: plan.maxSessions,
            planType: plan.name,
            upgradeUrl: `${process.env.DOMAIN}/pricing`
        };
    } catch (error) {
        console.error('Error in getUserUsageWithLimits:', error);
        throw error;
    }
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 WhatsApp Bot Server running on port ${PORT}`);
    console.log(`📱 Home Page: http://localhost:${PORT}`);
    console.log(`👤 User Dashboard: http://localhost:${PORT}/dashboard`);
    console.log(`👨‍💼 Admin Dashboard: http://localhost:${PORT}/admin-dashboard`);
    console.log(`💳 Payment Page: http://localhost:${PORT}/payment`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down...');
    
    // Destroy all WhatsApp clients
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