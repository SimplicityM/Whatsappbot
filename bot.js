const fs = require('fs');
const path = require('path');
const { Client, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const crypto = require('crypto');

require('events').EventEmitter.defaultMaxListeners = 1000;

// --- START CONFIGURATION BLOCK ---
const getDefaultPath = (dirName) => path.join(__dirname, dirName);

const CONFIG = {
    sessionDataPath: getDefaultPath('sessions'),
    mediaPath: getDefaultPath('media'),
    authPath: getDefaultPath('auth'),
    adminSettings: {
        selfChatOnly: false,
        secondaryAdmins: {}
    }
};

try {
    const configPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(configPath)) {
        const loadedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

        for (const key in loadedConfig) {
            if (loadedConfig[key] !== undefined && loadedConfig[key] !== null) {
                CONFIG[key] = loadedConfig[key];
            } else {
                console.warn(`Warning: '${key}' in config.json is invalid and will be ignored.`);
                delete loadedConfig[key];
            }
        }

        if (loadedConfig.adminSettings) {
            CONFIG.adminSettings = {
                ...CONFIG.adminSettings,
                ...loadedConfig.adminSettings
            };
        }

        fs.writeFileSync(configPath, JSON.stringify(CONFIG, null, 2));
        console.log('Loaded and sanitized configuration from config.json');
    } else {
        console.warn('config.json not found, using default configuration');
    }
} catch (error) {
    console.error('Config load error (using defaults):', error.message);
}

const requiredDirs = [
    { name: 'sessionDataPath', path: CONFIG.sessionDataPath },
    { name: 'mediaPath', path: CONFIG.mediaPath },
    { name: 'authPath', path: CONFIG.authPath }
];

for (const dir of requiredDirs) {
    try {
        if (!dir.path || typeof dir.path !== 'string') {
            throw new Error(`Invalid path for ${dir.name}: ${dir.path}`);
        }

        if (!fs.existsSync(dir.path)) {
            fs.mkdirSync(dir.path, { recursive: true });
            console.log(`Created directory: ${dir.path}`);
        }
    } catch (err) {
        console.error(`FATAL: Directory creation failed for ${dir.name}:`, err.message);
        process.exit(1);
    }
}

const SESSION_DIR = CONFIG.sessionDataPath;
const MEDIA_DIR = CONFIG.mediaPath;
const AUTH_DIR = CONFIG.authPath;
const COMMAND_PREFIX = CONFIG.prefix || process.env.COMMAND_PREFIX || '!';
const MAX_SESSIONS_DEFAULT = CONFIG.maxSessions || process.env.MAX_SESSIONS || 1000;

const mediaPath = {
    audio: path.join(MEDIA_DIR, 'audio.mp3'),
    document: path.join(MEDIA_DIR, 'document.pdf'),
    image: path.join(MEDIA_DIR, 'image.jpg')
};

const clients = new Map();
const userSessions = new Map();
const scheduledReminders = new Map();
let reminderCounter = 1;

const clientGroups = new Map(); 
const groupRefreshIntervals = new Map(); 
const senderAdminGroups = new Map();
const groupCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
// Add this after line 95 in bot.js
const userGroupSelections = new Map(); // Store user's selected groups

const clientConfig = {
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-web-security'
        ],
        defaultViewport: null
    },
    qrMaxRetries: 5,
    authTimeoutMs: 180000,
    restartOnAuthFail: true,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 10000,
    chatLoadingTimeoutMs: 60000
};

// Initialize authorized numbers
const authorizedNumbers = new Set();
if (CONFIG.owner) {
    let ownerNumber = CONFIG.owner;
    if (!ownerNumber.includes('@')) {
        ownerNumber = `${ownerNumber.replace(/[^0-9]/g, '')}@c.us`;
    }
    authorizedNumbers.add(ownerNumber);
    console.log(`Added owner number to authorized users: ${ownerNumber}`);
}

if (CONFIG.allowedUsers && Array.isArray(CONFIG.allowedUsers)) {
    for (const user of CONFIG.allowedUsers) {
        let userNumber = user;
        if (!userNumber.includes('@')) {
            userNumber = `${userNumber.replace(/[^0-9]/g, '')}@c.us`;
        }
        authorizedNumbers.add(userNumber);
    }
    console.log(`Added ${CONFIG.allowedUsers.length} additional authorized users`);
}

// Admin verification functions
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

const logger = {
    info: (message) => console.log(`[${new Date().toISOString()}] INFO: ${message}`),
    error: (message, error) => console.error(`[${new Date().toISOString()}] ERROR: ${message}`, error)
};

// Function to get groups where sender is admin
async function getGroupsWhereSenderIsAdmin(client, senderId) {
    try {
        logger.info(`🔍 Fetching groups where ${senderId} is admin`);
        
        const chats = await client.getChats();
        logger.info(`📦 Total chats retrieved: ${chats.length}`);
        
        const groupChats = chats.filter(chat => chat.isGroup);
        logger.info(`👥 Group chats found: ${groupChats.length}`);
        
        if (groupChats.length === 0) {
            logger.info(`❌ No group chats found at all`);
            return [];
        }

        const senderAdminGroupsList = [];
        let processedCount = 0;
        let foundAsAdmin = 0;

        const cleanSenderId = senderId.replace('@c.us', '');
        const fullSenderId = `${cleanSenderId}@c.us`;

        logger.info(`🔧 Normalized IDs - Clean: ${cleanSenderId}, Full: ${fullSenderId}`);

        for (const chat of groupChats) {
            try {
                processedCount++;
                logger.info(`🔄 Processing group ${processedCount}/${groupChats.length}: "${chat.name}"`);
                
                await chat.fetchParticipants();
                
                const senderParticipant = chat.participants.find(p => {
                    const participantId = p.id._serialized;
                    const participantUser = p.id.user;
                    
                 // Clean all numbers to just digits for comparison
const clean = n => (n || '').replace(/\D/g, '');
const senderDigits = clean(senderId);
const participantDigits = clean(participantId);

// Compare last 7 to 13 digits for a loose match
const matches =
    senderDigits && participantDigits &&
    (
        senderDigits === participantDigits ||
        participantDigits.endsWith(senderDigits) ||
        senderDigits.endsWith(participantDigits)
    );



                    
                    if (matches) {
                        logger.info(`✅ Found participant match: ${participantId} (Admin: ${p.isAdmin})`);
                    }
                    
                    return matches;
                });
                
                if (senderParticipant && senderParticipant.isAdmin) {
                    foundAsAdmin++;
                    senderAdminGroupsList.push(chat);
                    logger.info(`🎉 ADMIN GROUP FOUND: "${chat.name}"`);
                } else if (senderParticipant) {
                    logger.info(`👤 Found in "${chat.name}" but not admin`);
                } else {
                    logger.info(`❌ Not found in "${chat.name}"`);
                }
                
            } catch (err) {
                logger.error(`⚠️ Error processing group "${chat.name}":`, err.message);
            }
        }

        logger.info(`✅ Final result: ${foundAsAdmin} admin groups found out of ${groupChats.length} total groups`);
        return senderAdminGroupsList;
        
    } catch (error) {
        logger.error('❌ Critical error in getGroupsWhereSenderIsAdmin:', error);
        return [];
    }
}

function createNewSession() {
    try {
        const sessionId = Date.now().toString();
        if (clients.has(sessionId)) {
            logger.info(`Session ${sessionId} already exists`);
            return sessionId;
        }
        const client = createClient(sessionId);
        clients.set(sessionId, client);
        client.initialize().catch(err => {
            logger.error(`Failed to initialize client ${sessionId}:`, err);
            clients.delete(sessionId);
        });
        return sessionId;
    } catch (error) {
        logger.error('Failed to create new session:', error);
    }
}

// Initialize saved contacts
const SAVED_CONTACTS_FILE = path.join(SESSION_DIR, 'saved_contacts.json');
const savedContacts = new Set(
    fs.existsSync(SAVED_CONTACTS_FILE) 
        ? JSON.parse(fs.readFileSync(SAVED_CONTACTS_FILE)) 
        : []
);

// Enhanced contact saving with email/phone notifications
async function saveNewContact(contact, client, adminId) {
    try {
        // Save contact to database (existing logic)
        const savedContact = {
            name: contact.pushname || 'Unknown',
            number: contact.id.user,
            savedAt: new Date(),
            adminId: adminId
        };
        
        // Save to your database here
        // await ContactModel.create(savedContact);
        
        // Send email notification
        await sendEmailNotification(adminId, savedContact);
        
        // Send SMS notification (optional)
        await sendSMSNotification(adminId, savedContact);
        
        // Notify admin via WhatsApp self-chat
        const selfChat = await client.getChatById(adminId);
        await selfChat.sendMessage(
            `📞 *New Contact Saved*\n\n` +
            `*Name:* ${savedContact.name}\n` +
            `*Number:* ${savedContact.number}\n` +
            `*Time:* ${savedContact.savedAt.toLocaleString()}`
        );
        
        return savedContact;
        
    } catch (error) {
        console.error('Error saving contact:', error);
        throw error;
    }
}

// Email notification function
async function sendEmailNotification(adminId, contact) {
    try {
        // You'll need to install nodemailer: npm install nodemailer
        const nodemailer = require('nodemailer');
        
        // Get admin email from database
        const adminUser = await User.findOne({ whatsappNumber: adminId });
        if (!adminUser || !adminUser.email) return;
        
        const transporter = nodemailer.createTransporter({
            // Configure your email service
            service: 'gmail', // or your email service
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });
        
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: adminUser.email,
            subject: 'New WhatsApp Contact Saved',
            html: `
                <h2>New Contact Saved</h2>
                <p><strong>Name:</strong> ${contact.name}</p>
                <p><strong>Number:</strong> ${contact.number}</p>
                <p><strong>Time:</strong> ${contact.savedAt.toLocaleString()}</p>
            `
        };
        
        await transporter.sendMail(mailOptions);
        console.log('Email notification sent to:', adminUser.email);
        
    } catch (error) {
        console.error('Error sending email notification:', error);
    }
}

// SMS notification function (optional)
async function sendSMSNotification(adminId, contact) {
    try {
        // You can use services like Twilio, Nexmo, etc.
        // This is a placeholder implementation
        console.log(`SMS notification would be sent for contact: ${contact.name}`);
        
    } catch (error) {
        console.error('Error sending SMS notification:', error);
    }
}
function setupCallHandlers(client) {
    client.on('call', async (call) => {
        try {
            if (!client.info) {
                logger.info('Ignoring call during authentication');
                return;
            }
            const caller = call.from;
            const isVideoCall = call.isVideo;
            logger.info(`Received ${isVideoCall ? 'video' : 'voice'} call from ${caller}`);
            
            const contact = await client.getContactById(caller);
            if (!contact.name || contact.name === contact.pushname || contact.name === caller.split('@')[0]) {
                const saved = await saveNewContact(client, caller, contact.pushname || null);
                if (saved) {
                    for (const adminNumber of authorizedNumbers) {
                        try {
                            const adminChat = await client.getChatById(adminNumber);
                            await adminChat.sendMessage(`📞 Automatically saved new contact:
*Number:* ${caller}
*Name:* ${contact.pushname || 'Unknown'}`);
                        } catch (err) {
                            logger.error('Failed to notify admin about new contact:', err);
                        }
                    }
                }
            }
        } catch (error) {
            logger.error('Error handling call event:', error);
        }
    });
}

async function refreshGroupsForSession(client, sessionId) {
    try {
        logger.info(`🔍 Running group refresh for ${sessionId}`);
        const meId = client.info.wid._serialized;
        logger.info(`🤖 Bot ID: ${meId}`);

        let retryCount = 0;
        let chats = [];
        while (retryCount < 3 && chats.length === 0) {
            try {
                chats = await client.getChats();
                logger.info(`📦 Retrieved ${chats.length} chats for session ${sessionId} (attempt ${retryCount + 1})`);
                if (chats.length === 0) {
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            } catch (err) {
                logger.error(`❌ Failed to get chats for session ${sessionId}:`, err);
            }
            retryCount++;
        }

        if (chats.length === 0) {
            logger.error(`❌ Failed to load chats after ${retryCount} attempts`);
            return;
        }

        const adminGroups = [];

        for (const c of chats) {
            if (!c.isGroup) continue;

            try {
                const fetchPromise = c.fetchParticipants();
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Fetch participants timeout')), 30000)
                );
                
                await Promise.race([fetchPromise, timeoutPromise]);
            } catch (err) {
                logger.error(`⚠️ Failed to fetch participants for group "${c.name}":`, err);
                continue;
            }

            const participant = c.participants.find(p => 
                p.id._serialized === meId || 
                p.id.user === meId.split('@')[0]
            );
            const isAdmin = participant?.isAdmin ?? false;

            logger.info(`👥 Group: "${c.name}" | Bot found: ${!!participant} | Admin: ${isAdmin} | Participants: ${c.participants.length}`);

            if (participant && isAdmin) {
                adminGroups.push(c);
            }
        }

        clientGroups.set(sessionId, adminGroups);
        logger.info(`✅ Refreshed groups for session ${sessionId}: ${adminGroups.length} admin groups`);
        return adminGroups;
    } catch (error) {
        logger.error(`❌ Group refresh failed for session ${sessionId}:`, error);
        return [];
    }
}

function createClient(sessionId) {
    const sessionFile = path.join(SESSION_DIR, `session-${sessionId}.json`);
    let sessionData = null;
    try {
        if (fs.existsSync(sessionFile)) {
            sessionData = JSON.parse(fs.readFileSync(sessionFile));
            logger.info(`Loaded session data for ${sessionId}`);
        }
    } catch (error) {
        logger.error(`Failed to load session ${sessionId}:`, error);
    }
    
    const client = new Client({ 
        session: sessionData,
        ...clientConfig
    });
    
    client.removeAllListeners('message');
    client.removeAllListeners('message_create');

    clientGroups.set(sessionId, []);

    setupClientEvents(client, sessionId);
    setupCallHandlers(client);
    return client;
}

function setupClientEvents(client, sessionId) {
    let qrRetryCount = 0;
    let keepAliveInterval;
    
    client.on('qr', (qr) => {
        logger.info(`QR Code received for session ${sessionId}`);
        qrcode.generate(qr, { small: true });
    });

    client.on('qr_timeout', () => {
        logger.error(`QR Code generation timed out for session ${sessionId} after ${clientConfig.qrMaxRetries} attempts`);
        logger.info(`Creating new session after QR timeout of ${sessionId}`);
        setTimeout(() => {
            createNewSession();
        }, 1000);
        clients.delete(sessionId);
    });

    client.on('authenticated', (session) => {
        logger.info(`Session ${sessionId} authenticated`);
        try {
            if (session) {
                const sessionFile = path.join(SESSION_DIR, `session-${sessionId}.json`);
                fs.writeFileSync(sessionFile, JSON.stringify(session));
                logger.info(`Session ${sessionId} data saved successfully`);
            }
        } catch (error) {
            logger.error(`Failed to save session data for ${sessionId}:`, error);
        }
    });
    
    client.on('ready', async () => {
        logger.info(`Client ${sessionId} is ready`);
        
        const checkAuthState = async (attempts = 3) => {
            try {
                const state = await client.getState();
                console.log("AUTH STATE CHECK:", { state, attempt: 4-attempts });
                
                if (state === 'CONNECTED') {
                    console.log("CLIENT FULLY AUTHENTICATED");
                    return true;
                }
                
                if (attempts <= 0) {
                    logger.error(`Failed to verify authentication after 3 attempts (state: ${state})`);
                    return false;
                }
                
                await new Promise(resolve => setTimeout(resolve, 5000));
                return checkAuthState(attempts - 1);
            } catch (error) {
                logger.error(`Error checking auth state: ${error.message}`);
                return false;
            }
        };

        const isAuthenticated = await checkAuthState();
        
        if (!isAuthenticated) {
            logger.error(`Client ${sessionId} not properly authenticated`);
            setTimeout(() => {
                client.destroy().then(() => {
                    clients.delete(sessionId);
                    createNewSession();
                });
            }, 5000);
            return;
        }

        logger.info(`⚙️ Attempting to refresh groups for session ${sessionId}...`);
        await refreshGroupsForSession(client, sessionId);
        logger.info(`✅ Finished group refresh call for session ${sessionId}`);

        groupRefreshIntervals.set(
            sessionId,
            setInterval(() => refreshGroupsForSession(client, sessionId), 600000)
        );

        try {
            const selfId = client.info.wid._serialized;
            const chat = await client.getChatById(selfId);
            
            const testMsg = await chat.sendMessage("Welcome, We are happy you joined us...");
            await testMsg.delete(true);
            
            userSessions.set(selfId, sessionId);
            
            await chat.sendMessage(`🤖 *Bot Connected*\n\nYour session ID: \`${sessionId}\``);
            await chat.sendMessage("👋 Hello, I'm a WhatsApp bot. Use !help to see available commands");    
            
            keepAliveInterval = setInterval(async () => {
                try {
                    await client.getState();
                    logger.info(`Keep-alive ping for session ${sessionId}`);
                } catch (error) {
                    logger.error(`Keep-alive failed for session ${sessionId}:`, error);
                }
            }, 300000);
        } catch (error) {
            logger.error('Ready handler failed:', error);
            setTimeout(() => {
                client.destroy().then(() => {
                    clients.delete(sessionId);
                    createNewSession();
                });
            }, 5000);
        }
    });
    
    client.on('disconnected', (reason) => {
        logger.info(`Client ${sessionId} disconnected: ${reason}`);
        if (keepAliveInterval) clearInterval(keepAliveInterval);
        if (groupRefreshIntervals.has(sessionId)) {
            clearInterval(groupRefreshIntervals.get(sessionId));
            groupRefreshIntervals.delete(sessionId);
        }
        clientGroups.delete(sessionId);
        
        const keysToDelete = [];
        for (const key of senderAdminGroups.keys()) {
            if (key.endsWith(`_${sessionId}`)) {
                keysToDelete.push(key);
            }
        }
        keysToDelete.forEach(key => senderAdminGroups.delete(key));
        
        clients.delete(sessionId);
        if (reason !== 'NAVIGATION' && reason !== 'LOGOUT') {
            setTimeout(() => createNewSession(), 10000);
        }
    });

    client.on('message', async (message) => {
        try {
            console.log("RAW MESSAGE RECEIVED:", {
                from: message.from,
                body: message.body,
                fromMe: message.fromMe,
                type: message.type
            });

            if (message.fromMe) {
                console.log("Skipping message from self");
                return;
            }

            if (!message.body || 
                message.from === 'status@broadcast' || 
                message.type === 'broadcast') {
                return;
            }

            if (!message.body.trim().startsWith(COMMAND_PREFIX)) {
                return;
            }
            
            console.log("CLIENT INFO:", {
                clientReady: client.info !== undefined,
                selfId: client.info?.wid?._serialized,
                sender: message.from
            });

            if (!client.info) {
                console.log("Client not fully initialized, skipping message");
                return;
            }

            const sender = message.from;
            const selfId = client.info.wid._serialized;
            
            console.log("COMMAND DETECTED:", {
                sender,
                selfId,
                body: message.body,
                isAuthorized: isAuthorized(sender)
            });

            if (sender === selfId) {
                // Process command normally
            } 
            else if (!isAuthorized(sender)) {
                console.log(`Unauthorized command from ${sender}`);
                return await message.reply("🔒 Admin-only command");
            }

            const [command, ...args] = message.body
                .slice(COMMAND_PREFIX.length)
                .trim()
                .split(/\s+/);
                
            console.log("PROCESSING COMMAND:", { 
                command: command.toLowerCase(), 
                args 
            });

            try {
                await message.react(isPrimaryAdmin(message.from) ? '👑' : '🔧');
            } catch (error) {
                console.error("Failed to react:", error);
            }

            switch (command.toLowerCase()) {
                case 'ping':
                    await message.reply('Pong! 🏓');
                    break;
                    
                case 'help':
                    await message.reply(`*Available Commands:*\n` +
                        '1. !ping - Pong\n' +
                        '2. !help - This help\n' +
                        '3. !list - Groups where you are admin\n' +
                        '4. !tagall [group numbers] - Mention all in your admin groups\n' +
                        '5. !tagallexcept [group numbers] [phone numbers] - Mention all except specified\n' +
                        '6. !document [type] - Send stored file\n' +
                        '7. !meeting [YYYY-MM-DD] [HH:mm] [title] - Schedule meeting\n' +
                        '8. !event [YYYY-MM-DD] [HH:mm] [title] - Schedule event\n' +
                        '9. !refreshgroups - Refresh group list\n' +
                        '10. !testchats - Debug chat retrieval\n' +
                        '11. !testparticipants - Debug participant detection\n' +
                        '12. !listraw - Raw admin detection test\n' +
                        '13. !listsimple - Simplified list test');
                    break;

                case 'testchats': {
                    try {
                        await message.reply('🔍 Testing chat retrieval...');
                        
                        const chats = await client.getChats();
                        const groups = chats.filter(c => c.isGroup);
                        
                        await message.reply(`📊 *Chat Stats:*
• Total chats: ${chats.length}
• Group chats: ${groups.length}
• First 3 groups: ${groups.slice(0, 3).map(g => g.name).join(', ')}`);
                        
                    } catch (error) {
                        await message.reply(`❌ Error getting chats: ${error.message}`);
                    }
                    break;
                }

                case 'testparticipants': {
                    try {
                        const chats = await client.getChats();
                        const firstGroup = chats.find(c => c.isGroup);
                        
                        if (!firstGroup) {
                            await message.reply('❌ No groups found');
                            break;
                        }
                        
                        await message.reply(`🔍 Testing participants in: "${firstGroup.name}"`);
                        
                        await firstGroup.fetchParticipants();
                        
                        const senderId = message.fromMe ? client.info.wid._serialized : message.from;
                        const participant = firstGroup.participants.find(p => 
                            p.id._serialized === senderId ||
                            p.id.user === senderId.replace('@c.us', '')
                        );
                        
                        await message.reply(`📊 *Participant Test:*
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
                }

                case 'listraw': {
                    try {
                        await message.reply('🔍 Raw list test...');
                        
                        const senderId = message.fromMe ? client.info.wid._serialized : message.from;
                        const chats = await client.getChats();
                        const groups = chats.filter(c => c.isGroup);
                        
                        let adminCount = 0;
                        let totalGroups = groups.length;
                        let errors = 0;
                        
                        for (const group of groups) {
                            try {
                                await group.fetchParticipants();
                                const participant = group.participants.find(p => 
                                    p.id._serialized === senderId ||
                                    p.id.user === senderId.replace('@c.us', '')
                                );
                                
                                if (participant && participant.isAdmin) {
                                    adminCount++;
                                    console.log(`✅ ADMIN IN: ${group.name}`);
                                }
                            } catch (err) {
                                errors++;
                                console.log(`❌ ERROR IN: ${group.name} - ${err.message}`);
                            }
                        }
                        
                        await message.reply(`📊 *Raw Results:*
• Total groups: ${totalGroups}
• Admin groups: ${adminCount}
• Errors: ${errors}
• Your ID: \`${senderId}\`

Check console for detailed logs.`);
                        
                    } catch (error) {
                        await message.reply(`❌ Raw test failed: ${error.message}`);
                    }
                    break;
                }

                case 'listsimple': {
                    try {
                        await message.reply('⏳ Simple list check...');
                        
                        const senderId = message.fromMe ? client.info.wid._serialized : message.from;
                        console.log(`🔍 Checking admin groups for: ${senderId}`);
                        
                        const chats = await client.getChats();
                        console.log(`📦 Got ${chats.length} total chats`);
                        
                        const groups = chats.filter(c => c.isGroup);
                        console.log(`👥 Found ${groups.length} groups`);
                        
                        if (groups.length === 0) {
                            await message.reply('❌ No groups found at all');
                            break;
                        }
                        
                        let adminGroups = [];
                        
                        for (let i = 0; i < Math.min(groups.length, 10); i++) {
                            const group = groups[i];
                            try {
                                console.log(`🔄 Checking group: ${group.name}`);
                                await group.fetchParticipants();
                                
                                const you = group.participants.find(p => 
                                    p.id._serialized.includes(senderId.replace('@c.us', '')) ||
                                    senderId.includes(p.id.user)
                                );
                                
                                if (you) {
                                    console.log(`✅ Found in ${group.name}, admin: ${you.isAdmin}`);
                                    if (you.isAdmin) {
                                        adminGroups.push(group);
                                    }
                                }
                            } catch (err) {
                                console.log(`❌ Error in ${group.name}: ${err.message}`);
                            }
                        }
                        
                        if (adminGroups.length > 0) {
                            const list = adminGroups.map((g, i) => `${i+1}. ${g.name}`).join('\n');
                            await message.reply(`✅ Found ${adminGroups.length} admin groups:\n\n${list}`);
                        } else {
                            await message.reply(`❌ No admin groups found in first ${Math.min(groups.length, 10)} groups`);
                        }
                        
                    } catch (error) {
                        console.error('Simple list error:', error);
                        await message.reply(`❌ Simple list failed: ${error.message}`);
                    }
                    break;
                }
                            
                              case 'list': {
                    try {
                        const chatId  = message.from;
                        const selfId  = client.info.wid._serialized;
                        const isGroup = chatId.endsWith('@g.us');
                        
                        const userId  = message.fromMe
                            ? selfId
                            : (isGroup
                                ? message.author
                                : message.from);

                        const isSelfChat = chatId === selfId;
                        const ownerNumber = CONFIG.owner
                          ? CONFIG.owner.replace(/[^0-9]/g, '') + '@c.us'
                          : null;
                          
                        const targetUser = (isSelfChat && ownerNumber)
                          ? ownerNumber
                          : userId;

                        await message.reply('⚡ Fetching your admin groups…');
                        const groups = await getGroupsWhereSenderIsAdmin(client, targetUser);
                        if (!groups.length) {
                          return message.reply('❌ You are not admin in any groups');
                        }

                        senderAdminGroups.set(`${targetUser}_${sessionId}`, groups);

                        const listText = groups
                          .map((g,i) => `${i+1}. ${g.name} (${g.participants?.length||0} members)`)
                          .join('\n');

                        return message.reply(
                          `*📋 Groups Where You Are Admin (${groups.length})*\n\n` +
                          listText +
                          `\n\n💡 Now use !tagall or !tagallexcept with those numbers.`
                        );
                    } catch (err) {
                        logger.error('Error in !list:', err);
                        return message.reply('❌ Oops, something went wrong fetching your groups.');
                    }
                    break;
                }
                          
                case 'info':
                    const chatInfo = await message.getChat();
                    let info = `*Chat Info:*\n- Is Group: ${chatInfo.isGroup}\n- Participants: ${chatInfo.isGroup ? chatInfo.participants.length : 'N/A'}\n- Name: ${chatInfo.name || 'N/A'}`;
                    
                    if (chatInfo.isGroup) {
                        info += `\n- Group Description: ${chatInfo.description || 'N/A'}`;
                    }
                    
                    await message.reply(info);
                    break;
                    
                case 'sessionid':
                    const clientId = client.info.wid._serialized;
                    const sessionIdFromMap = userSessions.get(clientId);
                    await message.reply(`Your session ID: ${sessionIdFromMap}`);
                    break;
                    
                case 'media':
                    if (fs.existsSync(mediaPath.image)) {
                        const media = MessageMedia.fromFilePath(mediaPath.image);
                        await message.reply(media);
                    } else {
                        await message.reply('No test image found');
                    }
                    break;
                    
                case 'status':
                    const status = `*Bot Status:*\n- Uptime: ${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m\n- Active sessions: ${clients.size}\n- Memory usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`;
                    await message.reply(status);
                    break;
                    
                case 'newsession':
                    const newSessionId = createNewSession();
                    await message.reply(`New session created with ID: ${newSessionId}`);
                    break;
                    
                case 'shutdown':
                    await handleShutdown(message);
                    break;
                    
                case 'sudo':
                    await handleSudoCommand(message, args, client);
                    break;
                    
                case 'document':
                    await sendDocument(message);
                    break;
                    
                case 'savecontact':
                    if (args.length < 1) {
                        await message.reply('Usage: !savecontact [phone number] [optional name]');
                        return;
                    }
                    const phoneNumber = args[0];
                    const contactName = args.length > 1 ? args.slice(1).join(' ') : null;
                    const saved = await saveNewContact(client, phoneNumber, contactName);
                    await message.reply(saved ? '✅ Contact saved successfully' : '❌ Failed to save contact');
                    break;
                    
                case 'contacts':
                    const contactsList = [...savedContacts].join('\n');
                    await message.reply(`*Saved Contacts:*\n${contactsList || 'No contacts saved'}`);
                    break;
                    
                case 'tagall':
                    await handleGroupTagCommand(message, args, client, sessionId);
                    break;

                case 'tagallexcept':
                    await handleGroupTagExceptCommand(message, args, client, sessionId);
                    break;
                    
                case 'meeting':
                    await handleMeetingCommand(message, args, client);
                    break;
                    
                case 'event':
                    await handleEventCommand(message, args, client);
                    break;
                    
                case 'reminders':
                    await listReminders(message, client);
                    break;
                    
                case 'cancelreminder':
                    await cancelReminder(message, args);
                    break;

                case 'refreshgroups':
                    await message.reply('🔄 Refreshing your admin groups...');
                    const senderKey = `${message.from}_${sessionId}`;
                    const refreshedGroups = await getGroupsWhereSenderIsAdmin(client, message.from);
                    senderAdminGroups.set(senderKey, refreshedGroups);
                    await message.reply(`✅ Refreshed: Found ${refreshedGroups.length} groups where you are admin`);
                    break;
                    
                default:
                    await message.reply('Unknown command. Try !help');
            }
        } catch (error) {
            console.error("Message handler error:", error);
        }
    });

    client.on('message_create', async (message) => {
        console.log("MESSAGE CREATE EVENT:", {
            from: message.from,
            to: message.to,
            body: message.body,
            fromMe: message.fromMe
        });
        
        if (!client.info) {
            console.log("Client not ready in message_create, skipping");
            return;
        }

        const selfId = client.info.wid._serialized;
        
        if (!message.fromMe || message.to !== selfId) {
            console.log(`Not a self-chat command (fromMe: ${message.fromMe}, to: ${message.to}, self: ${selfId}), skipping`);
            return;
        }
        
        if (!message.body || !message.body.trim().startsWith(COMMAND_PREFIX)) {
            console.log("No command prefix in message_create, skipping");
            return;
        }
        
        console.log("Processing self-chat command in message_create");
        
        const [command, ...args] = message.body
            .slice(COMMAND_PREFIX.length)
            .trim()
            .split(/\s+/);
        
        try {
            await message.react('🤖');
        } catch (error) {
            console.error("Failed to react:", error);
        }

        switch (command.toLowerCase()) {
            case 'ping':
                return message.reply('Pong! 🏓');
                
            case 'help':
                return message.reply(`*Available Commands:*
1. !ping - Check bot response
2. !help - Show this help
3. !status - Show bot status
4. !list - List groups where you are admin
5. !tagall [group numbers] - Mention all group members
6. !tagallexcept [group numbers] [phone numbers] - Mention all except specified
7. !refreshgroups - Refresh groups you are admin of
8. !sessionid - Get your session ID
9. !media - Send test media
10. !newsession - Create new session
11. !shutdown - Turn off bot (admin only)
12. !sudo - Admin commands
13. !document - Send document
14. !savecontact - Save a new contact
15. !contacts - List all saved contacts
16. !meeting - Schedule a meeting with reminders
17. !event - Schedule an event with reminders
18. !reminders - List all active reminders
19. !cancelreminder - Cancel a scheduled reminder
20. !testchats - Debug chat retrieval
21. !testparticipants - Debug participant detection
22. !listraw - Raw admin detection test
23. !listsimple - Simplified list test`);

            case 'testchats': {
                try {
                    await message.reply('🔍 Testing chat retrieval...');
                    
                    const chats = await client.getChats();
                    const groups = chats.filter(c => c.isGroup);
                    
                    await message.reply(`📊 *Chat Stats:*
• Total chats: ${chats.length}
• Group chats: ${groups.length}
• First 3 groups: ${groups.slice(0, 3).map(g => g.name).join(', ')}`);
                    
                } catch (error) {
                    await message.reply(`❌ Error getting chats: ${error.message}`);
                }
                break;
            }

            case 'testparticipants': {
                try {
                    const chats = await client.getChats();
                    const firstGroup = chats.find(c => c.isGroup);
                    
                    if (!firstGroup) {
                        await message.reply('❌ No groups found');
                        break;
                    }
                    
                    await message.reply(`🔍 Testing participants in: "${firstGroup.name}"`);
                    
                    await firstGroup.fetchParticipants();
                    
                    const senderId = selfId;
                    const participant = firstGroup.participants.find(p => 
                        p.id._serialized === senderId ||
                        p.id.user === senderId.replace('@c.us', '')
                    );
                    
                    await message.reply(`📊 *Participant Test:*
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
            }

            case 'listraw': {
                try {
                    await message.reply('🔍 Raw list test...');
                    
                    const senderId = selfId;
                    const chats = await client.getChats();
                    const groups = chats.filter(c => c.isGroup);
                    
                    let adminCount = 0;
                    let totalGroups = groups.length;
                    let errors = 0;
                    
                    for (const group of groups) {
                        try {
                            await group.fetchParticipants();
                            const participant = group.participants.find(p => 
                                p.id._serialized === senderId ||
                                p.id.user === senderId.replace('@c.us', '')
                            );
                            
                            if (participant && participant.isAdmin) {
                                adminCount++;
                                console.log(`✅ ADMIN IN: ${group.name}`);
                            }
                        } catch (err) {
                            errors++;
                            console.log(`❌ ERROR IN: ${group.name} - ${err.message}`);
                        }
                    }
                    
                    await message.reply(`📊 *Raw Results:*
• Total groups: ${totalGroups}
• Admin groups: ${adminCount}
• Errors: ${errors}
• Your ID: \`${senderId}\`

Check console for detailed logs.`);
                    
                } catch (error) {
                    await message.reply(`❌ Raw test failed: ${error.message}`);
                }
                break;
            }

            case 'listsimple': {
                try {
                    await message.reply('⏳ Simple list check...');
                    
                    const senderId = selfId;
                    console.log(`🔍 Checking admin groups for: ${senderId}`);
                    
                    const chats = await client.getChats();
                    console.log(`📦 Got ${chats.length} total chats`);
                    
                    const groups = chats.filter(c => c.isGroup);
                    console.log(`👥 Found ${groups.length} groups`);
                    
                    if (groups.length === 0) {
                        await message.reply('❌ No groups found at all');
                        break;
                    }
                    
                    let adminGroups = [];
                    
                    for (let i = 0; i < Math.min(groups.length, 10); i++) {
                        const group = groups[i];
                        try {
                            console.log(`🔄 Checking group: ${group.name}`);
                            await group.fetchParticipants();
                            
                            const you = group.participants.find(p => 
                                p.id._serialized.includes(senderId.replace('@c.us', '')) ||
                                senderId.includes(p.id.user)
                            );
                            
                            if (you) {
                                console.log(`✅ Found in ${group.name}, admin: ${you.isAdmin}`);
                                if (you.isAdmin) {
                                    adminGroups.push(group);
                                }
                            }
                        } catch (err) {
                            console.log(`❌ Error in ${group.name}: ${err.message}`);
                        }
                    }
                    
                    if (adminGroups.length > 0) {
                        const list = adminGroups.map((g, i) => `${i+1}. ${g.name}`).join('\n');
                        await message.reply(`✅ Found ${adminGroups.length} admin groups:\n\n${list}`);
                    } else {
                        await message.reply(`❌ No admin groups found in first ${Math.min(groups.length, 10)} groups`);
                    }
                    
                } catch (error) {
                    console.error('Simple list error:', error);
                    await message.reply(`❌ Simple list failed: ${error.message}`);
                }
                break;
            }
               
                                case 'list': {
                        try {
                            console.log("🔍 Processing !list command in message_create");
                            console.log("🔍 Self ID:", selfId);
                            console.log("🆔 Session ID:", sessionId);
                            
                            await message.reply('⏳ Fetching groups where you are admin...');
                            
                            const userAdminGroups = await getGroupsWhereSenderIsAdmin(client, selfId);
                            
                            if (!userAdminGroups.length) {
                                await message.reply('❌ You are not an admin in any groups');
                                break;
                            }
                            
                            // Store groups for this user with enhanced numbering
                            userGroupSelections.set(selfId, userAdminGroups);
                            
                            let listText = '';
                            userAdminGroups.forEach((group, index) => {
                                listText += `${index + 1}. ${group.name || 'Unnamed Group'} (${group.participants?.length || 0} members)\n`;
                            });
                            
                            await message.reply(`*📋 Groups Where You Are Admin (${userAdminGroups.length})*\n\n${listText}\n\n💡 Use these numbers with commands:\n• !tagall [number] [message]\n• !tagallexcept [number] [message]\n• !selectgroup [number] - Set default group`);
                        } catch (error) {
                            console.error('Error in !list command:', error);
                            await message.reply('❌ Error fetching groups');
                        }
                        break;
                    }
            
            case 'status':
                const statusMsg = `*Bot Status:*
- Uptime: ${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m
- Active sessions: ${clients.size}
- Memory usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`;
                return message.reply(statusMsg);
                
            case 'refreshgroups':
                await message.reply('🔄 Refreshing your admin groups...');
                const senderKey = `${selfId}_${sessionId}`;
                const refreshedGroups = await getGroupsWhereSenderIsAdmin(client, selfId);
                senderAdminGroups.set(senderKey, refreshedGroups);
                await message.reply(`✅ Refreshed: Found ${refreshedGroups.length} groups where you are admin`);
                break;
                
                            case 'tagall': {
                    try {
                        if (args.length < 2) {
                            return message.reply('❌ Usage: !tagall [group_number] [message]\nUse !list to see group numbers');
                        }
                        
                        const groupNumber = parseInt(args[0]);
                        const tagMessage = args.slice(1).join(' ');
                        
                        const userGroups = userGroupSelections.get(selfId);
                        if (!userGroups || groupNumber < 1 || groupNumber > userGroups.length) {
                            return message.reply('❌ Invalid group number. Use !list to see available groups');
                        }
                        
                        const selectedGroup = userGroups[groupNumber - 1];
                        await executeTagAllInGroup(client, selectedGroup.id, tagMessage, selfId);
                        
                        await message.reply(`✅ Tagged all members in "${selectedGroup.name}"`);
                    } catch (error) {
                        console.error('Error in !tagall command:', error);
                        await message.reply('❌ Error executing tagall command');
                    }
                    break;
                }

                                case 'tagallexcept': {
                        try {
                            if (args.length < 2) {
                                return message.reply('❌ Usage: !tagallexcept [group_number] [message]\nUse !list to see group numbers');
                            }
                            
                            const groupNumber = parseInt(args[0]);
                            const tagMessage = args.slice(1).join(' ');
                            
                            const userGroups = userGroupSelections.get(selfId);
                            if (!userGroups || groupNumber < 1 || groupNumber > userGroups.length) {
                                return message.reply('❌ Invalid group number. Use !list to see available groups');
                            }
                            
                            const selectedGroup = userGroups[groupNumber - 1];
                            await executeTagAllExceptInGroup(client, selectedGroup.id, tagMessage, selfId);
                            
                            await message.reply(`✅ Tagged members (except specified) in "${selectedGroup.name}"`);
                        } catch (error) {
                            console.error('Error in !tagallexcept command:', error);
                            await message.reply('❌ Error executing tagallexcept command');
                        }
                        break;
                    }

                        case 'selectgroup': {
                            try {
                                if (args.length < 1) {
                                    return message.reply('❌ Usage: !selectgroup [group_number]\nUse !list to see group numbers');
                                }
                                
                                const groupNumber = parseInt(args[0]);
                                const userGroups = userGroupSelections.get(selfId);
                                
                                if (!userGroups || groupNumber < 1 || groupNumber > userGroups.length) {
                                    return message.reply('❌ Invalid group number. Use !list to see available groups');
                                }
                                
                                const selectedGroup = userGroups[groupNumber - 1];
                                
                                // Store default group selection
                                const userDefaults = userGroupSelections.get(`${selfId}_default`) || {};
                                userDefaults.selectedGroup = selectedGroup;
                                userGroupSelections.set(`${selfId}_default`, userDefaults);
                                
                                await message.reply(`✅ Default group set to: "${selectedGroup.name}"\nNow you can use !tagall [message] without specifying group number`);
                            } catch (error) {
                                console.error('Error in !selectgroup command:', error);
                                await message.reply('❌ Error selecting group');
                            }
                            break;
                        }

                
            case 'sessionid':
                const sessionIdFromMap = userSessions.get(selfId);
                await message.reply(`Your session ID: ${sessionIdFromMap}`);
                break;
                
            default:
                return message.reply('Unknown command. Try !help');
        }
    });

    client.on('group_join', async (notification) => {
        try {
            logger.info(`📥 User joined group: ${notification.chatId}`);
            
            const selfId = client.info.wid._serialized;
            const senderKey = `${selfId}_${sessionId}`;
            senderAdminGroups.delete(senderKey);
            
            const chat = await client.getChatById(notification.chatId);
            if (chat.isGroup) {
                await chat.fetchParticipants();
                const userParticipant = chat.participants.find(p => 
                    p.id._serialized === selfId
                );
                
                if (userParticipant && userParticipant.isAdmin) {
                    logger.info(`🎉 Auto-detected: User is admin in new group "${chat.name}"`);
                    
                    const selfChat = await client.getChatById(selfId);
                    await selfChat.sendMessage(`🎉 You're now admin in: "${chat.name}"\nUse !list to see updated admin groups`);
                }
            }
        } catch (error) {
            logger.error('Error handling group_join:', error);
        }
    });

    client.on('group_admin_changed', async (notification) => {
        try {
            const selfId = client.info.wid._serialized;
            
            if (notification.recipients.includes(selfId)) {
                logger.info(`👑 Admin status changed for user in group: ${notification.chatId}`);
                
                const senderKey = `${selfId}_${sessionId}`;
                senderAdminGroups.delete(senderKey);
                
                const selfChat = await client.getChatById(selfId);
                const chat = await client.getChatById(notification.chatId);
                
                await selfChat.sendMessage(`👑 Your admin status changed in: "${chat.name}"\nUse !list to see updated admin groups`);
            }
        } catch (error) {
            logger.error('Error handling group_admin_changed:', error);
        }
    });

    client.on('auth_failure', (error) => {
        logger.error(`Authentication failed for session ${sessionId}:`, error);
        const sessionFile = path.join(SESSION_DIR, `session-${sessionId}.json`);
        if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
        clients.delete(sessionId);
    });
}

let isShuttingDown = false;
    
process.on('uncaughtException', (err) => logger.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason, promise) => logger.error('Unhandled Rejection at:', promise, 'reason:', reason));
    
process.on('SIGTERM', () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    
    logger.info('SIGTERM received, shutting down...');
    for (const client of clients.values()) {
        try {
            client.destroy();
        } catch (error) {
            logger.error('Error during client shutdown:', error);
        }
    }
    process.exit(0);
});
    
process.on('SIGINT', () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    
    logger.info('SIGINT received, shutting down...');
    for (const client of clients.values()) {
        try {
            client.destroy();
        } catch (error) {
            logger.error('Error during client shutdown:', error);
        }
    }
    process.exit(0);
});
    
process.on('exit', () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    
    logger.info('Exit event received, shutting down...');
    for (const client of clients.values()) {
        try {
            client.destroy();
        } catch (error) {
            logger.error('Error during client shutdown:', error);
        }
    }
});
    
process.on('SIGHUP', () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    
    logger.info('SIGHUP received, shutting down...');
    for (const client of clients.values()) {
        try {
            client.destroy();
        } catch (error) {
            logger.error('Error during client shutdown:', error);
        }
    }
    process.exit(0);
});
    
const handleShutdown = async (message) => {
    await message.reply('🔄 Shutting down bot...');
    logger.info('Shutdown initiated by admin');
    
    for (const client of clients.values()) {
        try {
            await client.destroy();
        } catch (error) {
            logger.error('Error during client shutdown:', error);
        }
    }
    
    await message.reply('✅ Shutdown complete. Bot is now offline.');
    process.exit(0);
};
    
const handleSudoCommand = async (message, args, client) => {
    if (!isAuthorized(message.from)) {
        await message.reply('🚫 You are not authorized to use sudo commands');
        return;
    }

    if (!args.length) {
        await message.reply(`*Sudo Commands:*\n!sudo stats - Show detailed system stats\n!sudo list - List all active sessions\n!sudo clearsessions - Clear inactive sessions\n!sudo broadcast [message] - Send message to all chats`);
        return;
    }

    const subCommand = args[0];
    
    switch (subCommand) {
        case 'stats':
            const memUsage = process.memoryUsage();
            const stats = `*System Statistics:*\n- Heap Used: ${Math.round(memUsage.heapUsed / 1024 / 1024)} MB\n- Heap Total: ${Math.round(memUsage.heapTotal / 1024 / 1024)} MB\n- RSS: ${Math.round(memUsage.rss / 1024 / 1024)} MB\n- Active Sessions: ${clients.size}\n- Uptime: ${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m`;
            await message.reply(stats);
            break;
            
        case 'list': {
            try {
                const chatId  = message.from;
                const selfId  = client.info.wid._serialized;
                const isGroup = chatId.endsWith('@g.us');
                
                const userId  = message.fromMe
                    ? selfId
                    : (isGroup
                        ? message.author
                        : message.from);

                const isSelfChat = chatId === selfId;
                const ownerNumber = CONFIG.owner
                  ? CONFIG.owner.replace(/[^0-9]/g, '') + '@c.us'
                  : null;
                  
                const targetUser = (isSelfChat && ownerNumber)
                  ? ownerNumber
                  : userId;

                await message.reply('⚡ Fetching your admin groups…');
                const groups = await getGroupsWhereSenderIsAdmin(client, targetUser);
                
                if (!groups.length) {
                  return message.reply('❌ You are not admin in any groups');
                }

                const sessionId = userSessions.get(selfId);
                senderAdminGroups.set(`${targetUser}_${sessionId}`, groups);

                const listText = groups
                  .map((g,i) => `${i+1}. ${g.name} (${g.participants?.length||0} members)`)
                  .join('\n');

                return message.reply(
                  `*📋 Groups Where You Are Admin (${groups.length})*\n\n` +
                  listText +
                  `\n\n💡 Now use !tagall or !tagallexcept with those numbers.`
                );
            } catch (err) {
                logger.error('Error in sudo list:', err);
                return message.reply('❌ Oops, something went wrong fetching your groups.');
            }
            break;
        }
            
        case 'clearsessions':
            const sessionDir = fs.readdirSync(SESSION_DIR);
            let removed = 0;
            
            for (const file of sessionDir) {
                const sessionId = file.replace('session-', '').replace('.json', '');
                if (!clients.has(sessionId)) {
                    fs.unlinkSync(path.join(SESSION_DIR, file));
                    removed++;
                }
            }
            
            await message.reply(`✅ Cleared ${removed} inactive session files`);
            break;
            
        case 'broadcast':
            const broadcastMsg = args.slice(1).join(' ');
            if (!broadcastMsg) {
                await message.reply('Please provide a message to broadcast');
                return;
            }
            
            let sent = 0;
            for (const client of clients.values()) {
                try {
                    const chats = await client.getChats();
                    for (const chat of chats) {
                        await chat.sendMessage(`*BROADCAST*\n\n${broadcastMsg}`);
                        sent++;
                    }
                } catch (error) {
                    logger.error('Broadcast error:', error);
                }
            }
            
            await message.reply(`✅ Broadcast sent to ${sent} chats`);
            break;
            
        default:
            await message.reply('Unknown sudo command. Use !sudo for help.');
    }
};
    
const handleGroupCommand = async (message, callback) => {
    try {
        const chat = await message.getChat();
        
        if (!chat.isGroup) {
            await message.reply('This command can only be used in groups');
            return;
        }
        
        await callback(chat);
    } catch (error) {
        logger.error('Group command error:', error);
        await message.reply('An error occurred while processing the group command');
    }
};
    
const sendDocument = async (message) => {
    try {
        if (!fs.existsSync(mediaPath.document)) {
            await message.reply(`Document not found at ${mediaPath.document}`);
            return;
        }
        
        const document = MessageMedia.fromFilePath(mediaPath.document);
        await message.reply(document, undefined, { 
            caption: 'Here is your requested document',
            sendMediaAsDocument: true 
        });
        
        logger.info(`Document sent to ${message.from}`);
    } catch (error) {
        logger.error('Error sending document:', error);
        await message.reply('Failed to send document');
    }
};

const handleGroupTagCommand = async (message, args, client, sessionId) => {
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
                } catch (error) {
                    logger.error(`Error tagging in group ${group.name}:`, error);
                                        await message.reply(`❌ Failed to tag in "${group.name}"`);
                }
            } else {
                await message.reply(`❌ Invalid group number: ${index + 1}`);
            }
        }
        
        if (successCount > 0) {
            await message.reply(`✅ Successfully tagged members in ${successCount} group(s)`);
        }
    } catch (error) {
        logger.error('Error in tagall command:', error);
        await message.reply('❌ Failed to tag members');
    }
};

const handleGroupTagExceptCommand = async (message, args, client, sessionId) => {
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
            if (!isNaN(arg) && parseInt(arg) > 0) {
                groupIndices.push(parseInt(arg) - 1);
            } else {
                let cleanNumber = arg.replace(/[^0-9]/g, '');
                if (cleanNumber) {
                    exceptNumbers.push(`${cleanNumber}@c.us`);
                }
            }
        }

        if (groupIndices.length === 0) {
            await message.reply('❌ Please specify at least one valid group number');
            return;
        }

        if (exceptNumbers.length === 0) {
            await message.reply('❌ Please specify at least one phone number to exclude');
            return;
        }

        let successCount = 0;
        let totalExcluded = 0;

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
                    totalExcluded += excludedInThisGroup;
                    
                } catch (error) {
                    logger.error(`Error tagging in group ${group.name}:`, error);
                    await message.reply(`❌ Failed to tag in "${group.name}": ${error.message}`);
                }
            } else {
                await message.reply(`❌ Invalid group number: ${index + 1}. Use !list to see available groups.`);
            }
        }
        
        if (successCount > 0) {
            await message.reply(`✅ Successfully tagged members in ${successCount} group(s)\n📊 Total excluded: ${totalExcluded} members\n📱 Excluded numbers: ${exceptNumbers.length}`);
        } else {
            await message.reply('❌ No groups were successfully tagged');
        }
        
    } catch (error) {
        logger.error('Error in tagallexcept command:', error);
        await message.reply('❌ Failed to tag members. Please try again.');
    }
};

const handleMeetingCommand = async (message, args, client) => {
    await message.reply("📅 Meeting command received. Feature under construction.");
};

const handleEventCommand = async (message, args, client) => {
    await message.reply("🎉 Event command received. Feature under construction.");
};

const sendAdvanceNotification = async (reminder, client, timeFrame) => {
    console.log("🔔 Sending advance notification for", reminder, "Timeframe:", timeFrame);
};

const sendReminderNotification = async (reminder, client) => {
    console.log("🔔 Sending final reminder for", reminder);
};

const listReminders = async (message, client) => {
    await message.reply("📋 Listing reminders is currently under development.");
};

const cancelReminder = async (message, args) => {
    await message.reply("❌ Cancel reminder functionality is not ready yet.");
};

// Start up to 1000 sessions (configurable)
let MAX_SESSIONS = MAX_SESSIONS_DEFAULT;
let current = 0;
const createMultipleSessions = () => {
    if (current >= MAX_SESSIONS) return;
    if (clients.size >= 5) {
        logger.info(`Already have ${clients.size} active sessions. Waiting before creating more.`);
        setTimeout(createMultipleSessions, 60000);
        return;
    }
    createNewSession();
    current++;
    setTimeout(createMultipleSessions, 30000);
};

module.exports = {
    start: (maxSessions = MAX_SESSIONS_DEFAULT) => {
        MAX_SESSIONS = maxSessions;
        createMultipleSessions();
    },
    createNewSession,
    clients
};

// Auto-start the bot if this file is run directly
if (require.main === module) {
    console.log('🚀 Starting WhatsApp Bot...');
    
    // Create a basic config.json if it doesn't exist
    const configPath = path.join(__dirname, 'config.json');
    if (!fs.existsSync(configPath)) {
        const defaultConfig = {
            "owner": "your_phone_number_here",
            "prefix": "!",
            "maxSessions": 1,
            "allowedUsers": []
        };
        fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
        console.log('📝 Created default config.json - Please edit it with your phone number');
        console.log('⚠️  Please update config.json with your phone number before running the bot');
        process.exit(1);
    }

    // Enhanced command handler with usage limits
    async function handleCommand(message, client, sessionId, userId) {
    const commandText = message.body.toLowerCase();
    const command = commandText.split(' ')[0];
    const args = commandText.split(' ').slice(1);

    try {
        // Check usage limits before processing command
        const limitCheck = await checkUsageLimits(userId, 'use_command', { command: command.substring(1) });
        
        if (!limitCheck.canProceed) {
            await message.reply(`❌ ${limitCheck.reason}\n\n🚀 Upgrade your plan at: ${process.env.DOMAIN}/pricing`);
            return;
        }

        // Check message limits
        const messageLimitCheck = await checkUsageLimits(userId, 'send_message');
        if (!messageLimitCheck.canProceed) {
            await message.reply(`📊 ${messageLimitCheck.reason}\n\n💎 Upgrade now: ${process.env.DOMAIN}/pricing`);
            return;
        }

        // Track usage
        await trackUsage(userId, 'command_used', sessionId, command.substring(1));
        await trackUsage(userId, 'message_sent', sessionId);

        // Process the command
        switch(command) {
            case '!help':
                await handleHelpCommand(message, userId);
                break;
            case '!tagall':
                await handleTagAllCommand(message, args, client, userId);
                break;
            case '!status':
                await handleStatusCommand(message, userId);
                break;
            // ... other commands
            default:
                await message.reply('❓ Unknown command. Type !help for available commands.');
        }

    } catch (error) {
        console.error('Command handling error:', error);
        await message.reply('⚠️ An error occurred while processing your command.');
    }
}}

// Enhanced help command showing available features
async function handleHelpCommand(message, userId) {
    const user = await User.findById(userId).populate('subscription');
    const plan = subscriptionPlans[user.subscription?.planType || 'free'];
    const usage = await getTodayUsage(userId);

    let helpMessage = `🤖 *TagThemAll Bot Help*\n\n`;
    helpMessage += `📋 *Your Plan:* ${plan.name}\n`;
    helpMessage += `📊 *Today's Usage:*\n`;
    helpMessage += `   • Messages: ${usage.messagesCount}/${plan.maxMessagesPerDay === -1 ? '∞' : plan.maxMessagesPerDay}\n`;
    helpMessage += `   • Sessions: ${usage.sessionsActive}/${plan.maxSessions === -1 ? '∞' : plan.maxSessions}\n\n`;

    helpMessage += `✅ *Available Commands:*\n`;
    
    // Show commands based on plan
    if (plan.allowedCommands.includes('*') || plan.allowedCommands.includes('ping')) {
        helpMessage += `• !ping - Test bot response\n`;
    }
    if (plan.allowedCommands.includes('*') || plan.allowedCommands.includes('status')) {
        helpMessage += `• !status - Check bot status\n`;
    }
    if (plan.allowedCommands.includes('*') || plan.allowedCommands.includes('tagall')) {
        helpMessage += `• !tagall [message] - Tag all group members\n`;
    }
    if (plan.allowedCommands.includes('*') || plan.allowedCommands.includes('broadcast')) {
        helpMessage += `• !broadcast [message] - Send to all groups\n`;
    }

    // Show locked features for upgrade encouragement
    if (!plan.allowedCommands.includes('*')) {
        helpMessage += `\n🔒 *Upgrade to unlock:*\n`;
        if (!plan.allowedCommands.includes('tagall')) {
            helpMessage += `• !tagall - Group tagging (Basic+)\n`;
        }
        if (!plan.allowedCommands.includes('scheduler')) {
            helpMessage += `• !reminder - Set reminders (Premium+)\n`;
        }
        if (!plan.allowedCommands.includes('analytics')) {
            helpMessage += `• !analytics - View statistics (Premium+)\n`;
        }
        helpMessage += `\n💎 Upgrade at: ${process.env.DOMAIN}/pricing`;
    }

    await message.reply(helpMessage);
}

// Usage limit warning system
async function sendUsageWarnings(userId) {
    const usage = await getTodayUsage(userId);
    const user = await User.findById(userId).populate('subscription');
    const plan = subscriptionPlans[user.subscription?.planType || 'free'];

    // Check if approaching limits
    const messagePercentage = (usage.messagesCount / plan.maxMessagesPerDay) * 100;
    
    if (messagePercentage >= 80 && messagePercentage < 90) {
        // Send 80% warning
        await sendWarningMessage(userId, 'messages', 80, plan.maxMessagesPerDay - usage.messagesCount);
    } else if (messagePercentage >= 90 && messagePercentage < 100) {
        // Send 90% warning
        await sendWarningMessage(userId, 'messages', 90, plan.maxMessagesPerDay - usage.messagesCount);
    }
}

async function sendWarningMessage(userId, type, percentage, remaining) {
    const sessions = await Session.find({ userId: userId, status: 'active' });
    
    const warningMessage = `⚠️ *Usage Warning*\n\n` +
        `You've used ${percentage}% of your daily ${type} limit.\n` +
        `${remaining} ${type} remaining today.\n\n` +
        `💎 Upgrade for unlimited usage: ${process.env.DOMAIN}/pricing`;

    // Send warning to all active sessions
    for (const session of sessions) {
        const client = activeClients.get(session.sessionId);
        if (client) {
            try {
                await client.sendMessage(session.phoneNumber + '@c.us', warningMessage);
            } catch (error) {
                console.error('Warning message send error:', error);
            }
        }
    }
}


// Helper function to execute tagall in specific group
async function executeTagAllInGroup(client, groupId, message, adminId) {
    try {
        const chat = await client.getChatById(groupId);
        await chat.fetchParticipants();
        
        const mentions = [];
        let mentionText = `${message}\n\n`;
        
        for (const participant of chat.participants) {
            if (participant.id._serialized !== adminId) {
                mentions.push(participant.id._serialized);
                mentionText += `@${participant.id.user} `;
            }
        }
        
        await chat.sendMessage(mentionText, { mentions });
        
        // Update usage statistics
        await updateUsageStats(adminId, 'groupsTagged');
        
    } catch (error) {
        console.error('Error executing tagall in group:', error);
        throw error;
    }
}



// Helper function to update usage statistics
async function updateUsageStats(userId, statType) {
    try {
        // This would connect to your database to update stats
        // Implementation depends on your database structure
        console.log(`Updated ${statType} for user ${userId}`);
    } catch (error) {
        console.error('Error updating usage stats:', error);
    }
}



// Helper function to execute tagallexcept in specific group
async function executeTagAllExceptInGroup(client, groupId, message, adminId, exceptUsers = []) {
    try {
        const chat = await client.getChatById(groupId);
        await chat.fetchParticipants();
        
        const mentions = [];
        let mentionText = `${message}\n\n`;
        
        for (const participant of chat.participants) {
            const userId = participant.id._serialized;
            if (userId !== adminId && !exceptUsers.includes(userId)) {
                mentions.push(userId);
                mentionText += `@${participant.id.user} `;
            }
        }
        
        await chat.sendMessage(mentionText, { mentions });
        
        // Update usage statistics
        await updateUsageStats(adminId, 'groupsTagged');
        
    } catch (error) {
        console.error('Error executing tagallexcept in group:', error);
        throw error;
    }
}


    
// Export function for server.js integration
async function createBotSession(userId, sessionId, io) {
    try {
        console.log('🤖 BOT: Creating bot session');
        console.log('👤 User ID:', userId);
        console.log('📱 Session ID:', sessionId);

        const client = new Client({
            authStrategy: new LocalAuth({ 
                clientId: `user-${userId}-${sessionId}` 
            }),
            puppeteer: clientConfig.puppeteer,
            qrMaxRetries: clientConfig.qrMaxRetries,
            authTimeoutMs: clientConfig.authTimeoutMs,
            restartOnAuthFail: clientConfig.restartOnAuthFail,
            takeoverOnConflict: clientConfig.takeoverOnConflict,
            takeoverTimeoutMs: clientConfig.takeoverTimeoutMs,
            chatLoadingTimeoutMs: clientConfig.chatLoadingTimeoutMs
        });

        // Store client in existing maps
        clients.set(sessionId, client);

        // QR Code event
        client.on('qr', async (qr) => {
            console.log('📱 BOT: QR CODE GENERATED!');
            console.log('📱 Session:', sessionId);
            
            const roomName = `user-${userId}`;
            io.to(roomName).emit('qrCode', {
                sessionId,
                qr,
                message: 'Scan this QR code with WhatsApp'
            });
            
            console.log('✅ BOT: QR code emitted to room:', roomName);
        });

        // Ready event
        client.on('ready', async () => {
            console.log('✅ BOT: WhatsApp client ready for session:', sessionId);
            
            const selfId = client.info.wid._serialized;
            userSessions.set(selfId, sessionId);
            
            io.to(`user-${userId}`).emit('sessionReady', {
                sessionId,
                phone: client.info.wid.user,
                message: 'WhatsApp connected successfully!'
            });
        });

        // Add all your existing event handlers here
        // Copy your message_create event and other handlers from the main bot code

        // Initialize the client
        console.log('🔄 BOT: Initializing WhatsApp client...');
        await client.initialize();
        console.log('✅ BOT: WhatsApp client initialized');
        
        return client;

    } catch (error) {
        console.error('❌ BOT: Error creating bot session:', error);
        throw error;
    }
}

// Export the function
module.exports = { 
    createBotSession,
    clients,
    userSessions
}


    



