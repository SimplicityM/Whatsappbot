// fixed-server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');
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

const cors = require('cors');
app.use(cors({
    origin: ["http://localhost:3000", "http://127.0.0.1:3000"],
    credentials: true
}));

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

// Subscription tiers
const subscriptionPlans = {
    free: { maxSessions: 1, allowedCommands: ['ping', 'help', 'status'] },
    starter: { maxSessions: 5 },
    professional: { maxSessions: 25 },
    business: { maxSessions: 100 },
    enterprise: { maxSessions: -1 }
};

// 🔑 SIMPLIFIED SESSION CREATION - Remove conflicting event handlers
async function createWhatsAppSession(userId, sessionId) {
    try {
        console.log('='.repeat(60));
        console.log('🔄 SERVER: Creating WhatsApp session');
        console.log('👤 User ID:', userId);
        console.log('📱 Session ID:', sessionId);

        const user = await User.findById(userId);
        if (!user) {
            throw new Error('User not found');
        }
        console.log('✅ SERVER: User found:', user.email);

        // Check session limits
        const userSessions = await Session.find({ 
            userId, 
            status: { $in: ['connected', 'waiting_qr', 'connecting'] } 
        });
        
        const maxSessions = subscriptionPlans[user.subscription]?.maxSessions || 1;
        
        if (maxSessions !== -1 && userSessions.length >= maxSessions) {
            throw new Error(`Session limit reached. ${user.subscription} plan allows ${maxSessions} sessions.`);
        }

        console.log('🔄 SERVER: Calling createBotSession...');
        
        // 🔑 KEY CHANGE: Let bot.js handle ALL events
        const client = await createBotSession(userId, sessionId, io);
        console.log('✅ SERVER: Bot session created successfully');

        // Store client reference
        activeClients.set(sessionId, {
            client,
            userId,
            subscription: user.subscription
        });

        // Create session record
        const session = new Session({
            userId,
            sessionId,
            status: 'waiting_qr',
            subscriptionAtTime: user.subscription
        });
        await session.save();
        console.log('✅ SERVER: Session record saved');

        // 🔑 IMPORTANT: Don't add event handlers here - let bot.js handle them
        console.log('✅ SERVER: Session creation completed');
        console.log('='.repeat(60));
        
        return sessionId;

    } catch (error) {
        console.error('❌ SERVER: Error creating session:', error);
        
        // Update session status to failed
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
            console.error('❌ SERVER: Error updating failed session:', dbError);
        }
        
        throw error;
    }
}

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id);

    socket.on('join-user-room', (userId) => {
        if (!userId) {
            console.log('❌ Cannot join room: user ID is null/undefined');
            return;
        }
        
        const roomName = `user-${userId}`;
        socket.join(roomName);
        console.log(`✅ User ${userId} (socket ${socket.id}) joined room: ${roomName}`);
        
        socket.emit('room-joined', { roomName, userId });
    });

    socket.on('disconnect', () => {
        console.log('❌ Client disconnected:', socket.id);
    });
});

socket.on('join-admin-room', (adminId) => {
    if (!adminId) return;
    
    const roomName = `admin-${adminId}`;
    socket.join(roomName);
    console.log(`Admin ${adminId} joined room: ${roomName}`);
    
    // Send current bot status to admin
    socket.emit('admin-status', {
        activeSessions: clients.size,
        totalUsers: 0, // Get from database
        systemStatus: 'online'
    });
});

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/user'));
app.use('/api/admin', require('./routes/admin'));

// Session creation endpoint
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

app.post('/api/admin/sessions/create', async (req, res) => {
    try {
        console.log('🔄 ADMIN: Creating admin session');
        
        // Generate admin session ID
        const sessionId = `admin-session-${Date.now()}`;
        const adminUserId = 'admin-user'; // You can make this dynamic

        // Create WhatsApp session using your existing function
        await createWhatsAppSession(adminUserId, sessionId);
        
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

// Admin session management
app.get('/api/admin/sessions', authenticateAdmin, async (req, res) => {
    try {
        const sessions = await Session.find()
            .populate('userId', 'fullName email whatsappNumber')
            .sort({ createdAt: -1 });
        
        const sessionsWithStatus = sessions.map(session => ({
            ...session.toObject(),
            isActive: clients.has(session.sessionId)
        }));
        
        res.json({ success: true, data: sessionsWithStatus });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Force disconnect session
app.post('/api/admin/sessions/:sessionId/disconnect', authenticateAdmin, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const client = clients.get(sessionId);
        
        if (client) {
            await client.destroy();
            clients.delete(sessionId);
        }
        
        await Session.findOneAndUpdate(
            { sessionId },
            { status: 'disconnected', errorMessage: 'Disconnected by admin' }
        );
        
        res.json({ success: true, message: 'Session disconnected' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Test bot connection endpoint
app.post('/api/sessions/:sessionId/test', async (req, res) => {
    try {
        const { sessionId } = req.params;
        
        // Get the client from your bot.js clients map
        const { clients } = require('./bot');
        const client = clients.get(sessionId);
        
        if (!client || !client.info) {
            return res.json({
                success: false,
                message: 'Session not found or not ready'
            });
        }

        // Send test message to self-chat
        const selfId = client.info.wid._serialized;
        await client.sendMessage(selfId, '🤖 *Bot Test Successful!*\n\nYour WhatsApp bot is working correctly.\n\nTry these commands:\n• !ping\n• !help\n• !status');

        res.json({
            success: true,
            message: 'Test message sent successfully'
        });

    } catch (error) {
        console.error('Bot test error:', error);
        res.json({
            success: false,
            message: 'Test failed: ' + error.message
        });
    }
});

// Other routes...
// routes/sessions.js - WhatsApp admins creating bot sessions
app.use('/api/sessions', authenticate, require('./routes/sessions'));

// routes/user.js - WhatsApp admin user operations  
app.use('/api/users', authenticate, require('./routes/user'));

// routes/payment.js - WhatsApp admins managing subscriptions
app.use('/api/payment', authenticate, require('./routes/payment'));

// routes/admin.js - System admin dashboard and controls
app.use('/api/admin', authenticateAdmin, require('./routes/admin'));

app.use('/api/sessions', require('./routes/sessions'));
app.use(express.static(path.join(__dirname, 'public')));

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

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 WhatsApp Bot Server running on port ${PORT}`);
    console.log(`📱 Dashboard: http://localhost:${PORT}/dashboard`);
});

module.exports = { createWhatsAppSession };