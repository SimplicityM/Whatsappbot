const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

// Import models and routes
const User = require('./models/User');
const Session = require('./models/Session');
// Authentication middleware
const { authenticate, authenticateAdmin } = require('./middleware/auth');

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
app.use(express.static(path.join(__dirname, '.'))); // Serve from current directory

// Database connection
mongoose.connect('mongodb://localhost:27017/whatsappbot', {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => console.log('Connected to MongoDB'))
.catch(err => console.error('MongoDB connection error:', err));

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

// Create WhatsApp client for a user session
async function createWhatsAppSession(userId, sessionId) {
    try {
        const user = await User.findById(userId);
        if (!user) {
            throw new Error('User not found');
        }

        // Check session limit
        const userSessions = await Session.find({ 
            userId, 
            status: { $in: ['connected', 'waiting_qr'] } 
        });
        
        if (userSessions.length >= subscriptionPlans[user.subscription].maxSessions) {
            throw new Error(`Subscription limit reached. ${user.subscription} plan allows ${subscriptionPlans[user.subscription].maxSessions} sessions.`);
        }

        const client = new Client({
            authStrategy: new LocalAuth({ 
                clientId: `user-${userId}-${sessionId}` 
            }),
            puppeteer: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            }
        });

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

        // QR Code event
        client.on('qr', async (qr) => {
            console.log(`QR received for session ${sessionId}`);
            
            // Update session status
            await Session.findOneAndUpdate(
                { sessionId },
                { 
                    status: 'waiting_qr',
                    qrCode: qr
                }
            );

            // Emit to specific user
            io.to(`user-${userId}`).emit('qrCode', {
                sessionId,
                qr,
                message: 'Scan this QR code with WhatsApp'
            });
        });

        // Ready event
        client.on('ready', async () => {
            console.log(`WhatsApp client ready for session ${sessionId}`);
            
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

        // Message event with permission checking
        client.on('message', async (message) => {
            await handleIncomingMessage(userId, sessionId, message);
        });

        // Disconnection event
        client.on('disconnected', async (reason) => {
            console.log(`Session ${sessionId} disconnected:`, reason);
            
            await Session.findOneAndUpdate(
                { sessionId },
                { status: 'disconnected' }
            );

            activeClients.delete(sessionId);
            
            io.to(`user-${userId}`).emit('sessionDisconnected', {
                sessionId,
                reason
            });
        });

        // Initialize the client
        await client.initialize();
        
        return sessionId;

    } catch (error) {
        console.error('Error creating WhatsApp session:', error);
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
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    // User joins their personal room
    socket.on('join-user-room', (userId) => {
        socket.join(`user-${userId}`);
        console.log(`User ${userId} joined their room`);
    });

    // Admin joins admin room
    socket.on('join-admin-room', (adminId) => {
        socket.join('admin-room');
        console.log(`Admin ${adminId} joined admin room`);
    });

    // Create new WhatsApp session
    socket.on('createSession', async (data) => {
        try {
            const { userId } = data;
            const sessionId = `session-${userId}-${Date.now()}`;
            
            await createWhatsAppSession(userId, sessionId);
            
            socket.emit('sessionCreated', {
                sessionId,
                message: 'WhatsApp session created successfully'
            });
            
        } catch (error) {
            socket.emit('sessionError', {
                error: error.message
            });
        }
    });

    // Send message from admin dashboard
    socket.on('sendMessage', async (data) => {
        try {
            const { sessionId, to, message } = data;
            const sessionData = activeClients.get(sessionId);
            
            if (!sessionData) {
                throw new Error('Session not found or disconnected');
            }
            
            await sessionData.client.sendMessage(to, message);
            
            socket.emit('messageSent', {
                success: true,
                to,
                message
            });
            
        } catch (error) {
            socket.emit('messageSent', {
                success: false,
                error: error.message
            });
        }
    });

    // Get user sessions
    socket.on('getUserSessions', async (userId) => {
        try {
            const sessions = await Session.find({ userId }).sort({ createdAt: -1 });
            socket.emit('userSessions', sessions);
        } catch (error) {
            socket.emit('sessionsError', { error: error.message });
        }
    });

    // Admin: Get all sessions (for admin dashboard)
    socket.on('getAllSessions', async () => {
        try {
            const sessions = await Session.find()
                .populate('userId', 'name email subscription')
                .sort({ createdAt: -1 });
            socket.emit('allSessions', sessions);
        } catch (error) {
            socket.emit('sessionsError', { error: error.message });
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

// Serve static files from root directory
app.use(express.static(path.join(__dirname, '.')));

// Serve home page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve user dashboard
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Serve admin dashboard
app.get('/admin-dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin-dashboard.html'));
});

// Serve payment page
app.get('/payment', (req, res) => {
    res.sendFile(path.join(__dirname, 'payment.html'));
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
        const sessionId = `session-${req.user.id}-${Date.now()}`;
        await createWhatsAppSession(req.user.id, sessionId);
        
        res.json({
            success: true,
            data: { sessionId },
            message: 'Session created successfully'
        });
    } catch (error) {
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

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 WhatsApp Bot Server running on port ${PORT}`);
    console.log(`📱 Home Page: http://localhost:${PORT}`);
    console.log(`👤 User Dashboard: http://localhost:${PORT}/dashboard`);
    console.log(`👨‍💼 Admin Dashboard: http://localhost:${PORT}/admin-dashboard`);
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