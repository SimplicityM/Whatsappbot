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

// Import bot functionality
const { createBotSession } = require('./bot');

// Initialize Express app
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
app.use(express.static(path.join(__dirname, 'public')));

// Database connection
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

connectDB();

// Global variables
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
    },
    starter: {
        maxSessions: 5
    },
    professional: {
        maxSessions: 25
    },
    business: {
        maxSessions: 100
    },
    enterprise: {
        maxSessions: -1
    }
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
            status: { $in: ['connected', 'waiting_qr'] } 
        });
        
        const maxSessions = subscriptionPlans[user.subscription]?.maxSessions || 1;
        
        if (maxSessions !== -1 && userSessions.length >= maxSessions) {
            throw new Error(`Session limit reached. ${user.subscription} plan allows ${maxSessions} sessions.`);
        }

        console.log('🔄 SERVER: Calling createBotSession...');
        const client = await createBotSession(userId, sessionId, io);
        console.log('✅ SERVER: Bot session created successfully');
        console.log('🔍 SERVER: Client type:', typeof client);

        activeClients.set(sessionId, {
            client,
            userId,
            subscription: user.subscription
        });

        const session = new Session({
            userId,
            sessionId,
            status: 'connecting',
            subscriptionAtTime: user.subscription
        });
        await session.save();
        console.log('✅ SERVER: Session record saved to database');

        
        // Enhanced ready event handler
        client.on('ready', async () => {
            console.log('✅ SERVER: Client ready event received');
            
            try {
                await Session.findOneAndUpdate(
                    { sessionId },
                    { 
                        status: 'connected',
                        phone: client.info.wid.user,
                        connectedAt: new Date(),
                        updatedAt: new Date()
                    }
                );
                console.log('✅ SERVER: Session status updated to connected');
                console.log('📱 SERVER: Phone number:', client.info.wid.user);
            } catch (dbError) {
                console.error('❌ SERVER: Error updating session status:', dbError);
            }
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
    console.log('Client connected:', socket.id);

    socket.on('join-user-room', (userId) => {
        if (!userId) {
            console.log('❌ Cannot join room: user ID is null/undefined');
            return;
        }
        
        const roomName = `user-${userId}`;
        socket.join(roomName);
        console.log(`✅ User ${userId} joined room: ${roomName}`);
    });

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

app.get('/admin-dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin-dashboard.html'));
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
                daysRemaining: 30,
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

// Email marketing and other routes (optional)
try {
    const { emailMarketing, trackEmailTriggers } = require('./Public/util/emailMarketing');
    const abTestRoutes = require('./routes/ab-tests');

    app.use('/api/ab-tests', abTestRoutes);
    app.use('/api/analytics', abTestRoutes);
} catch (error) {
    console.log('Email marketing routes not available:', error.message);
}

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