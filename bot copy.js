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
        selfChatOnly: false, // Changed default to false for better self-chat handling
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

// Increase chat timeout in client config
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
    chatLoadingTimeoutMs: 60000  // Add this line (60 seconds)
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

function createNewSession() {
    try {
        const sessionId = Date.now().toString();
        // Add duplicate session prevention here
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

async function saveNewContact(client, phoneNumber, name = null) {
    try {
        // Add client readiness check here
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
    }  catch (error) {
        // Add navigation error handling here
        if (error.message.includes('context was destroyed') || 
            error.message.includes('navigation')) {
            logger.info('Page navigation interrupted contact saving');
            return false;
        }
         logger.error(`Failed to save contact ${phoneNumber}:`, error);
        return false;
    }
    }

function setupCallHandlers(client) {
    client.on('call', async (call) => {
        try {
            // Add navigation guard here
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

        // Add retry mechanism
        let retryCount = 0;
        let chats = [];
        while (retryCount < 3 && chats.length === 0) {
            try {
                chats = await client.getChats();
                logger.info(`📦 Retrieved ${chats.length} chats for session ${sessionId} (attempt ${retryCount + 1})`);
                if (chats.length === 0) {
                    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds before retrying
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
                // Add timeout to participant fetch
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

    // Initialize groups for this session
    clientGroups.set(sessionId, []); // Add this line

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
        
        // Enhanced authentication check with retries
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


// Periodic refresh (every 10 minutes)
groupRefreshIntervals.set(
    sessionId,
    setInterval(() => refreshGroupsForSession(client, sessionId), 600000) // 10 minutes
);


                // Only proceed if properly authenticated
        try {
            const selfId = client.info.wid._serialized;
            const chat = await client.getChatById(selfId);
            
            // Verify we can actually send messages
            const testMsg = await chat.sendMessage("Welcome, We are happy you joined us...");
            await testMsg.delete(true); // Clean up test message
            
            // FIX: Store the correct session ID
            userSessions.set(selfId, sessionId); // Use the sessionId from closure
            
            // FIX: Remove uniqueId and use the actual session ID
            await chat.sendMessage(`🤖 *Bot Connected*\n\nYour session ID: \`${sessionId}\``);
            await chat.sendMessage("👋 Hello, I'm a WhatsApp bot. Use !help to see available commands");    
            // Set up keep-alive
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

            // Skip messages sent by the bot itself
if (message.fromMe) {
    console.log("Skipping message from self");
    return;
}

    // New listener for self-chat commands
    client.on('message_create', async (message) => {
        if (!message.body || !message.body.trim().startsWith(COMMAND_PREFIX)) return;
        const selfId = client.info.wid._serialized;
        const sender = message.fromMe ? message.to : message.from;
        if (sender !== selfId && !isAuthorized(sender)) {
            return await message.reply("🔒 Admin-only command");
        }
        const [command, ...args] = message.body
            .slice(COMMAND_PREFIX.length)
            .trim()
            .split(/\s+/);
        switch (command.toLowerCase()) {
            case 'ping':
                return message.reply('Pong! 🏓');
            case 'help':
                return message.reply(`*Available Commands:*
1. Ping - Check bot response
2. Help - Show this help
3. Status - Show bot status
4. Info - Get chat info
5. Sessionid - Get your session ID
6. Media - Send test media
7. Newsession - Create new session
8. Shutdown - Turn off bot (admin only)
9. Sudo - Admin commands
10. List - List groups
11. Document - Send document
12. Savecontact - Save a new contact (admin only)
13. Contacts - List all saved contacts (admin only)
14. Tagall - Mention all group members (admin only)
15. Tagallexcept - Mention all except specified members (admin only)
16. Meeting - Schedule a meeting with reminders
17. Event - Schedule an event with reminders
18. Reminders - List all active reminders
19. Cancelreminder - Cancel a scheduled reminder`);
               
case 'list': {
    try {
        let groups = clientGroups.get(sessionId) || [];
        
        // If no groups found, try refreshing
        if (groups.length === 0) {
            await message.reply('⏳ Refreshing group list, please wait...');
            groups = await refreshGroupsForSession(client, sessionId) || [];
        }
        
        if (!groups.length) {
            await message.reply('You are not an admin in any groups');
            break;
        }
        
        const listText = groups.map((g, i) => 
            `${i+1}. ${g.name || g.id._serialized}`
        ).join('\n');
        
        await message.reply(`*Admin Groups:*\n${listText}`);
    } catch (error) {
        console.error('Error in !list command:', error);
        await message.reply('❌ Error fetching groups');
    }
    break;
}

        
case 'refreshgroups':
    await message.reply('🔄 Refreshing groups...');
    const groups = await refreshGroupsForSession(client, sessionId);
    await message.reply(`✅ Refreshed ${groups.length} groups`);
    break;

            case 'status':
                const statusMsg = `*Bot Status:*
- Uptime: ${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m
- Active sessions: ${clients.size}
- Memory usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`;
                return message.reply(statusMsg);
            default:
                return message.reply('Unknown command. Try !help');
        }
    });


            // Skip if: empty body, from broadcast, or from status
            if (!message.body || 
                message.from === 'status@broadcast' || 
                message.type === 'broadcast') {
                return;
            }

            // Skip if not a command
            if (!message.body.trim().startsWith(COMMAND_PREFIX)) {
                return;
            }
            
            // Debug log client info
            console.log("CLIENT INFO:", {
                clientReady: client.info !== undefined,
                selfId: client.info?.wid?._serialized,
                sender: message.from
            });

            // Skip if client not ready
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

            // Always allow commands from self chat
            if (sender === selfId) {
                // Process command normally
            } 
            // For other senders, check authorization
            else if (!isAuthorized(sender)) {
                console.log(`Unauthorized command from ${sender}`);
                return await message.reply("🔒 Admin-only command");
            }

            // Process command
            const [command, ...args] = message.body
                .slice(COMMAND_PREFIX.length)
                .trim()
                .split(/\s+/);
                
            console.log("PROCESSING COMMAND:", { 
                command: command.toLowerCase(), 
                args 
            });

            // Add reaction to show command received
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
                    '3. !list - Groups you admin\n' +
                    '4. !tagall [group numbers] - Mention all in groups\n' +
                    '5. !tagallexcept [group numbers] [phone numbers] - Mention all except specified\n' +
                    '6. !document [type] - Send stored file\n' +
                    '7. !meeting [YYYY-MM-DD] [HH:mm] [title] - Schedule meeting\n' +
                    '8. !event [YYYY-MM-DD] [HH:mm] [title] - Schedule event\n' +
                    '9. !refreshgroups - Refresh group list');
                break;
                            
    case 'list': {
     try {
        let groups = clientGroups.get(sessionId) || [];
        
        // If no groups found, try refreshing
              
        if (groups.length === 0) {
            await message.reply('⏳ Refreshing group list, please wait...');
            groups = await refreshGroupsForSession(client, sessionId) || [];
        }
        
        if (!groups.length) {
            await message.reply('You are not an admin in any groups');
            break;
        }
        
        const listText = groups.map((g, i) => 
            `${i+1}. ${g.name || g.id._serialized}`
        ).join('\n');
        
        await message.reply(`*Admin Groups:*\n${listText}`);
    } catch (error) {
        console.error('Error in !list command:', error);
        await message.reply('❌ Error fetching groups');
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
                    const sessionId = userSessions.get(clientId);
                    await message.reply(`Your session ID: ${sessionId}`);
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
                    await handleSudoCommand(message, args);
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
    
    // Skip if client not ready
    if (!client.info) {
        console.log("Client not ready in message_create, skipping");
        return;
    }

    const selfId = client.info.wid._serialized;
    
    // Only process self-chat commands
    if (message.to !== selfId) {
        console.log(`Message not to self (to: ${message.to}, self: ${selfId}), skipping`);
        return;
    }
    
    // Only process commands
    if (!message.body || !message.body.trim().startsWith(COMMAND_PREFIX)) {
        console.log("No command prefix, skipping");
        return;
    }
    
    console.log("Processing self-chat command in message_create");
    
    const [command, ...args] = message.body
        .slice(COMMAND_PREFIX.length)
        .trim()
        .split(/\s+/);
    
    try {
        await message.react(isPrimaryAdmin(message.from) ? '👑' : '🔧');
    } catch (error) {
        console.error("Failed to react:", error);
    }

    switch (command.toLowerCase()) {
        case 'ping':
            return message.reply('Pong! 🏓');
        case 'help':
            return message.reply(`*Available Commands:*
1. Ping - Check bot response
2. Help - Show this help
3. Status - Show bot status
4. Info - Get chat info
5. Sessionid - Get your session ID
6. Media - Send test media
7. Newsession - Create new session
8. Shutdown - Turn off bot (admin only)
9. Sudo - Admin commands
10. List - List groups
11. Document - Send document
12. Savecontact - Save a new contact (admin only)
13. Contacts - List all saved contacts (admin only)
14. Tagall - Mention all group members (admin only)
15. Tagallexcept - Mention all except specified members (admin only)
16. Meeting - Schedule a meeting with reminders
17. Event - Schedule an event with reminders
18. Reminders - List all active reminders
19. Refresh - To refresh groups you are admin of
20. Cancelreminder - Cancel a scheduled reminder`);
               
        case 'list': {
            try {
                console.log("🔍 Self ID:", selfId);
console.log("🆔 Session ID from userSessions:", sessionId);
console.log("📂 Groups in clientGroups:", clientGroups.get(sessionId));


                const groups = clientGroups.get(sessionId) || [];
                
                if (!groups.length) {
                    await message.reply('You are not an admin in any groups');
                    break;
                }
                
                const listText = groups.map((g, i) => 
                    `${i+1}. ${g.name || g.id._serialized}`
                ).join('\n');
                
                await message.reply(`*Admin Groups:*\n${listText}`);
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
        default:
            return message.reply('Unknown command. Try !help');
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
    
process.once('SIGTERM', () => {
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
    
process.once('SIGINT', () => {
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
    
process.once('exit', () => {
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
    
process.once('SIGHUP', () => {
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
    
const handleSudoCommand = async (message, args) => {
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
            
        case 'list':
            const sessionList = Array.from(clients.keys()).map((id, index) => 
                `${index + 1}. Session ID: ${id}`
            ).join('\n');
            await message.reply(`*Active Sessions:*\n${sessionList || 'No active sessions'}`);
            break;
            
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
            await message.reply('Usage: !tagall [group numbers...]\nExample: !tagall 1 3');
            return;
        }

        const groups = clientGroups.get(sessionId) || [];
        const groupIndices = args.map(num => parseInt(num) - 1); // Convert to zero-based index

        for (const index of groupIndices) {
            if (index >= 0 && index < groups.length) {
                const group = groups[index];
                let mentions = [];
                let text = '';
                
                for (const participant of group.participants) {
                    mentions.push(participant.id._serialized);
                    text += `@${participant.id.user} `;
                }
                
                await client.sendMessage(group.id._serialized, text, { mentions });
                logger.info(`Tagged all members in group: ${group.name}`);
            } else {
                await message.reply(`Invalid group number: ${index + 1}`);
            }
        }
        
        await message.reply(`✅ Tagged members in ${groupIndices.length} group(s)`);
    } catch (error) {
        logger.error('Error in tagall command:', error);
        await message.reply('❌ Failed to tag members');
    }
};

const handleGroupTagExceptCommand = async (message, args, client, sessionId) => {
    try {
        if (args.length < 2) {
            await message.reply('Usage: !tagallexcept [group numbers...] [phone numbers...]\nExample: !tagallexcept 1 3 1234567890 0987654321');
            return;
        }

        const groups = clientGroups.get(sessionId) || [];
        const groupIndices = [];
        const exceptNumbers = [];
        
        // Separate group indices from phone numbers
        for (const arg of args) {
            if (!isNaN(arg)) {
                groupIndices.push(parseInt(arg) - 1);
            } else {
                exceptNumbers.push(arg.includes('@') ? arg : `${arg}@c.us`);
            }
        }

        for (const index of groupIndices) {
            if (index >= 0 && index < groups.length) {
                const group = groups[index];
                let mentions = [];
                let text = '';
                
                for (const participant of group.participants) {
                    if (!exceptNumbers.includes(participant.id._serialized)) {
                        mentions.push(participant.id._serialized);
                        text += `@${participant.id.user} `;
                    }
                }
                
                await client.sendMessage(group.id._serialized, text, { mentions });
                logger.info(`Tagged members in group ${group.name} except ${exceptNumbers.length} numbers`);
            } else {
                await message.reply(`Invalid group number: ${index + 1}`);
            }
        }
        
        await message.reply(`✅ Tagged members in ${groupIndices.length} group(s) except ${exceptNumbers.length} numbers`);
    } catch (error) {
        logger.error('Error in tagallexcept command:', error);
        await message.reply('❌ Failed to tag members');
    }
};

const handleMeetingCommand = async (message, args, client) => {
    await message.reply("📅 Meeting command received. Feature under construction.");
};

const handleEventCommand = async (message, args, client) => {
    await message.reply("🎉 Event command received. Feature under construction.");
};

const scheduleReminder = (reminder, client) => {
    console.log("📌 Scheduling reminder:", reminder);
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

if (require.main === module) {
    console.log('🚀 Starting WhatsApp bot...');
    const { start } = module.exports;
    start(); // Start session creation
}