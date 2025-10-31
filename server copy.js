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

// Subscription plans
const subscriptionPlans = {
    starter: {
        maxSessions: 5,
        allowedCommands: ['ping', 'help', 'status', 'list', 'tagall'],
        features: ['basic_messaging', 'group_tagging']
    },
    professional: {
        maxSessions: 25,
        allowedCommands: ['ping', 'help', 'status', 'list', 'tagall', 'tagallexcept', 'broadcast'],
        features: ['basic_messaging', 'group_tagging', 'advanced_tagging', 'broadcast']
    },
    business: {
        maxSessions: 100,
        allowedCommands: ['ping', 'help', 'status', 'list', 'tagall', 'tagallexcept', 'broadcast', 'analytics'],
        features: ['basic_messaging', 'group_tagging', 'advanced_tagging', 'broadcast', 'analytics']
    },
    enterprise: {
        maxSessions: -1,
        allowedCommands: ['ping', 'help', 'status', 'list', 'tagall', 'tagallexcept', 'broadcast', 'analytics', 'custom'],
        features: ['all_features']
    }
};

// Main WhatsApp session creation function
async function createWhatsAppSession(userId, sessionId) {
    try {
        console.log('='.repeat(60));
        console.log('🔄 Creating WhatsApp session');
        console.log('👤 User ID:', userId);
        console.log('📱 Session ID:', sessionId);
        
        // Get user from database
        const user = await User.findById(userId);
        if (!user) {
            throw new Error('User not found');
        }
        console.log('✅ User found:', user.email);

        // Check session limits
        const userSessions = await Session.find({ 
            userId, 
            status: { $in: ['connected', 'waiting_qr'] } 
        });
        
        const maxSessions = subscriptionPlans[user.subscription]?.maxSessions || 1;
        
        if (maxSessions !== -1 && userSessions.length >= maxSessions) {
            throw new Error(`Session limit reached. ${user.subscription} plan allows ${maxSessions} sessions.`);
        }

        // Create WhatsApp client
        const client = new Client({
            authStrategy: new LocalAuth({ 
                clientId: `user-${userId}-${sessionId}` 
            }),
            puppeteer: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            }
        });

        // Store client
        activeClients.set(sessionId, {
            client,
            userId,
            subscription: user.subscription
        });

        // Create session record in database
        const session = new Session({
            userId,
            sessionId,
            status: 'initializing',
            subscriptionAtTime: user.subscription
        });
        await session.save();

        // QR Code event
        client.on('qr', async (qr) => {
            console.log('📱 QR CODE GENERATED for session:', sessionId);
            
            // Update session status
            await Session.findOneAndUpdate(
                { sessionId },
                { status: 'waiting_qr', qrCode: qr }
            );

            // Emit QR code to user
            const roomName = `user-${userId}`;
            io.to(roomName).emit('qrCode', {
                sessionId,
                qr,
                message: 'Scan this QR code with WhatsApp'
            });
            
            console.log('✅ QR code emitted to room:', roomName);
        });

        // Ready event
        client.on('ready', async () => {
            console.log('✅ WhatsApp client ready for session:', sessionId);
            
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

        // Bot commands - Message handler
        client.on('message_create', async (message) => {
            try {
                const selfId = client.info.wid._serialized;
                
                // Only process self-chat commands
                if (!message.fromMe || message.to !== selfId || !message.body.startsWith('!')) {
                    return;
                }
                
                const [command, ...args] = message.body.slice(1).trim().split(/\s+/);
                
                // React to command
                try {
                    await message.react('🤖');
                } catch (error) {
                    console.error("Failed to react:", error);
                }

                // Handle commands
                switch (command.toLowerCase()) {
                    case 'ping':
                        await message.reply('Pong! 🏓');
                        break;
                        
                    case 'help':
                        await message.reply(`*Available Commands:*
1. !ping - Check bot response
2. !help - Show this help
3. !status - Show bot status
4. !list - List groups where you are admin
5. !tagall [group_number] [message] - Tag all members
6. !info - Get group information`);
                        break;

                    case 'status':
                        const statusMsg = `*Bot Status:*
- Session: ${sessionId}
- User: ${user.email}
- Plan: ${user.subscription}
- Uptime: ${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m`;
                        await message.reply(statusMsg);
                        break;
                        
                    case 'list':
                        await handleListCommand(client, message, selfId);
                        break;
                        
                    case 'tagall':
                        await handleTagAllCommand(client, message, args, selfId);
                        break;
                        
                    default:
                        await message.reply('Unknown command. Try !help');
                }
            } catch (error) {
                console.error('Error processing bot command:', error);
            }
        });

        // Initialize client
        console.log('🔄 Initializing WhatsApp client...');
        await client.initialize();
        console.log('✅ WhatsApp client initialized');
        
        return sessionId;

    } catch (error) {
        console.error('❌ Error creating WhatsApp session:', error);
        throw error;
    }
}

// Bot command handlers
async function handleListCommand(client, message, selfId) {
    try {
        await message.reply('⏳ Fetching groups where you are admin...');
        
        const chats = await client.getChats();
        const groupChats = chats.filter(chat => chat.isGroup);
        
        if (groupChats.length === 0) {
            return message.reply('❌ No groups found');
        }
        
        const adminGroups = [];
        
        for (const chat of groupChats) {
            try {
                await chat.fetchParticipants();
                const userParticipant = chat.participants.find(p => 
                    p.id._serialized === selfId
                );
                
                if (userParticipant && userParticipant.isAdmin) {
                    adminGroups.push(chat);
                }
            } catch (err) {
                console.log(`Error checking ${chat.name}:`, err.message);
            }
        }
        
        if (adminGroups.length === 0) {
            return message.reply('❌ You are not an admin in any groups');
        }
        
        let listText = '';
        adminGroups.forEach((group, index) => {
            listText += `${index + 1}. ${group.name} (${group.participants?.length || 0} members)\n`;
        });
        
        await message.reply(`*📋 Groups Where You Are Admin (${adminGroups.length})*\n\n${listText}\n\n💡 Use: !tagall [number] [message]`);
        
    } catch (error) {
        console.error('Error in list command:', error);
        await message.reply('❌ Error fetching groups');
    }
}

async function handleTagAllCommand(client, message, args, selfId) {
    try {
        if (args.length < 2) {
            return message.reply('❌ Usage: !tagall [group_number] [message]\nUse !list to see group numbers');
        }
        
        const groupNumber = parseInt(args[0]);
        const tagMessage = args.slice(1).join(' ');
        
        // Get admin groups
        const chats = await client.getChats();
        const groupChats = chats.filter(chat => chat.isGroup);
        const adminGroups = [];
        
        for (const chat of groupChats) {
            try {
                await chat.fetchParticipants();
                const userParticipant = chat.participants.find(p => 
                    p.id._serialized === selfId
                );
                
                if (userParticipant && userParticipant.isAdmin) {
                    adminGroups.push(chat);
                }
            } catch (err) {
                console.log(`Error checking ${chat.name}:`, err.message);
            }
        }
        
        if (!adminGroups || groupNumber < 1 || groupNumber > adminGroups.length) {
            return message.reply('❌ Invalid group number. Use !list to see available groups');
        }
        
        const selectedGroup = adminGroups[groupNumber - 1];
        
        // Tag all members
        const mentions = [];
        let mentionText = `${tagMessage}\n\n`;
        
        for (const participant of selectedGroup.participants) {
            if (participant.id._serialized !== selfId) {
                mentions.push(participant.id._serialized);
                mentionText += `@${participant.id.user} `;
            }
        }
        
        await selectedGroup.sendMessage(mentionText, { mentions });
        await message.reply(`✅ Tagged all members in "${selectedGroup.name}"`);
        
    } catch (error) {
        console.error('Error in tagall command:', error);
        await message.reply('❌ Error executing tagall command');
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

// User API endpoints
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