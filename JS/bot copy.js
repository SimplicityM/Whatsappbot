// In bot.js - Manage multiple WhatsApp sessions
const userSessions = new Map();

userSessions.set('user1', {
    client: whatsappClient1,
    subscription: 'premium',
    allowedCommands: ['broadcast', 'auto-reply', 'analytics'],
    connected: true
});

userSessions.set('user2', {
    client: whatsappClient2, 
    subscription: 'basic',
    allowedCommands: ['auto-reply'],
    connected: true
});


const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// User session storage
const userSessions = new Map();:
const userSubscriptions = {
    'free': ['ping', 'help'],
    'basic': ['ping', 'help', 'broadcast', 'auto-reply'],
    'premium': ['ping', 'help', 'broadcast', 'auto-reply', 'analytics', 'scheduler']
};

// Create a new WhatsApp session for a user
function createUserSession(userId, subscription = 'free') {
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: userId }),
        puppeteer: { headless: true }
    });

    const userSession = {
        client: client,
        subscription: subscription,
        allowedCommands: userSubscriptions[subscription],
        qrCode: null,
        status: 'initializing',
        userInfo: null
    };

    userSessions.set(userId, userSession);

    client.on('qr', (qr) => {
        userSession.qrCode = qr;
        userSession.status = 'waiting_qr';
        io.emit('userQRCode', { userId, qr, subscription });
    });

    client.on('ready', () => {
        userSession.status = 'connected';
        userSession.userInfo = client.info;
        io.emit('userConnected', { 
            userId, 
            phone: client.info.wid.user,
            subscription 
        });
    });

    client.on('message', (message) => {
        handleUserMessage(userId, message);
    });

    client.initialize();
    return userSession;
}

// Handle messages with permission checking
function handleUserMessage(userId, message) {
    const userSession = userSessions.get(userId);
    if (!userSession) return;

    const command = message.body.split(' ')[0]; // First word as command
    
    // Check if user can use this command
    if (!userSession.allowedCommands.includes(command.replace('!', ''))) {
        message.reply('❌ Command not available in your subscription plan');
        return;
    }

    // Execute allowed command
    executeCommand(userId, command, message);
}

function executeCommand(userId, command, message) {
    switch(command) {
        case '!ping':
            message.reply('🏓 pong');
            break;
        case '!broadcast':
            if (canUserUseCommand(userId, 'broadcast')) {
                // Handle broadcast
                message.reply('📢 Broadcast feature');
            }
            break;
        // Add more commands...
    }
}

// Socket.io for admin control
io.on('connection', (socket) => {
    console.log('Admin connected');

    // Admin: Create test session
    socket.on('createTestSession', () => {
        const testUserId = 'admin-test-' + Date.now();
        createUserSession(testUserId, 'premium');
        socket.emit('testSessionCreated', { userId: testUserId });
    });

    // Admin: Get all user sessions
    socket.on('getAllSessions', () => {
        const sessions = Array.from(userSessions.entries()).map(([userId, session]) => ({
            userId,
            status: session.status,
            subscription: session.subscription,
            phone: session.userInfo?.wid.user,
            allowedCommands: session.allowedCommands
        }));
        socket.emit('allSessions', sessions);
    });

    // Admin: Update user subscription
    socket.on('updateSubscription', (data) => {
        const { userId, newSubscription } = data;
        const session = userSessions.get(userId);
        if (session) {
            session.subscription = newSubscription;
            session.allowedCommands = userSubscriptions[newSubscription];
            socket.emit('subscriptionUpdated', { userId, newSubscription });
        }
    });

    // Admin: Block command for user
    socket.on('blockCommand', (data) => {
        const { userId, command } = data;
        const session = userSessions.get(userId);
        if (session) {
            session.allowedCommands = session.allowedCommands.filter(cmd => cmd !== command);
            socket.emit('commandBlocked', { userId, command });
        }
    });
});

server.listen(3000, () => {
    console.log('Multi-User WhatsApp Bot running on port 3000');
});

// In bot.js - User management
const users = new Map(); // In production, use MongoDB/PostgreSQL

// User structure
const userTemplate = {
    id: 'google-user-id',
    email: 'user@example.com',
    name: 'User Name',
    subscription: 'free', // free, basic, premium
    whatsappSessions: [], // Array of WhatsApp sessions
    createdAt: new Date(),
    allowedCommands: ['ping', 'help']
};

// In bot.js - Add these routes
app.post('/auth/google', async (req, res) => {
    try {
        const { token } = req.body;
        
        // Verify Google token
        const ticket = await client.verifyIdToken({
            idToken: token,
            audience: 'YOUR_GOOGLE_CLIENT_ID'
        });
        
        const payload = ticket.getPayload();
        const userId = payload['sub'];
        
        // Create or get user
        let user = users.get(userId);
        if (!user) {
            user = {
                id: userId,
                email: payload.email,
                name: payload.name,
                subscription: 'free',
                whatsappSessions: [],
                createdAt: new Date(),
                allowedCommands: userSubscriptions.free
            };
            users.set(userId, user);
        }
        
        // Create session and redirect
        const sessionToken = generateSessionToken();
        res.json({ 
            success: true, 
            sessionToken, 
            user: {
                id: user.id,
                name: user.name,
                subscription: user.subscription,
                allowedCommands: user.allowedCommands
            }
        });
        
    } catch (error) {
        res.status(401).json({ success: false, error: 'Authentication failed' });
    }
});


// In bot.js - User-specific WhatsApp sessions
function createUserWhatsAppSession(userId) {
    const user = users.get(userId);
    if (!user) throw new Error('User not found');
    
    const sessionId = `${userId}-${Date.now()}`;
    
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: sessionId }),
        puppeteer: { headless: true }
    });
    
    const userSession = {
        sessionId,
        client,
        userId,
        subscription: user.subscription,
        allowedCommands: user.allowedCommands,
        status: 'initializing'
    };
    
    user.whatsappSessions.push(sessionId);
    userSessions.set(sessionId, userSession);
    
    // Setup client events...
    client.on('qr', (qr) => {
        io.to(userId).emit('qrCode', { sessionId, qr });
    });
    
    client.on('ready', () => {
        userSession.status = 'connected';
        io.to(userId).emit('sessionReady', { sessionId });
    });
    
    client.initialize();
    return sessionId;
}