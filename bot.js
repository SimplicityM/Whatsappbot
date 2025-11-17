const fs = require('fs');
const path = require('path');
const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js');
const crypto = require('crypto');
const Contact = require('./models/Contact');
const User = require('./models/User');
const PhoneRecord = require('./models/PhoneRecord'); // Ensure imported
const sessionValidated = new Map();
const TagUsage = require('./models/TagUsage');

require('events').EventEmitter.defaultMaxListeners = 1000;

// ✅ === OWNER & SUBSCRIPTION EXEMPTION SETTINGS ===

// The owner's WhatsApp number (in international format, without @c.us)
const BOT_OWNER = '2347067012884';

// Temporary in-memory exemption list
// You can later store this in DB if needed.
const exemptedUsers = new Set();
// Load exempted users from file on startup (optional)
loadExemptedUsersFromFile();

// Check if user is allowed to use bot commands
async function isAllowedToUseBot(phoneNumber) {
    try {
        // Clean the phone number
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        
        // Check if user is exempted
        if (exemptedUsers.has(cleanNumber)) {
            console.log(`✅ User ${cleanNumber} is exempted`);
            return true;
        }
        
        // Check if user is owner
        const BOT_OWNER = CONFIG.owner ? CONFIG.owner.replace(/[^0-9]/g, '') : null;
        if (BOT_OWNER && cleanNumber === BOT_OWNER) {
            console.log(`👑 User ${cleanNumber} is bot owner`);
            return true;
        }
        
        // Add your actual subscription checking logic here
        // For testing purposes, return true (replace with real subscription check)
        console.log(`🔍 Checking subscription for ${cleanNumber}...`);
        
        // TODO: Replace this with your actual subscription validation
        // Example:
        // const user = await User.findOne({ whatsappNumber: cleanNumber });
        // if (!user) return false;
        // return user.isSubscriptionActive();
        
        // For now, return true to test the bot (CHANGE THIS IN PRODUCTION)
        return true;
        
    } catch (error) {
        console.error('❌ Error checking bot usage permission:', error);
        return false;
    }
}

function exemptUser(phoneNumber, exempt = true) {
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    
    if (exempt) {
        exemptedUsers.add(cleanNumber);
        console.log(`✅ User ${cleanNumber} exempted from payment`);
    } else {
        exemptedUsers.delete(cleanNumber);
        console.log(`🚫 User ${cleanNumber} exemption removed`);
    }
    
    // Optional: Save exempted users to file for persistence
    // saveExemptedUsersToFile();
}

// Optional: Function to save exempted users to file for persistence
function saveExemptedUsersToFile() {
    try {
        const exemptedArray = Array.from(exemptedUsers);
        const fs = require('fs');
        const path = require('path');
        
        const exemptedFile = path.join(__dirname, 'exempted_users.json');
        fs.writeFileSync(exemptedFile, JSON.stringify(exemptedArray, null, 2));
        console.log('💾 Exempted users saved to file');
    } catch (error) {
        console.error('❌ Error saving exempted users:', error);
    }
}

// Optional: Function to load exempted users from file on startup
function loadExemptedUsersFromFile() {
    try {
        const fs = require('fs');
        const path = require('path');
        
        const exemptedFile = path.join(__dirname, 'exempted_users.json');
        if (fs.existsSync(exemptedFile)) {
            const exemptedArray = JSON.parse(fs.readFileSync(exemptedFile, 'utf8'));
            exemptedArray.forEach(number => exemptedUsers.add(number));
            console.log(`📂 Loaded ${exemptedArray.length} exempted users from file`);
        }
    } catch (error) {
        console.error('❌ Error loading exempted users:', error);
    }
}

// Add this near the top of bot.js, after the requires
process.on('unhandledRejection', (reason, promise) => {
    console.log(`[${new Date().toISOString()}] ERROR: Unhandled Rejection at:`, promise);
    console.log('Reason:', reason);
    
    // Don't crash the process for EBUSY errors during cleanup
    if (reason && reason.message && reason.message.includes('EBUSY')) {
        console.log('⚠️ File system cleanup error (Windows) - continuing operation');
        return;
    }
    
    // Don't crash for unlink errors either
    if (reason && reason.message && reason.message.includes('unlink')) {
        console.log('⚠️ File unlink error during cleanup - continuing operation');
        return;
    }
});

// --- START CONFIGURATION BLOCK ---
const getDefaultPath = (dirName) => path.join(__dirname, dirName);

const CONFIG = {
    sessionDataPath: getDefaultPath('sessions'),
    mediaPath: getDefaultPath('media'),
    authPath: getDefaultPath('auth'),
    adminSettings: {
        selfChatOnly: true,
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
            '--no-first-run',
            '--no-zygote'
        ],
        defaultViewport: null
    },

    qrMaxRetries: 3,
    authTimeoutMs: 120000,
    restartOnAuthFail: true,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 5000,
    chatLoadingTimeoutMs: 15000,

    // Recommended WhatsApp settings
    syncFullHistory: false,
    markOnlineOnConnect: false,
    sessionBackupSyncIntervalMs: 300000
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



// Function to suspend a user's bot session (IMPROVED VERSION)
async function suspendUserSession(userId, sessionId, reason, client, io) {
    try {
        console.log(`🚫 Suspending session ${sessionId} for user ${userId}: ${reason}`);
        
        // Send notification to user's self-chat
        if (client && client.info && client.info.wid) {
            try {
                const selfId = client.info.wid._serialized;
                const suspensionMessage = `🚫 *Bot Suspended*\n\n` +
                    `Reason: ${reason}\n\n` +
                    `💳 Please renew your subscription to continue using the bot.\n` +
                    `🌐 Renew at: ${process.env.DOMAIN || 'your-website.com'}/payment\n\n` +
                    `✅ Your session will automatically resume after payment - no need to scan QR again!\n\n` +
                    `📞 Contact support if you believe this is an error.`;
                
                await client.sendMessage(selfId, suspensionMessage);
                console.log('✅ Suspension notification sent to user');
            } catch (msgError) {
                console.error('❌ Failed to send suspension message:', msgError);
            }
        }

        // Emit suspension event to frontend
        if (io) {
            io.to(`user-${userId}`).emit('sessionSuspended', {
                sessionId,
                reason,
                message: 'Bot suspended due to subscription issues'
            });
        }

        // Update session status in database (but keep session data)
        const Session = require('./models/Session');
        await Session.findOneAndUpdate(
            { sessionId },
            { 
                status: 'suspended',
                errorMessage: `Suspended: ${reason}`,
                suspendedAt: new Date()
            }
        );

        // 🔑 KEY CHANGE: Don't destroy client, just mark as suspended
        // Store the client in a suspended state instead of destroying it
        const suspendedClients = global.suspendedClients || new Map();
        suspendedClients.set(sessionId, {
            client,
            userId,
            suspendedAt: new Date(),
            reason
        });
        global.suspendedClients = suspendedClients;

        // Remove from active clients but don't destroy
        clients.delete(sessionId);
        
        console.log(`✅ Session ${sessionId} suspended (not destroyed) - can be resumed after payment`);
        
    } catch (error) {
        console.error('❌ Error suspending user session:', error);
    }
}

// Function to resume a suspended session after payment
async function resumeUserSession(userId, sessionId, io) {
    try {
        console.log(`🟢 Resuming session ${sessionId} for user ${userId} after payment`);
        
        const suspendedClients = global.suspendedClients || new Map();
        const suspendedSession = suspendedClients.get(sessionId);
        
        if (!suspendedSession) {
            console.log(`⚠️ No suspended session found for ${sessionId}`);
            return false;
        }

        const { client } = suspendedSession;
        
        // Verify client is still valid
        if (!client || !client.info || !client.info.wid) {
            console.log(`❌ Suspended client is no longer valid for ${sessionId}`);
            suspendedClients.delete(sessionId);
            return false;
        }

        // Move client back to active clients
        clients.set(sessionId, client);
        suspendedClients.delete(sessionId);

        // Update session status in database
        const Session = require('./models/Session');
        await Session.findOneAndUpdate(
            { sessionId },
            { 
                status: 'connected',
                errorMessage: null,
                suspendedAt: null,
                resumedAt: new Date()
            }
        );

        // Send resume notification to user
        try {
            const selfId = client.info.wid._serialized;
            const resumeMessage = `🟢 *Bot Resumed!*\n\n` +
                `✅ Your subscription is now active.\n` +
                `🤖 Bot is ready for commands!\n\n` +
                `Type !help to see available commands.`;
            
            await client.sendMessage(selfId, resumeMessage);
            console.log('✅ Resume notification sent to user');
        } catch (msgError) {
            console.error('❌ Failed to send resume message:', msgError);
        }

        // Emit resume event to frontend
        if (io) {
            io.to(`user-${userId}`).emit('sessionResumed', {
                sessionId,
                message: 'Bot resumed after payment confirmation'
            });
        }

        console.log(`✅ Session ${sessionId} successfully resumed`);
        return true;
        
    } catch (error) {
        console.error('❌ Error resuming user session:', error);
        return false;
    }
}

// Function to check for bot subscription
// 🔍 Master subscription checker (TRIAL + SUBSCRIPTION + ANTI-FRAUD)
async function checkUserSubscriptionStatus(userId) {
    try {
        const user = await User.findById(userId);
        if (!user) {
            return { isValid: false, reason: 'User not found', action: 'suspend' };
        }

        const ownerNumber = CONFIG.owner ? CONFIG.owner.replace(/[^0-9]/g, '') : null;
        const userNumber = user.whatsappNumber ? user.whatsappNumber.replace(/[^0-9]/g, '') : null;

        // OWNER ALWAYS VALID
        if (userNumber && userNumber === ownerNumber) {
            return { isValid: true, isOwner: true, reason: 'Owner privileges' };
        }

        // EXEMPT USERS ALWAYS VALID
        if (user.exemptFromPayment === true) {
            return { isValid: true, isExempted: true, reason: 'Admin exemption' };
        }

        // ⚠️ STRICT ANTI-FRAUD — PHONE RECORD CONTROLS TRIAL ACCESS
        let phoneRecord = null;
        if (userNumber) {
            phoneRecord = await PhoneRecord.findOne({ phone: userNumber });
        }

        // 🚫 If phone used trial before but for a DIFFERENT account → NO TRIAL
        if (phoneRecord && phoneRecord.usedByUserId && phoneRecord.usedByUserId.toString() !== userId.toString()) {
            return {
                isValid: false,
                reason: 'Trial already used by this phone',
                action: 'block_trial'
            };
        }

        // 🎁 If phone has trial record, check if trial still active
        if (phoneRecord && phoneRecord.trialUsed) {
            if (phoneRecord.trialExpiresAt && phoneRecord.trialExpiresAt > new Date()) {
                const msLeft = phoneRecord.trialExpiresAt.getTime() - Date.now();
                const days = Math.max(1, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
                return {
                    isValid: true,
                    trial: true,
                    trialDaysLeft: days,
                    reason: 'Trial active'
                };
            } else {
                return {
                    isValid: false,
                    trialExpired: true,
                    reason: 'Trial expired',
                    action: 'suspend'
                };
            }
        }

        // ⚠️ User has no phoneRecord but also no subscription → give FREE TRIAL
        if (!user.subscription || !user.subscription.createdAt) {
            return {
                isValid: true,
                trial: true,
                trialDaysLeft: 7,
                reason: 'Trial active (user record-based)'
            };
        }

        // 🔑 Check paid subscription
        const sub = user.subscription;
        if (!sub.status || sub.status !== 'active') {
            return { isValid: false, reason: 'Subscription inactive', action: 'suspend' };
        }

        // Paid & active
        return { isValid: true, reason: 'Active subscription', subscription: sub };

    } catch (error) {
        console.error('❌ Error checking subscription:', error);
        return { isValid: false, reason: 'System error', action: 'suspend' };
    }
}


// Periodic subscription checking function
async function periodicSubscriptionCheck() {
    console.log('🔍 Running periodic subscription check...');

    try {
        const activeClientsList = Array.from(clients.entries());

        for (const [sessionId, client] of activeClientsList) {
            try {
                const Session = require('./models/Session');
                const session = await Session.findOne({ sessionId });
                
                if (!session) {
                    console.log(`⚠️ No session found for ${sessionId}, removing...`);
                    clients.delete(sessionId);
                    continue;
                }

                // Skip brand new sessions (5 minutes)
                const age = Date.now() - new Date(session.createdAt).getTime();
                if (age < 5 * 60 * 1000) {
                    console.log(`⏳ Skipping check for new session ${sessionId} (Age: ${Math.round(age/1000)}s)`);
                    continue;
                }

                const status = await checkUserSubscriptionStatus(session.userId);

                // If the user is blocked from trial (anti-fraud), DO NOT SUSPEND
                if (status.action === 'block_trial') {
                    console.log(`🚫 Trial blocked for phone (anti-fraud). Not suspending session ${sessionId}`);
                    continue;
                }

                // If the subscription is invalid → suspend
                if (!status.isValid && status.action === 'suspend') {
                    console.log(`🚫 Subscription expired → Suspending session ${sessionId}`);
                    await suspendUserSession(session.userId, sessionId, status.reason, client, null);
                }

            } catch (err) {
                console.error(`❌ Error during session check (${sessionId}):`, err);
            }
        }

    } catch (error) {
        console.error('❌ Fatal periodic check error:', error);
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
        
// Mark this session as NOT validated yet (we will check on first command)
// For restored sessions we will set it to true in restoreAllSessions
sessionValidated.set(sessionId, false);
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
        // const meId = client.info.wid._serialized;
        // logger.info(`🤖 Bot ID: ${meId}`);

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

    setupCallHandlers(client);
    return client;
}



let isShuttingDown = false;
    
process.on('uncaughtException', (err) => logger.error('Uncaught Exception:', err));

    
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

}

// Export function for server.js integration
async function createBotSession(userId, sessionId, io) {
    try {
        let botPhoneNumber = null;
        let botSelfId = null;

        console.log('🤖 BOT: Creating bot session');
        console.log('👤 User ID:', userId);
        console.log('📱 Session ID:', sessionId);
        console.log('🔍 BOT: io object exists?', !!io);

        const user = await User.findById(userId);
        const isAdmin =
            user && (user.isAdmin || user.adminLevel !== 'none' || user.role === 'system_admin');

        console.log(`🤖 Creating ${isAdmin ? 'ADMIN' : 'USER'} bot session`);
        console.log(`👤 User: ${user?.email || 'Unknown'} | Admin: ${isAdmin}`);

        // Create the WhatsApp client
        const client = new Client({
            authStrategy: new LocalAuth({
                clientId: `${isAdmin ? 'admin' : 'user'}-${userId}-${sessionId}`,
                dataPath: './.wwebjs_auth'
            }),

            puppeteer: {
                ...clientConfig.puppeteer,
                args: [
                    ...clientConfig.puppeteer.args,
                     '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-zygote'
                ],
                handleSIGINT: false,
                handleSIGTERM: false
            },

            takeoverOnConflict: true,
            takeoverTimeoutMs: 5000,
            syncFullHistory: false,
            markOnlineOnConnect: false,
            chatLoadingTimeoutMs: 15000,
            sessionBackupSyncIntervalMs: 300000,

            qrMaxRetries: clientConfig.qrMaxRetries,
            authTimeoutMs: clientConfig.authTimeoutMs,
            restartOnAuthFail: clientConfig.restartOnAuthFail
        });

        // Store client so we can access it later
        clients.set(sessionId, client);

        let loadingComplete = false;
        let authComplete = false;

        client.on('loading_screen', (percent, message) => {
            console.log(
                `📱 ${isAdmin ? 'ADMIN' : 'USER'} DEBUG: Loading screen:`,
                percent + '%',
                message
            );

        });

        client.on('authenticated', (session) => {
            console.log(`🔑 Authentication successful!`);
            authComplete = true;

            try {
                if (session && session.WABrowserId) {
                    const sessionString = JSON.stringify(session);
                    const phoneMatch = sessionString.match(/(\d{10,15})/);

                    if (phoneMatch) {
                        botPhoneNumber = phoneMatch[1];
                        botSelfId = `${botPhoneNumber}@c.us`;
                    }
                }
            } catch (error) {
                console.error('❌ Error extracting phone:', error.message);
            }

            if (!botPhoneNumber && CONFIG.owner) {
                botPhoneNumber = CONFIG.owner.replace(/[^0-9]/g, '');
                botSelfId = `${botPhoneNumber}@c.us`;
            }
        });

        client.on('change_state', (state) => {
            console.log(`📱 State changed to:`, state);
        });

        client.on('qr', async (qr) => {
            console.log(`📱 QR CODE GENERATED!`);

            const roomName = isAdmin ? `admin-${userId}` : `user-${userId}`;

            if (!io) {
                console.error(`❌ io is undefined!`);
                return;
            }

            io.to(roomName).emit('qrCode', {
                sessionId,
                qr,
                message: 'Scan this QR code with WhatsApp',
                userId,
                isAdmin,
                userType: isAdmin ? 'admin' : 'user'
            });

            io.emit('qrCode', {
                sessionId,
                qr,
                message: 'Scan this QR code with WhatsApp',
                userId,
                isAdmin,
                userType: isAdmin ? 'admin' : 'user',
                broadcast: true
            });
        });

        // READY EVENT
        client.on('ready', async () => {
            console.log('✅ BOT: WhatsApp client ready for session:', sessionId);

            try {
                const selfId = client.info?.wid?._serialized;
                const selfNumber = client.info?.wid?.user;
                const uniqueId = crypto.randomBytes(4).toString('hex').toUpperCase();

                if (!selfId || !selfNumber) {
                    console.error('❌ Missing selfId or selfNumber');
                    return;
                }

                client.selfId = selfId;
                userSessions.set(selfId, uniqueId);

                console.log('📱 Self ID:', selfId);
                console.log('📞 Phone:', selfNumber);
                console.log('🆔 Session ID:', uniqueId);

                const chat = await client.getChatById(selfId);

                // Welcome message
                await chat.sendMessage(
                    `🤖 *Bot Connected Successfully!*\n\n📱 *Your Session ID:* \`${uniqueId}\`\n📞 *Your Number:* ${selfNumber}\n\n⚡ *Status:* Ready for commands!`
                );

                const user = await User.findOne({ whatsappNumber: selfNumber });

                if (user) {
                    const subStatus = await checkUserSubscriptionStatus(user._id);
                    let statusMessage = '';

                    if (subStatus.isOwner) statusMessage = '👑 *Bot Owner Detected*';
                    else if (subStatus.trial)
                        statusMessage = `🎁 *Trial Active* (${subStatus.trialDaysLeft} days left)`;
                    else if (subStatus.isExempted)
                        statusMessage = '🛡️ *Payment Exemption Active*';
                    else if (subStatus.isValid)
                        statusMessage = '💳 *Subscription Active*';
                    else statusMessage = '⚠️ *Subscription Required*';

                    await chat.sendMessage(statusMessage);
                }

                await chat.sendMessage(
                    `🔧 *Available Commands:*\n\n• !ping\n• !help\n• !status\n• !myinfo\n💡 Type commands here.`
                );

                // Message Handler
                            client.on('message', async (message) => {
                try {
                    const selfId = client.selfId || client.info?.wid?._serialized;
                    const selfNumber = client.info?.wid?.user;
                    if (!selfId || !selfNumber) return;

                    const isSelfChat = message.fromMe && message.to === selfId;
                    if (!isSelfChat || !message.body || !message.body.startsWith('!')) return;

                    await message.react('🤖');

                    const raw = message.body.trim();
                    const command = raw.slice(1).split(' ')[0].toLowerCase();
                    const phoneRecord = await PhoneRecord.findOne({ phone: selfNumber });

                    // -------------- BASIC COMMANDS (ALWAYS ALLOWED) --------------
                    const BASIC = new Set(['ping', 'help', 'status', 'sessionid']);
                    const TRIAL = new Set(['tag', 'list']);   // trial-only commands

                    if (BASIC.has(command)) {
                        switch (command) {
                            case 'ping':
                                return await message.reply('🏓 Pong!');

                            case 'help':
                                return await message.reply(
                                    `🤖 *Bot Commands*\n\n` +
                                    `• !ping\n• !help\n• !status\n• !sessionid\n\n` +
                                    `*Trial Commands*: !tag, !list (only during free trial)`
                                );

                            case 'status': {
                                const up = process.uptime();
                                return await message.reply(
                                    `🤖 *Bot Status*\n\n📱 Number: ${selfNumber}\n🆔 Session: ${sessionId}\n⏱️ Uptime: ${up}s`
                                );
                            }

                            case 'sessionid':
                                return await message.reply(`📱 *Session ID:* ${sessionId}`);
                        }
                    }

                    // -------------- TRIAL COMMANDS --------------
                    if (TRIAL.has(command)) {
                        // PHONE NEVER HAD TRIAL BEFORE (should not happen after Ready handler)
                        if (!phoneRecord || !phoneRecord.trialUsed) {
                            return await message.reply(
                                `🚫 *This phone number has NO active trial.*\n` +
                                `You must subscribe to use *${command}*.\n\n` +
                                `🔗 Subscribe: ${process.env.DOMAIN || 'your-website.com'}/payment`
                            );
                        }

                        // PHONE USED TRIAL before but on DIFFERENT ACCOUNT (ANTI-FRAUD)
                        if (phoneRecord.usedByUserId.toString() !== userId.toString()) {
                            return await message.reply(
                                `🚫 *Trial is not available for this phone number.*\n\n` +
                                `This phone has already used its 7-day free trial on another account.\n` +
                                `To use *${command}*, please subscribe.\n\n` +
                                `🔗 Subscribe: ${process.env.DOMAIN || 'your-website.com'}/payment`
                            );
                        }

                        // TRIAL EXPIRED
                        if (!phoneRecord.trialExpiresAt || phoneRecord.trialExpiresAt <= new Date()) {
                            return await message.reply(
                                `⛔ *Your free trial has expired.*\n\n` +
                                `Subscribe to continue using trial commands like *${command}*.\n\n` +
                                `🔗 Renew: ${process.env.DOMAIN || 'your-website.com'}/payment`
                            );
                        }

                        // TRIAL ACTIVE – YOU CAN PLACE YOUR TAG/LIST LOGIC HERE
                        if (command === 'tag') {

                        // 1️⃣ CHECK IF USER IS TRIAL USER
                        let isTrialUser = false;

                        if (phoneRecord && phoneRecord.trialUsed) {
                            if (phoneRecord.usedByUserId.toString() === userId.toString()) {
                                if (phoneRecord.trialExpiresAt > new Date()) {
                                    isTrialUser = true;
                                }
                            }
                        }

                        // 2️⃣ IF NOT TRIAL USER → PAID USER → NO LIMIT
                        const subscriptionCheck = await checkUserSubscriptionStatus(userId);

                        if (subscriptionCheck.isOwner || subscriptionCheck.isExempted || subscriptionCheck.isValid) {
                            return await message.reply(`📌 *TAG executed (premium)*`);
                        }

                        // 3️⃣ TRIAL USER → ENFORCE DAILY LIMIT OF 3
                        if (isTrialUser) {
                            const today = new Date().toISOString().slice(0, 10);

                            let usage = await TagUsage.findOne({ phone: selfNumber, date: today });

                            if (!usage) {
                                usage = await TagUsage.create({
                                    phone: selfNumber,
                                    date: today,
                                    tagsToday: 0
                                });
                            }

                            if (usage.tagsToday >= 3) {
                                return await message.reply(
                                    `🚫 *Daily limit reached*\n\n` +
                                    `You can tag a maximum of **3 groups per day** during the free trial.\n\n` +
                                    `Upgrade your plan to remove this limit.\n` +
                                    `🔗 ${process.env.DOMAIN || 'your-website.com'}/payment`
                                );
                            }

                            usage.tagsToday += 1;
                            await usage.save();

                            return await message.reply(`📌 *TAG executed* (${usage.tagsToday}/3 used today)`);
                        }

                        // 4️⃣ NOT TRIAL & NOT PAID → BLOCK
                        return await message.reply(
                            `🚫 *Subscription Required*\n\n` +
                            `You need an active subscription to use *!tag*.\n\n` +
                            `🔗 Subscribe: ${process.env.DOMAIN || 'your-website.com'}/payment`
                        );
                    }

                        if (command === 'list') {
                            return await message.reply('📃 *LIST command executed (trial)*');
                        }
                    }

                    // -------------- PAID COMMANDS (everything else) --------------
                    let subStatus;
                    try {
                        subStatus = await checkUserSubscriptionStatus(userId);
                    } catch (err) {
                        console.error('⚠️ Subscription check failed:', err);
                        return await message.reply('⚠️ System error while checking subscription.');
                    }

                    // OWNER & EXEMPT USERS ALWAYS VALID
                    if (subStatus.isOwner || subStatus.isExempted) {
                        return await message.reply(`👑 Admin/Owner access granted for *${command}*`);
                    }

                    // If subscription invalid → block
                    if (!subStatus.isValid) {
                        return await message.reply(
                            `🚫 *Subscription Required*\n\n` +
                            `Your subscription is not active, so *${command}* cannot be used.\n\n` +
                            `🔗 Renew at: ${process.env.DOMAIN || 'your-website.com'}/payment`
                        );
                    }

                    // -------------- PAID COMMANDS GO HERE --------------
                    return await message.reply(`💎 *Paid command executed:* ${command}`);

                } catch (err) {
                    console.error('❌ Message handler error:', err);
                }
            });

            } catch (err) {
                console.error('❌ READY handler error:', err);
            }
        });

            // DISCONNECTED EVENT
            client.on('disconnected', (reason) => {
                console.log(`❌ Client disconnected for session ${sessionId}:`, reason);
            });
            
        // START THE CLIENT
        await client.initialize();

        // 🔥🔥🔥 THE MOST IMPORTANT FIX
        return client;

    } catch (err) {
        console.error('❌ Error creating bot session:', err);
        throw err; // REQUIRED so server.js can detect failure
    }
}

// AUTO-RESTORE ALL VALID WHATSAPP SESSIONS ON SERVER START
async function restoreAllSessions(io) {
    try {
        console.log("🔄 SERVER: Restoring all valid WhatsApp sessions...");

        const authPath = path.join(__dirname, ".wwebjs_auth");

        if (!fs.existsSync(authPath)) {
            console.log("⚠️ No LocalAuth folder found. Nothing to restore.");
            return;
        }

        // Scan all LocalAuth directories
        const folders = fs.readdirSync(authPath)
            .filter(f => f.startsWith("user-") || f.startsWith("admin-"));

        if (folders.length === 0) {
            console.log("⚠️ No stored sessions found to restore.");
            return;
        }

        console.log(`📁 Found ${folders.length} stored sessions...`);

        for (const folder of folders) {
            console.log(`\n📂 Checking folder: ${folder}`);

            const [type, userId, sessionId] = folder.split("-");

            if (!userId || !sessionId) {
                console.log(`⚠️ Invalid folder format: ${folder}`);
                continue;
            }

            const dbSession = await Session.findOne({ sessionId });

            if (!dbSession) {
                console.log(`⚠️ No DB record for ${sessionId}. Skipping.`);
                continue;
            }

            // Check subscription
            const subStatus = await checkUserSubscriptionStatus(dbSession.userId);

            if (!subStatus || !subStatus.isValid) {
                console.log(`⛔ Subscription expired for ${sessionId}. NOT restoring.`);
                continue;
            }

            // Prevent duplicate restore
            if (clients.has(sessionId)) {
                console.log(`⚠️ Session ${sessionId} is already active. Skipping.`);
                continue;
            }

            console.log(`🔁 Restoring valid session: ${sessionId}`);

            try {
                await createBotSession(dbSession.userId, sessionId, io);
                console.log(`✅ Successfully restored session: ${sessionId}`);
            } catch (err) {
                console.error(`❌ Failed to restore session ${sessionId}:`, err.message);
            }
        }

        console.log("\n🎉 Done restoring saved sessions.");

    } catch (err) {
        console.error("❌ Fatal restore error:", err);
    }
}

// RESTORE A SINGLE USER SESSION AFTER PAYMENT
async function restoreUserSessionAfterPayment(userId, io) {
    try {
        console.log(`💰 Restoring session after payment for user ${userId}`);

        // Find any session owned by this user
        const dbSessions = await Session.find({ userId });

        if (!dbSessions || dbSessions.length === 0) {
            console.log("⚠️ No session found for this user.");
            return;
        }

        for (const s of dbSessions) {
            const sessionId = s.sessionId;

            console.log(`🔍 Checking session ${sessionId}`);

            // Avoid duplicates
            if (clients.has(sessionId)) {
                console.log(`⚠️ Session ${sessionId} already active.`);
                continue;
            }

            // Check subscription status again
            const sub = await checkUserSubscriptionStatus(userId);

            if (!sub.isValid) {
                console.log(`⛔ Subscription still invalid for ${sessionId}.`);
                continue;
            }

            console.log(`🔁 Restoring ${sessionId}...`);

            try {
                await createBotSession(userId, sessionId, io);
                console.log(`✅ Session restored: ${sessionId}`);
            } catch (err) {
                console.error(`❌ Failed to restore ${sessionId}:`, err.message);
            }
        }
    } catch (err) {
        console.error("❌ Payment restore error:", err);
    }
}



// Start global periodic subscription checking
setInterval(periodicSubscriptionCheck, 5 * 60 * 1000); // Check every 5 minutes

// Also check on startup
setTimeout(periodicSubscriptionCheck, 30000); // Check 30 seconds after startup

// Enhanced welcome message function that should be inside sendWelcomeMessages
async function sendCommandsMessage(chat, isAdmin, uniqueId) {
    try {
        const commandsMessage = isAdmin 
            ? `🔧 *Admin Commands Available:*\n\n` +
              `• !ping - Test response\n` +
              `• !help - Full help menu\n` +
              `• !status - Bot status\n` +
              `• !stats - System statistics\n` +
              `• !exempt <number> - Exempt user from payment\n` +
              `• !unexempt <number> - Remove exemption\n` +
              `• !listexempt - List exempted users\n` +
              `• !broadcast <message> - Send to all users\n` +
              `• !sessions - List all active sessions\n` +
              `• !userinfo <number> - Get user information\n\n` +
              `👑 *Admin Privileges:* Full system control\n` +
              `💡 Type commands in this chat only!`
            : `🔧 *Available Commands:*\n\n` +
              `• !ping - Test response\n` +
              `• !help - Full help menu\n` +
              `• !status - Bot status\n` +
              `• !myinfo - Account info\n\n` +
              `💡 Type commands in this chat only!`;

        await chat.sendMessage(commandsMessage);
        console.log(`✅ ${isAdmin ? 'ADMIN' : 'USER'} Commands message sent`);
        
        return true;
    } catch (error) {
        console.error(`❌ Failed to send commands message:`, error);
        return false;
    }
}

// Enhanced contact sync with proper error handling
async function performContactSync(client, sessionId, userId, io, isAdmin) {
    try {
        console.log(`📞 Starting contact sync for ${isAdmin ? 'ADMIN' : 'USER'}...`);
        
        // Your existing syncContacts logic here
        const contacts = await client.getContacts();
        const chats = await client.getChats();
        const groupChats = chats.filter(chat => chat.isGroup);
        
        console.log(`📋 Found ${contacts.length} contacts and ${groupChats.length} groups`);
        
        // Notify frontend about sync completion
        if (io) {
            io.to(`${isAdmin ? 'admin' : 'user'}-${userId}`).emit('contactSyncComplete', {
                sessionId,
                contactCount: contacts.length,
                groupCount: groupChats.length,
                message: 'Contact sync completed successfully'
            });
        }
        
        console.log(`✅ Contact sync completed for ${isAdmin ? 'ADMIN' : 'USER'}`);
        return true;
        
    } catch (error) {
        console.error(`❌ Contact sync failed for ${isAdmin ? 'ADMIN' : 'USER'}:`, error);
        return false;
    }
}


// Add this function in bot.js
function debugClientState(client, sessionId) {
    console.log(`🔍 DEBUG CLIENT STATE for ${sessionId}:`);
    console.log(`  - Client exists: ${!!client}`);
    console.log(`  - Client.info exists: ${!!client?.info}`);
    console.log(`  - Client.info.wid exists: ${!!client?.info?.wid}`);
    console.log(`  - Client state: ${client ? 'unknown' : 'null'}`);
    
    if (client?.info?.wid) {
        console.log(`  - Self ID: ${client.info.wid._serialized}`);
        console.log(`  - Phone: ${client.info.wid.user}`);
    }
}


// Export the function
module.exports = {
    createBotSession,
    restoreAllSessions,
    restoreUserSessionAfterPayment,   // if you used this
    resumeUserSession,                // if you have this function
    clients,
    userSessions
};

// Start global periodic subscription checking (add at the very end)
setInterval(periodicSubscriptionCheck, 5 * 60 * 1000); // Check every 5 minutes

// Also check on startup
setTimeout(periodicSubscriptionCheck, 30000); // Check 30 seconds after startup