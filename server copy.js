const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
require('dotenv').config();

// Import models and routes
const User = require('./models/User');
const Session = require('./models/Session');
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
app.use(express.static(path.join(__dirname, 'Public')));

// Enhanced Configuration
const CONFIG = {
    sessionDataPath: path.join(__dirname, 'sessions'),
    mediaPath: path.join(__dirname, 'media'),
    authPath: path.join(__dirname, 'auth'),
    prefix: process.env.COMMAND_PREFIX || '!',
    adminSettings: {
        selfChatOnly: false,
        secondaryAdmins: {}
    }
};

// Create required directories
const requiredDirs = [
    { name: 'sessionDataPath', path: CONFIG.sessionDataPath },
    { name: 'mediaPath', path: CONFIG.mediaPath },
    { name: 'authPath', path: CONFIG.authPath }
];

for (const dir of requiredDirs) {
    try {
        if (!fs.existsSync(dir.path)) {
            fs.mkdirSync(dir.path, { recursive: true });
            console.log(`Created directory: ${dir.path}`);
        }
    } catch (err) {
        console.error(`Directory creation failed for ${dir.name}:`, err.message);
    }
}

// Enhanced storage maps
const activeClients = new Map();
const userSessions = new Map();
const scheduledReminders = new Map();
const clientGroups = new Map();
const groupRefreshIntervals = new Map();
const senderAdminGroups = new Map();
const groupCache = new Map();
const savedContacts = new Set();

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const COMMAND_PREFIX = CONFIG.prefix;

// Media paths
const mediaPath = {
    audio: path.join(CONFIG.mediaPath, 'audio.mp3'),
    document: path.join(CONFIG.mediaPath, 'document.pdf'),
    image: path.join(CONFIG.mediaPath, 'image.jpg')
};

// Load saved contacts
const SAVED_CONTACTS_FILE = path.join(CONFIG.sessionDataPath, 'saved_contacts.json');
if (fs.existsSync(SAVED_CONTACTS_FILE)) {
    try {
        const contacts = JSON.parse(fs.readFileSync(SAVED_CONTACTS_FILE, 'utf8'));
        contacts.forEach(contact => savedContacts.add(contact));
    } catch (error) {
        console.error('Error loading saved contacts:', error);
    }
}

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

// Enhanced logger
const logger = {
    info: (message) => console.log(`[${new Date().toISOString()}] INFO: ${message}`),
    error: (message, error) => console.error(`[${new Date().toISOString()}] ERROR: ${message}`, error)
};

// Authorization functions
const authorizedNumbers = new Set();

const isPrimaryAdmin = (userId) => {
    return authorizedNumbers.has(userId);
};

const isSecondaryAdmin = (userId) => {
    if (!CONFIG.adminSettings?.secondaryAdmins) return false;
    const cleanNumber = userId.replace('@c.us', '');
    return CONFIG.adminSettings.secondaryAdmins[cleanNumber]?.enabled === true;
};

const isAuthorized = (userId) => {
    return isPrimaryAdmin(userId) || isSecondaryAdmin(userId);
};

// Enhanced contact saving
async function saveNewContact(client, phoneNumber, name = null) {
    try {
        if (!client.info) {
            logger.info('Client not ready, skipping contact save');
            return false;
        }

        if (savedContacts.has(phoneNumber)) {
            logger.info(`Contact ${phoneNumber} already saved`);
            return false;
        }

        const contactName = name || `New Contact ${phoneNumber}`;
        await client.pupPage.evaluate((contact, name) => {
            return window.WWebJS.contactAdd(contact, name);
        }, phoneNumber, contactName);

        savedContacts.add(phoneNumber);
        fs.writeFileSync(SAVED_CONTACTS_FILE, JSON.stringify([...savedContacts]));
        logger.info(`New contact saved: ${phoneNumber} as "${contactName}"`);
        return true;
    } catch (error) {
        logger.error(`Failed to save contact ${phoneNumber}:`, error);
        return false;
    }
}

// Enhanced group management
async function getGroupsWhereSenderIsAdmin(client, senderId) {
    try {
        logger.info(`🔍 Fetching groups where ${senderId} is admin`);

        const chats = await client.getChats();
        logger.info(`📦 Total chats retrieved: ${chats.length}`);

        const groupChats = chats.filter(chat => chat.isGroup);
        logger.info(`👥 Group chats found: ${groupChats.length}`);

        if (groupChats.length === 0) {
            return [];
        }

        const senderAdminGroupsList = [];
        const cleanSenderId = senderId.replace('@c.us', '');

        for (const chat of groupChats) {
            try {
                await chat.fetchParticipants();

                const senderParticipant = chat.participants.find(p => {
                    const participantId = p.id._serialized;

                    // Fixed regex - removed extra backslash
                    const clean = n => (n || '').replace(/\D/g, '');
                    const senderDigits = clean(senderId);
                    const participantDigits = clean(participantId);

                    return senderDigits && participantDigits && (
                        senderDigits === participantDigits ||
                        participantDigits.endsWith(senderDigits) ||
                        senderDigits.endsWith(participantDigits)
                    );
                });

                if (senderParticipant && senderParticipant.isAdmin) {
                    senderAdminGroupsList.push(chat);
                    logger.info(`🎉 ADMIN GROUP FOUND: "${chat.name}"`);
                }

            } catch (err) {
                logger.error(`⚠️ Error processing group "${chat.name}":`, err.message);
            }
        }

        logger.info(`✅ Found ${senderAdminGroupsList.length} admin groups`);
        return senderAdminGroupsList;

    } catch (error) {
        logger.error('❌ Critical error in getGroupsWhereSenderIsAdmin:', error);
        return [];
    }
}

// Enhanced WhatsApp session creation with bot functionality
async function createWhatsAppSession(userId, sessionId) {
    try {
        console.log('='.repeat(60));
        console.log('🔄 SERVER: Creating Enhanced WhatsApp session with bot features');
        console.log('👤 User ID:', userId);
        console.log('📱 Session ID:', sessionId);

        const user = await User.findById(userId);
        if (!user) {
            throw new Error('User not found');
        }

        // Check session limit
        const userActiveSessions = await Session.find({
            userId,
            status: { $in: ['connected', 'waiting_qr'] }
        });

        if (userActiveSessions.length >= subscriptionPlans[user.subscription || 'free'].maxSessions) {
            throw new Error(`Subscription limit reached. ${user.subscription || 'free'} plan allows ${subscriptionPlans[user.subscription || 'free'].maxSessions} sessions.`);
        }

        const client = new Client({
            authStrategy: new LocalAuth({
                clientId: `user-${userId}-${sessionId}`
            }),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-gpu',
                    '--disable-dev-shm-usage'
                ]
            }
        });

        // Store the client with enhanced data
        activeClients.set(sessionId, {
            client,
            userId,
            subscription: user.subscription || 'free',
            userEmail: user.email
        });

        // Create session record
        const session = new Session({
            userId,
            sessionId,
            status: 'initializing',
            subscriptionAtTime: user.subscription || 'free'
        });
        await session.save();

        // Setup enhanced client events with bot functionality
        setupEnhancedClientEvents(client, sessionId, userId, user);

        // Initialize the client
        await client.initialize();

        return sessionId;

    } catch (error) {
        console.error('❌ Enhanced session creation failed:', error);
        throw error;
    }
}

// Enhanced client event setup with full bot functionality
function setupEnhancedClientEvents(client, sessionId, userId, user) {
    // QR Code event
    client.on('qr', async (qr) => {
        console.log('📱 QR CODE GENERATED for session:', sessionId);

        // Update session status
        await Session.findOneAndUpdate(
            { sessionId },
            {
                status: 'waiting_qr',
                qrCode: qr
            }
        );

        // Emit to user's room
        const roomName = `user-${userId}`;
        io.to(roomName).emit('qrCode', {
            sessionId,
            qr,
            message: 'Scan this QR code with WhatsApp'
        });
    });

    // Ready event with enhanced setup
    client.on('ready', async () => {
        console.log(`✅ Enhanced client ready for session: ${sessionId}`);

        await Session.findOneAndUpdate(
            { sessionId },
            {
                status: 'connected',
                phone: client.info.wid.user,
                connectedAt: new Date()
            }
        );

        // Store user session mapping
        const selfId = client.info.wid._serialized;
        userSessions.set(selfId, sessionId);

        // Initialize groups
        await refreshGroupsForSession(client, sessionId);

        // Setup periodic group refresh
        groupRefreshIntervals.set(
            sessionId,
            setInterval(() => refreshGroupsForSession(client, sessionId), 600000)
        );

        // Emit ready event
        io.to(`user-${userId}`).emit('sessionReady', {
            sessionId,
            phone: client.info.wid.user,
            message: 'WhatsApp connected successfully!'
        });

        // Send welcome message to self
        try {
            const selfChat = await client.getChatById(selfId);
            await selfChat.sendMessage(`🤖 *Enhanced Bot Connected*\n\nSession ID: \`${sessionId}\`\nUser: ${user.email}\nSubscription: ${user.subscription || 'free'}`);
            await selfChat.sendMessage("👋 Enhanced WhatsApp Bot is ready! Use !help to see available commands");
        } catch (error) {
            console.error('Error sending welcome message:', error);
        }
    });

    // Enhanced message handling with full bot commands
    client.on('message', async (message) => {
        await handleEnhancedMessage(message, client, sessionId, userId);
    });

    client.on('message_create', async (message) => {
        await handleEnhancedMessageCreate(message, client, sessionId, userId);
    });

    // Call handling with contact saving
    client.on('call', async (call) => {
        try {
            if (!client.info) return;

            const caller = call.from;
            const contact = await client.getContactById(caller);

            if (!contact.name || contact.name === contact.pushname || contact.name === caller.split('@')[0]) {
                await saveNewContact(client, caller, contact.pushname || null);
            }
        } catch (error) {
            logger.error('Error handling call event:', error);
        }
    });

    // Group events
    client.on('group_join', async (notification) => {
        await handleGroupJoin(notification, client, sessionId, userId);
    });

    client.on('group_admin_changed', async (notification) => {
        await handleGroupAdminChanged(notification, client, sessionId, userId);
    });

    // Disconnection handling
    client.on('disconnected', (reason) => {
        console.log(`Client ${sessionId} disconnected: ${reason}`);

        // Cleanup
        if (groupRefreshIntervals.has(sessionId)) {
            clearInterval(groupRefreshIntervals.get(sessionId));
            groupRefreshIntervals.delete(sessionId);
        }

        clientGroups.delete(sessionId);
        activeClients.delete(sessionId);

        // Clean up sender admin groups
        for (const key of senderAdminGroups.keys()) {
            if (key.endsWith(`_${sessionId}`)) {
                senderAdminGroups.delete(key);
            }
        }

        // Attempt reconnection for non-logout disconnections
        if (reason !== 'NAVIGATION' && reason !== 'LOGOUT') {
            setTimeout(() => {
                console.log(`Attempting to recreate session ${sessionId}`);
                createWhatsAppSession(userId, sessionId).catch(console.error);
            }, 10000);
        }
    });

    client.on('auth_failure', (error) => {
        console.error(`Authentication failed for session ${sessionId}:`, error);
        activeClients.delete(sessionId);
    });
}

// Enhanced message handling with full bot commands
async function handleEnhancedMessage(message, client, sessionId, userId) {
    try {
        if (message.fromMe || !message.body || message.from === 'status@broadcast') {
            return;
        }

        if (!message.body.trim().startsWith(COMMAND_PREFIX)) {
            return;
        }

        if (!client.info) {
            return;
        }

        const sender = message.from;
        const selfId = client.info.wid._serialized;

        // Authorization check
        if (sender !== selfId && !isAuthorized(sender)) {
            return await message.reply("🔒 Admin-only command");
        }

        const [command, ...args] = message.body
            .slice(COMMAND_PREFIX.length)
            .trim()
            .split(/\s+/);

        // React to command
        try {
            await message.react(isPrimaryAdmin(sender) ? '👑' : '🔧');
        } catch (error) {
            // Ignore reaction errors
        }

        // Process command
        await processEnhancedCommand(command.toLowerCase(), args, message, client, sessionId, userId);

    } catch (error) {
        console.error("Enhanced message handler error:", error);
    }
}

// Enhanced message_create handling for self-chat
async function handleEnhancedMessageCreate(message, client, sessionId, userId) {
    try {
        if (!client.info) return;

        const selfId = client.info.wid._serialized;

        if (!message.fromMe || message.to !== selfId) {
            return;
        }

        if (!message.body || !message.body.trim().startsWith(COMMAND_PREFIX)) {
            return;
        }

        const [command, ...args] = message.body
            .slice(COMMAND_PREFIX.length)
            .trim()
            .split(/\s+/);

        try {
            await message.react('🤖');
        } catch (error) {
            // Ignore reaction errors
        }

        await processEnhancedCommand(command.toLowerCase(), args, message, client, sessionId, userId);

    } catch (error) {
        console.error("Enhanced message_create handler error:", error);
    }
}

// Process enhanced commands with full bot functionality
async function processEnhancedCommand(command, args, message, client, sessionId, userId) {
    const selfId = client.info.wid._serialized;
    const senderId = message.fromMe ? selfId : message.from;

    switch (command) {
        case 'ping':
            await message.reply('Pong! 🏓');
            break;

        case 'help':
            await message.reply(`*🤖 Enhanced WhatsApp Bot Commands:*

Basic Commands:
1. !ping - Test bot response
2. !help - Show this help
3. !status - Show bot status
4. !info - Show chat information

Group Management:
5. !list - List groups where you are admin
6. !refreshgroups - Refresh your admin groups
7. !tagall [group numbers] - Mention all in specified groups
8. !tagallexcept [groups] [phone numbers] - Mention all except specified

Contact Management:
9. !savecontact [phone] [name] - Save a new contact
10. !contacts - List saved contacts

Media & Files:
11. !media - Send test media
12. !document - Send stored document

Session Management:
13. !sessionid - Get your session ID
14. !newsession - Create new session (admin)

Admin Commands:
15. !sudo - Advanced admin commands
16. !shutdown - Shutdown bot (admin only)

Debug Commands:
17. !testchats - Debug chat retrieval
18. !testparticipants - Debug participant detection
19. !listraw - Raw admin detection test
20. !listsimple - Simplified list test

💡 Use numbers from !list with !tagall and !tagallexcept commands`);
            break;

        case 'status':
            const clientData = activeClients.get(sessionId);
            const status = `*🤖 Enhanced Bot Status:*
Session ID: \`${sessionId}\`
User: ${clientData?.userEmail || 'Unknown'}
Subscription: ${clientData?.subscription || 'free'}
Uptime: ${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m
Active sessions: ${activeClients.size}
Memory usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB
Admin groups cached: ${senderAdminGroups.has(`${senderId}_${sessionId}`) ? senderAdminGroups.get(`${senderId}_${sessionId}`).length : 0}`;
            await message.reply(status);
            break;

        case 'info':
            const chatInfo = await message.getChat();
            let info = `💬 Chat Information:
Type: ${chatInfo.isGroup ? 'Group' : 'Private'}
Name: ${chatInfo.name || 'N/A'}`;

            if (chatInfo.isGroup) {
                info += `
Participants: ${chatInfo.participants.length}
Description: ${chatInfo.description || 'N/A'}
Created: ${chatInfo.createdAt ? new Date(chatInfo.createdAt * 1000).toLocaleDateString() : 'N/A'}`;
            }
            await message.reply(info);
            break;

        case 'list':
            try {
                await message.reply('⏳ Fetching groups where you are admin...');
                const userAdminGroups = await getGroupsWhereSenderIsAdmin(client, senderId);
                if (!userAdminGroups.length) {
                    await message.reply('❌ You are not an admin in any groups');
                    break;
                }
                const senderKey = `${senderId}_${sessionId}`;
                senderAdminGroups.set(senderKey, userAdminGroups);

                const listText = userAdminGroups.map((g, i) =>
                    `${i + 1}. ${g.name || 'Unnamed Group'} (${g.participants?.length || 0} members)`
                ).join('\n');

                await message.reply(`*📋 Groups Where You Are Admin (${userAdminGroups.length})*\n\n${listText}\n\n💡 Use these numbers with !tagall or !tagallexcept commands`);
            } catch (error) {
                console.error('Error in !list command:', error);
                await message.reply('❌ Error fetching groups');
            }
            break;

        case 'refreshgroups':
            await message.reply('🔄 Refreshing your admin groups...');
            const senderKey = `${senderId}_${sessionId}`;
            const refreshedGroups = await getGroupsWhereSenderIsAdmin(client, senderId);
            senderAdminGroups.set(senderKey, refreshedGroups);
            await message.reply(`✅ Refreshed: Found ${refreshedGroups.length} groups where you are admin`);
            break;

        case 'tagall':
            await handleGroupTagCommand(message, args, client, sessionId);
            break;

        case 'tagallexcept':
            await handleGroupTagExceptCommand(message, args, client, sessionId);
            break;

        case 'savecontact':
            if (args.length < 1) {
                await message.reply('Usage: !savecontact [phone number] [optional name]');
                return;
            }
            const phoneNumber = args[0];
            const contactName = args.length > 1 ? args.slice(1).join(' ') : null;
            const saved = await saveNewContact(client, phoneNumber, contactName);
            await message.reply(saved ? '✅ Contact saved successfully' : '❌ Failed to save contact or already exists');
            break;

        case 'contacts':
            const contactsList = [...savedContacts].slice(0, 20).join('\n');
            await message.reply(`*📱 Saved Contacts (${savedContacts.size} total):*\n${contactsList || 'No contacts saved'}\n\n${savedContacts.size > 20 ? '... and more' : ''}`);
            break;

        case 'media':
            if (fs.existsSync(mediaPath.image)) {
                const media = MessageMedia.fromFilePath(mediaPath.image);
                await message.reply(media);
            } else {
                await message.reply('❌ No test image found. Please add an image to the media folder.');
            }
            break;

        case 'document':
            await sendDocument(message);
            break;

        case 'sessionid':
            const sessionIdFromMap = userSessions.get(selfId);
            await message.reply(`*📱 Session Information:*\nYour session ID: \`${sessionIdFromMap || sessionId}\`\nUser ID: \`${userId}\``);
            break;

        case 'newsession':
            if (!isPrimaryAdmin(senderId)) {
                await message.reply('🚫 Only primary admins can create new sessions');
                return;
            }
            try {
                const newSessionId = `session-${userId}-${Date.now()}`;
                await createWhatsAppSession(userId, newSessionId);
                await message.reply(`✅ New session created with ID: \`${newSessionId}\``);
            } catch (error) {
                await message.reply(`❌ Failed to create new session: ${error.message}`);
            }
            break;

        case 'sudo':
            await handleSudoCommand(message, args, client, sessionId);
            break;

        case 'shutdown':
            if (!isPrimaryAdmin(senderId)) {
                await message.reply('🚫 Only primary admins can shutdown the bot');
                return;
            }
            await handleShutdown(message);
            break;

        // Debug commands
        case 'testchats':
            try {
                await message.reply('🔍 Testing chat retrieval...');
                const chats = await client.getChats();
                const groups = chats.filter(c => c.isGroup);
                await message.reply(`📊 Chat Statistics:
• Total chats: ${chats.length}
• Group chats: ${groups.length}
• First 3 groups: ${groups.slice(0, 3).map(g => g.name).join(', ')}`);
            } catch (error) {
                await message.reply(`❌ Error getting chats: ${error.message}`);
            }
            break;

        case 'testparticipants':
            try {
                const chats = await client.getChats();
                const firstGroup = chats.find(c => c.isGroup);

                if (!firstGroup) {
                    await message.reply('❌ No groups found');
                    break;
                }

                await message.reply(`🔍 Testing participants in: "${firstGroup.name}"`);
                await firstGroup.fetchParticipants();

                const participant = firstGroup.participants.find(p =>
                    p.id._serialized === senderId ||
                    p.id.user === senderId.replace('@c.us', '')
                );

                await message.reply(`📊 *Participant Test Results:*
• Group: "${firstGroup.name}"
• Total participants: ${firstGroup.participants.length}
• Your ID: \`${senderId}\`
• Found you: ${participant ? '✅ Yes' : '❌ No'}
• You are admin: ${participant?.isAdmin ? '✅ Yes' : '❌ No'}
• Participant ID: \`${participant?.id._serialized || 'Not found'}\``);
            } catch (error) {
                await message.reply(`❌ Error: ${error.message}`);
            }
            break;

        case 'listraw':
            try {
                await message.reply('🔍 Raw admin detection test...');

                const chats = await client.getChats();
                const groups = chats.filter(c => c.isGroup);

                let adminCount = 0;
                let errors = 0;

                for (const group of groups.slice(0, 10)) { // Limit to first 10 for testing
                    try {
                        await group.fetchParticipants();
                        const participant = group.participants.find(p =>
                            p.id._serialized === senderId ||
                            p.id.user === senderId.replace('@c.us', '')
                        );

                        if (participant && participant.isAdmin) {
                            adminCount++;
                        }
                    } catch (err) {
                        errors++;
                    }
                }

                await message.reply(`📊 *Raw Detection Results:*
• Total groups tested: ${Math.min(groups.length, 10)}
• Admin groups found: ${adminCount}
• Errors encountered: ${errors}
• Your ID: \`${senderId}\``);
            } catch (error) {
                await message.reply(`❌ Raw test failed: ${error.message}`);
            }
            break;

        case 'listsimple':
            try {
                await message.reply('⏳ Simple admin group detection...');

                const chats = await client.getChats();
                const groups = chats.filter(c => c.isGroup);

                if (groups.length === 0) {
                    await message.reply('❌ No groups found');
                    break;
                }

                let adminGroups = [];

                for (let i = 0; i < Math.min(groups.length, 5); i++) {
                    const group = groups[i];
                    try {
                        await group.fetchParticipants();

                        const you = group.participants.find(p =>
                            p.id._serialized.includes(senderId.replace('@c.us', '')) ||
                            senderId.includes(p.id.user)
                        );

                        if (you && you.isAdmin) {
                            adminGroups.push(group);
                        }
                    } catch (err) {
                        console.log(`Error in ${group.name}: ${err.message}`);
                    }
                }

                if (adminGroups.length > 0) {
                    const list = adminGroups.map((g, i) => `${i + 1}. ${g.name}`).join('\n');
                    await message.reply(`✅ Found ${adminGroups.length} admin groups:\n\n${list}`);
                } else {
                    await message.reply(`❌ No admin groups found in first ${Math.min(groups.length, 5)} groups`);
                }
            } catch (error) {
                await message.reply(`❌ Simple test failed: ${error.message}`);
            }
            break;

        default:
            await message.reply('❓ Unknown command. Use !help to see available commands.');
    }
}

// Enhanced group tagging command
async function handleGroupTagCommand(message, args, client, sessionId) {
    try {
        if (args.length < 1) {
            await message.reply('Usage: !tagall [group numbers...]\nExample: !tagall 1 3\n\n💡 Use !list first to see your admin groups');
            return;
        }

        const senderId = message.fromMe ? client.info.wid._serialized : message.from;
        const senderKey = `${senderId}_${sessionId}`;
        let userAdminGroups = senderAdminGroups.get(senderKey);

        if (!userAdminGroups) {
            await message.reply('⏳ Fetching your admin groups...');
            userAdminGroups = await getGroupsWhereSenderIsAdmin(client, senderId);
            senderAdminGroups.set(senderKey, userAdminGroups);
        }

        if (!userAdminGroups.length) {
            await message.reply('❌ You are not an admin in any groups. Use !list to refresh.');
            return;
        }

        const groupIndices = args.map(num => parseInt(num) - 1);
        let successCount = 0;
        let totalTagged = 0;

        for (const index of groupIndices) {
            if (index >= 0 && index < userAdminGroups.length) {
                const group = userAdminGroups[index];

                try {
                    await group.fetchParticipants();

                    const senderParticipant = group.participants.find(p =>
                        p.id._serialized === senderId
                    );

                    if (!senderParticipant || !senderParticipant.isAdmin) {
                        await message.reply(`❌ You are no longer admin in "${group.name}"`);
                        continue;
                    }

                    let mentions = [];
                    let text = `*📢 Tagged by admin*\n\n`;

                    for (const participant of group.participants) {
                        mentions.push(participant.id._serialized);
                        text += `@${participant.id.user} `;
                    }

                    await client.sendMessage(group.id._serialized, text, { mentions });
                    logger.info(`${senderId} tagged all members in group: ${group.name}`);
                    successCount++;
                    totalTagged += group.participants.length;
                } catch (error) {
                    logger.error(`Error tagging in group ${group.name}:`, error);
                    await message.reply(`❌ Failed to tag in "${group.name}"`);
                }
            } else {
                await message.reply(`❌ Invalid group number: ${index + 1}`);
            }
        }

        if (successCount > 0) {
            await message.reply(`✅ Successfully tagged ${totalTagged} members in ${successCount} group(s)`);
        }
    } catch (error) {
        logger.error('Error in tagall command:', error);
        await message.reply('❌ Failed to tag members');
    }
}

// Enhanced group tag except command
async function handleGroupTagExceptCommand(message, args, client, sessionId) {
    try {
        if (args.length < 2) {
            await message.reply('Usage: !tagallexcept [group numbers...] [phone numbers...]\nExample: !tagallexcept 1 3 1234567890 0987654321\n\n💡 Use !list first to see your admin groups');
            return;
        }

        const senderId = message.fromMe ? client.info.wid._serialized : message.from;
        const senderKey = `${senderId}_${sessionId}`;
        let userAdminGroups = senderAdminGroups.get(senderKey);

        if (!userAdminGroups) {
            await message.reply('⏳ Fetching your admin groups...');
            userAdminGroups = await getGroupsWhereSenderIsAdmin(client, senderId);
            senderAdminGroups.set(senderKey, userAdminGroups);
        }

        if (!userAdminGroups.length) {
            await message.reply('❌ You are not an admin in any groups. Use !list to refresh.');
            return;
        }

        const groupIndices = [];
        const exceptNumbers = [];

        for (const arg of args) {
            if (!isNaN(arg) && parseInt(arg) > 0 && parseInt(arg) <= userAdminGroups.length) {
                groupIndices.push(parseInt(arg) - 1);
            } else {
                let cleanNumber = arg.replace(/[^0-9]/g, '');
                if (cleanNumber.length >= 7) { // Valid phone number length
                    exceptNumbers.push(`${cleanNumber}@c.us`);
                }
            }
        }

        if (groupIndices.length === 0) {
            await message.reply('❌ Please specify at least one valid group number');
            return;
        }

        if (exceptNumbers.length === 0) {
            await message.reply('❌ Please specify at least one valid phone number to exclude');
            return;
        }

        let successCount = 0;
        let totalTagged = 0;
        let totalExcluded = 0;

        for (const index of groupIndices) {
            const group = userAdminGroups[index];

            try {
                await group.fetchParticipants();

                const senderParticipant = group.participants.find(p =>
                    p.id._serialized === senderId
                );

                if (!senderParticipant || !senderParticipant.isAdmin) {
                    await message.reply(`❌ You are no longer admin in "${group.name}"`);
                    continue;
                }

                let mentions = [];
                let text = `*📢 Tagged by admin (excluding specified members)*\n\n`;
                let taggedCount = 0;
                let excludedInThisGroup = 0;

                for (const participant of group.participants) {
                    const participantNumber = participant.id._serialized;

                    if (exceptNumbers.includes(participantNumber)) {
                        excludedInThisGroup++;
                    } else {
                        mentions.push(participantNumber);
                        text += `@${participant.id.user} `;
                        taggedCount++;
                    }
                }

                if (taggedCount === 0) {
                    await message.reply(`⚠️ No members to tag in "${group.name}" - all members were excluded`);
                    continue;
                }

                await client.sendMessage(group.id._serialized, text, { mentions });
                logger.info(`${senderId} tagged ${taggedCount} members in group ${group.name}, excluded ${excludedInThisGroup} members`);
                successCount++;
                totalTagged += taggedCount;
                totalExcluded += excludedInThisGroup;

            } catch (error) {
                logger.error(`Error tagging in group ${group.name}:`, error);
                await message.reply(`❌ Failed to tag in "${group.name}"`);
            }
        }

        if (successCount > 0) {
            await message.reply(`✅ Successfully tagged ${totalTagged} members in ${successCount} group(s)\n📊 Total excluded: ${totalExcluded} members\n📱 Excluded numbers: ${exceptNumbers.length}`);
        } else {
            await message.reply('❌ No groups were successfully tagged');
        }

    } catch (error) {
        logger.error('Error in tagallexcept command:', error);
        await message.reply('❌ Failed to tag members. Please try again.');
    }
}

// Enhanced sudo command handling
async function handleSudoCommand(message, args, client, sessionId) {
    const senderId = message.fromMe ? client.info.wid._serialized : message.from;

    if (!isPrimaryAdmin(senderId)) {
        await message.reply('🚫 You are not authorized to use sudo commands');
        return;
    }

    if (!args.length) {
        await message.reply(`🔧 Enhanced Sudo Commands:

System Information:
• !sudo stats - Detailed system statistics
• !sudo sessions - List all active sessions
• !sudo users - Show connected users

Session Management:
• !sudo clearsessions - Clear inactive sessions
• !sudo restart [sessionId] - Restart specific session
• !sudo killsession [sessionId] - Force kill session

Communication:
• !sudo broadcast [message] - Send to all sessions
• !sudo notify [userId] [message] - Send to specific user

Maintenance:
• !sudo cleanup - Clean cache and temporary data
• !sudo backup - Backup session data
• !sudo logs - Show recent error logs

Advanced:
• !sudo eval [code] - Execute JavaScript (dangerous)
• !sudo config - Show current configuration`);
        return;
    }

    const subCommand = args[0];

    switch (subCommand) {
        case 'stats':
            const memUsage = process.memoryUsage();
            const stats = `*📊 Enhanced System Statistics:*
Memory Usage:
• Heap Used: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB
• Heap Total: ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB
• RSS: ${Math.round(memUsage.rss / 1024 / 1024)}MB

Sessions:
• Active: ${activeClients.size}
• User Sessions: ${userSessions.size}
• Groups Cached: ${clientGroups.size}

Database:
• Connection: ${mongoose.connection.readyState === 1 ? '✅ Connected' : '❌ Disconnected'}
• Database: ${mongoose.connection.name}

Uptime: ${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m`;
            await message.reply(stats);
            break;

        case 'sessions':
            const sessionsList = [];
            for (const [sId, data] of activeClients) {
                sessionsList.push(`• ${sId} - ${data.userEmail} (${data.subscription})`);
            }
            await message.reply(`*📱 Active Sessions (${sessionsList.length}):*\n${sessionsList.join('\n') || 'No active sessions'}`);
            break;

        case 'users':
            const users = new Set();
            for (const data of activeClients.values()) {
                users.add(data.userEmail);
            }
            await message.reply(`*👥 Connected Users (${users.size}):*\n${[...users].join('\n') || 'No users connected'}`);
            break;

        case 'broadcast':
            if (args.length < 2) {
                await message.reply('Usage: !sudo broadcast [message]');
                return;
            }
            const broadcastMessage = args.slice(1).join(' ');
            let broadcastCount = 0;
            for (const [sId, data] of activeClients) {
                try {
                    const client = data.client;
                    const selfChat = await client.getChatById(client.info.wid._serialized);
                    await selfChat.sendMessage(`*📢 Admin Broadcast:*\n${broadcastMessage}`);
                    broadcastCount++;
                } catch (error) {
                    console.error(`Failed to broadcast to session ${sId}:`, error);
                }
            }
            await message.reply(`✅ Broadcast sent to ${broadcastCount} sessions`);
            break;

        case 'eval':
            if (!isPrimaryAdmin(senderId)) {
                await message.reply('🚫 Only primary admin can use eval');
                return;
            }
            try {
                const code = args.slice(1).join(' ');
                const result = eval(code);
                await message.reply(`✅ Eval Result:\n\`\`\`\n${result}\n\`\`\``);
            } catch (error) {
                await message.reply(`❌ Eval Error:\n\`\`\`\n${error.message}\n\`\`\``);
            }
            break;

        default:
            await message.reply('❓ Unknown sudo command');
    }
}

// Enhanced shutdown handling
async function handleShutdown(message) {
    await message.reply('🔄 Shutting down enhanced bot...');

    // Cleanup all sessions
    for (const [sessionId, data] of activeClients) {
        try {
            await data.client.destroy();
        } catch (error) {
            console.error(`Error destroying session ${sessionId}:`, error);
        }
    }

    // Clear intervals
    for (const interval of groupRefreshIntervals.values()) {
        clearInterval(interval);
    }

    // Clear all maps
    activeClients.clear();
    userSessions.clear();
    scheduledReminders.clear();
    clientGroups.clear();
    groupRefreshIntervals.clear();
    senderAdminGroups.clear();
    groupCache.clear();

    await message.reply('✅ Enhanced bot shutdown complete');

    // Graceful server shutdown
    setTimeout(() => {
        process.exit(0);
    }, 2000);
}

// Enhanced group refresh function
async function refreshGroupsForSession(client, sessionId) {
    try {
        const chats = await client.getChats();
        const groups = chats.filter(chat => chat.isGroup);
        clientGroups.set(sessionId, groups);
        logger.info(`Refreshed ${groups.length} groups for session ${sessionId}`);
    } catch (error) {
        logger.error(`Error refreshing groups for session ${sessionId}:`, error);
    }
}

// Enhanced group event handlers
async function handleGroupJoin(notification, client, sessionId, userId) {
    try {
        const group = await client.getChatById(notification.chatId);
        const inviter = await client.getContactById(notification.author);
        const invitee = notification.recipients.map(r => r.split('@')[0]).join(', ');

        const selfChat = await client.getChatById(client.info.wid._serialized);
        await selfChat.sendMessage(
            `👥 *Group Join Event*\n\n` +
            `Group: ${group.name}\n` +
            `Inviter: ${inviter.name || inviter.pushname || inviter.number}\n` +
            `New Member: ${invitee}\n` +
            `Time: ${new Date().toLocaleString()}`
        );
    } catch (error) {
        logger.error('Error handling group join:', error);
    }
}

async function handleGroupAdminChanged(notification, client, sessionId, userId) {
    try {
        const group = await client.getChatById(notification.chatId);
        const contact = await client.getContactById(notification.author);

        const selfChat = await client.getChatById(client.info.wid._serialized);
        await selfChat.sendMessage(
            `⚡ *Admin Change Event*\n\n` +
            `Group: ${group.name}\n` +
            `Changed by: ${contact.name || contact.pushname || contact.number}\n` +
            `Action: ${notification.type}\n` +
            `Time: ${new Date().toLocaleString()}`
        );
    } catch (error) {
        logger.error('Error handling admin change:', error);
    }
}

// Enhanced document sending
async function sendDocument(message) {
    try {
        if (fs.existsSync(mediaPath.document)) {
            const media = MessageMedia.fromFilePath(mediaPath.document);
            await message.reply(media, null, { caption: '📄 Here is your document!' });
        } else {
            await message.reply('❌ No test document found. Please add a document to the media folder.');
        }
    } catch (error) {
        logger.error('Error sending document:', error);
        await message.reply('❌ Failed to send document');
    }
}

// API Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'Public', 'index.html'));
});

app.get('/api/sessions/:userId', authenticate, async (req, res) => {
    try {
        const sessions = await Session.find({ userId: req.params.userId });
        res.json(sessions);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/sessions/:userId', authenticate, async (req, res) => {
    try {
        const sessionId = `session-${req.params.userId}-${Date.now()}`;
        await createWhatsAppSession(req.params.userId, sessionId);
        res.json({ sessionId, message: 'Session created successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/sessions/:sessionId', authenticate, async (req, res) => {
    try {
        const sessionData = activeClients.get(req.params.sessionId);
        if (sessionData) {
            await sessionData.client.destroy();
            activeClients.delete(req.params.sessionId);
        }
        await Session.findOneAndDelete({ sessionId: req.params.sessionId });
        res.json({ message: 'Session deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('🔌 New client connected:', socket.id);

    socket.on('joinUserRoom', (userId) => {
        socket.join(`user-${userId}`);
        console.log(`👤 User ${userId} joined room`);
    });

    socket.on('disconnect', () => {
        console.log('🔌 Client disconnected:', socket.id);
    });
});

// Graceful shutdown handling
process.on('SIGINT', async () => {
    console.log('\n🔄 Shutting down gracefully...');

    // Cleanup all clients
    for (const [sessionId, data] of activeClients) {
        try {
            await data.client.destroy();
        } catch (error) {
            console.error(`Error destroying session ${sessionId}:`, error);
        }
    }

    // Close database connection
    await mongoose.connection.close();

    console.log('✅ Cleanup complete. Goodbye!');
    process.exit(0);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('='.repeat(60));
    console.log('🚀 Enhanced WhatsApp Bot Server Started');
    console.log(`📡 Server running on port: ${PORT}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🤖 Command prefix: ${COMMAND_PREFIX}`);
    console.log('='.repeat(60));
});