const fs = require('fs');
const path = require('path');
const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js');
const crypto = require('crypto');
const Contact = require('./models/Contact');
const User = require('./models/User');
const PhoneRecord = require('./models/PhoneRecord'); // Ensure imported
const Session = require('./models/Session');
const TagUsage = require('./models/TagUsage');
const sessionValidated = new Map();


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
async function checkUserSubscriptionStatus(userId) {
    try {
        const user = await User.findById(userId);
        if (!user) return { isValid: false, reason: "User not found", action: "suspend" };

        const userNumber = user.whatsappNumber?.replace(/[^0-9]/g, "");
        const ownerNumber = CONFIG.owner?.replace(/[^0-9]/g, "");

        // Owner rule
        if (userNumber === ownerNumber) {
            return { isValid: true, isOwner: true, reason: "Owner access" };
        }

        // Exempt user
        if (user.exemptFromPayment === true) {
            return { isValid: true, isExempted: true, reason: "Admin exempted" };
        }

        const sub = user.subscription;

        // No subscription yet → trial user
        if (!sub || !sub.createdAt) {
            return {
                isValid: true,
                trial: true,
                reason: "Trial active",
                trialDaysLeft: 7
            };
        }

        const now = new Date();
        if (sub.expiresAt && sub.expiresAt > now) {
            return {
                isValid: true,
                subscription: sub,
                planType: sub.planType,
                reason: "Subscription active"
            };
        }

        // Expired
        return {
            isValid: false,
            reason: "Subscription expired",
            expired: true
        };

    } catch (err) {
        console.error("Subscription checking error:", err);
        return { isValid: false, reason: "System error", action: "suspend" };
    }
}



// Periodic subscription checking function
// SAFE periodic subscription checking function
async function periodicSubscriptionCheck() {
  console.log('🔍 Running periodic subscription check.');

  try {
    const activeClientsList = Array.from(clients.entries());

    for (const [sessionId, client] of activeClientsList) {
      try {
        // skip if client was removed or invalid
        if (!client) {
          console.log(`⚠️ No client instance for ${sessionId}, skipping.`);
          continue;
        }

        const Session = require('./models/Session');
        const session = await Session.findOne({ sessionId });

        // If DB session doesn't exist yet, skip — server may still be saving it
        if (!session) {
          console.log(`⚠️ DB session not found for ${sessionId} — likely still being created. Skipping check.`);
          continue;
        }

        // Skip very new sessions (short grace window)
        const ageMs = Date.now() - new Date(session.createdAt).getTime();
        if (ageMs < (2 * 60 * 1000)) { // 2 minutes
          console.log(`⏳ Skipping check for session ${sessionId} (Age: ${Math.round(ageMs/1000)}s)`);
          continue;
        }

        // client.info.wid only exists after auth/ready
        const isClientReady = !!client?.info?.wid;
        const validated = sessionValidated.get(sessionId) === true;

        // If client not ready OR not yet validated, skip — wait until welcome/first-command completes
        if (!isClientReady || !validated) {
          console.log(`🔒 Skipping session ${sessionId} — ready:${isClientReady} validated:${validated}`);
          continue;
        }

        // Now it's safe to check subscription status
        const status = await checkUserSubscriptionStatus(session.userId);

        // Anti-fraud: if phone blocked from trial, don't suspend — just log
        if (status.action === 'block_trial') {
          console.log(`🚫 Session ${sessionId}: phone blocked from trial (anti-fraud). Not suspending.`);
          continue;
        }

        if (!status.isValid && status.action === 'suspend') {
          console.log(`🚫 Subscription invalid — suspending session ${sessionId} for user ${session.userId}`);
          await suspendUserSession(session.userId, sessionId, status.reason, client, null);
        } else {
          // session is healthy
          // optionally send heartbeat/emit to frontend:
          // io?.to(`user-${session.userId}`).emit('sessionHealthy', { sessionId });
        }

      } catch (err) {
        console.error(`❌ Error during subscription check for (${sessionId}):`, err);
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
// async function createBotSession(userId, sessionId, io) {
//     try {
//         let botPhoneNumber = null;
//         let botSelfId = null;

//         console.log('🤖 BOT: Creating bot session');
//         console.log('👤 User ID:', userId);
//         console.log('📱 Session ID:', sessionId);
//         console.log('🔍 BOT: io object exists?', !!io);

//         const user = await User.findById(userId);
//         const isAdmin =
//             user && (user.isAdmin || user.adminLevel !== 'none' || user.role === 'system_admin');

//         console.log(`🤖 Creating ${isAdmin ? 'ADMIN' : 'USER'} bot session`);
//         console.log(`👤 User: ${user?.email || 'Unknown'} | Admin: ${isAdmin}`);

//         // Create the WhatsApp client
//         const client = new Client({
//             authStrategy: new LocalAuth({
//                 clientId: `${isAdmin ? 'admin' : 'user'}-${userId}-${sessionId}`,
//                 dataPath: './.wwebjs_auth'
//             }),
//             puppeteer: {
//                 ...clientConfig.puppeteer,
//                 args: [
//                     ...clientConfig.puppeteer.args,
//                     '--no-sandbox',
//                     '--disable-setuid-sandbox',
//                     '--disable-gpu',
//                     '--disable-dev-shm-usage',
//                     '--no-first-run',
//                     '--no-zygote'
//                 ],
//                 handleSIGINT: false,
//                 handleSIGTERM: false
//             },
//             takeoverOnConflict: true,
//             takeoverTimeoutMs: 5000,
//             syncFullHistory: false,
//             markOnlineOnConnect: false,
//             chatLoadingTimeoutMs: 15000,
//             sessionBackupSyncIntervalMs: 300000,
//             qrMaxRetries: clientConfig.qrMaxRetries,
//             authTimeoutMs: clientConfig.authTimeoutMs,
//             restartOnAuthFail: clientConfig.restartOnAuthFail
//         });

//         // Store client so we can access it later
//         clients.set(sessionId, client);

//         client.on('loading_screen', (percent, message) => {
//             console.log(`📱 ${isAdmin ? 'ADMIN' : 'USER'} DEBUG: Loading screen:`, percent + '%', message);
//         });

//         client.on('authenticated', (session) => {
//             console.log(`🔑 Authentication successful!`);
//             try {
//                 if (session && typeof session === 'object') {
//                     const sessionString = JSON.stringify(session);
//                     const phoneMatch = sessionString.match(/(\d{10,15})/);
//                     if (phoneMatch) {
//                         botPhoneNumber = phoneMatch[1];
//                         botSelfId = `${botPhoneNumber}@c.us`;
//                     }
//                 }
//             } catch (error) {
//                 console.error('❌ Error extracting phone from session object:', error.message);
//             }

//             if (!botPhoneNumber && CONFIG.owner) {
//                 botPhoneNumber = CONFIG.owner.replace(/[^0-9]/g, '');
//                 botSelfId = `${botPhoneNumber}@c.us`;
//             }
//         });

//         client.on('change_state', (state) => {
//             console.log(`📱 State changed to:`, state);
//         });

//         client.on('qr', async (qr) => {
//             console.log(`📱 QR CODE GENERATED!`);
//             const roomName = isAdmin ? `admin-${userId}` : `user-${userId}`;

//             if (!io) {
//                 console.error(`❌ io is undefined! Cannot emit QR.`);
//                 return;
//             }

//             io.to(roomName).emit('qrCode', {
//                 sessionId,
//                 qr,
//                 message: 'Scan this QR code with WhatsApp',
//                 userId,
//                 isAdmin,
//                 userType: isAdmin ? 'admin' : 'user'
//             });

//             // Also broadcast as fallback
//             io.emit('qrCode', {
//                 sessionId,
//                 qr,
//                 message: 'Scan this QR code with WhatsApp',
//                 userId,
//                 isAdmin,
//                 userType: isAdmin ? 'admin' : 'user',
//                 broadcast: true
//             });
//         });

//         // ======= READY handler (must be before message handler) =======
//         // client.on('ready', async () => {
//         //     console.log('✅ BOT: WhatsApp client ready for session:', sessionId);

//         //     try {
//         //         const selfId = client.info?.wid?._serialized;
//         //         const selfNumber = client.info?.wid?.user;
//         //         const uniqueId = crypto.randomBytes(4).toString('hex').toUpperCase();

//         //         if (!selfId || !selfNumber) {
//         //             console.error('❌ Missing selfId or selfNumber in ready event');
//         //             return;
//         //         }

//         //         client.selfId = selfId;
//         //         userSessions.set(selfId, sessionId);

//         //         console.log('📱 Self ID:', selfId);
//         //         console.log('📞 Phone:', selfNumber);
//         //         console.log('🆔 Session ID (unique):', uniqueId);

//         //         // Reload user from DB by whatsappNumber if possible, fallback to user
//         //         const userDoc = (await User.findOne({ whatsappNumber: selfNumber })) || user;

//         //         // Create or update PhoneRecord so message handler can rely on it
//         //         let phoneRecord = await PhoneRecord.findOne({ phone: selfNumber });
//         //         if (!phoneRecord) {
//         //             phoneRecord = await PhoneRecord.create({
//         //                 phone: selfNumber,
//         //                 usedByUserId: userDoc?._id || null,
//         //                 trialUsed: true,
//         //                 trialStartedAt: new Date(),
//         //                 trialExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
//         //                 firstCommandDone: false
//         //             });
//         //             console.log(`📌 PhoneRecord created for ${selfNumber}`);
//         //         } else {
//         //             if (!phoneRecord.usedByUserId && userDoc?._id) {
//         //                 phoneRecord.usedByUserId = userDoc._id;
//         //                 await phoneRecord.save();
//         //                 console.log(`🔧 PhoneRecord ${selfNumber} linked to user ${userDoc._id}`);
//         //             }
//         //         }

//         //         // Update Session DB to connected (if you keep Session model)
//         //         try {
//         //             await Session.findOneAndUpdate(
//         //                 { sessionId },
//         //                 {
//         //                     status: 'connected',
//         //                     phone: selfNumber,
//         //                     connectedAt: new Date(),
//         //                     updatedAt: new Date()
//         //                 },
//         //                 { upsert: false }
//         //             );
//         //         } catch (sErr) {
//         //             console.error('❌ Could not update Session record on ready:', sErr.message);
//         //         }

//         //         // Send welcome messages
//         //         try {
//         //             const chat = await client.getChatById(selfId);

//         //             await chat.sendMessage(
//         //                 `🤖 *Bot Connected Successfully!*\n\n📱 *Your Session ID:* \`${uniqueId}\`\n📞 *Your Number:* ${selfNumber}\n\n⚡ *Status:* Ready for commands!`
//         //             );

//         //             if (userDoc) {
//         //                 const subStatus = await checkUserSubscriptionStatus(userDoc._id);
//         //                 let statusMessage = '';
//         //                 if (subStatus.isOwner) statusMessage = '👑 *Bot Owner Detected*';
//         //                 else if (subStatus.trial) statusMessage = `🎁 *Trial Active* (${subStatus.trialDaysLeft} days left)`;
//         //                 else if (subStatus.isExempted) statusMessage = '🛡️ *Payment Exemption Active*';
//         //                 else if (subStatus.isValid) statusMessage = '💳 *Subscription Active*';
//         //                 else statusMessage = '⚠️ *Subscription Required*';

//         //                 await chat.sendMessage(statusMessage);
//         //             }

//         //             // Try calling optional helper - guarded
//         //             try {
//         //                 if (typeof sendCommandsMessage === 'function') {
//         //                     await sendCommandsMessage(chat, !!(userDoc && (userDoc.isAdmin || userDoc.role === 'system_admin')), uniqueId);
//         //                 } else {
//         //                     // fallback default
//         //                     await chat.sendMessage(
//         //                         `🔧 *Available Commands:*\n\n• !ping\n• !help\n• !status\n• !sessionid\n💡 Type commands here.`
//         //                     );
//         //                 }
//         //             } catch (helperErr) {
//         //                 console.error('❌ sendCommandsMessage failed:', helperErr.message);
//         //             }
//         //         } catch (msgErr) {
//         //             console.error('❌ Failed to send welcome messages:', msgErr);
//         //         }

//         //         // IMPORTANT: Do NOT set sessionValidated true here.
//         //         // We only validate after the FIRST user command according to your rule.
//         //         sessionValidated.set(sessionId, false);
//         //         console.log(`✅ READY completed for session ${sessionId} (sessionValidated=false)`);
//         //     } catch (err) {
//         //         console.error('❌ READY handler error for session', sessionId, err);
//         //     }
//         // });
//             client.on('ready', async () => {
//     console.log('✅ BOT: WhatsApp client ready for session:', sessionId);

//     try {
//         // Add timeout protection
//         const readyTimeout = setTimeout(() => {
//             console.error('❌ Ready event timeout for session:', sessionId);
//         }, 30000);

//         const selfId = client.info?.wid?._serialized;
//         const selfNumber = client.info?.wid?.user;
//         const uniqueId = crypto.randomBytes(4).toString('hex').toUpperCase();

//         if (!selfId || !selfNumber) {
//             console.error('❌ Missing selfId or selfNumber in ready event');
//             console.error('❌ Client info:', client.info);
//             clearTimeout(readyTimeout);
//             return;
//         }

//         client.selfId = selfId;
//         userSessions.set(selfId, sessionId);

//         console.log('📱 Self ID:', selfId);
//         console.log('📞 Phone:', selfNumber);
//         console.log('🆔 Session ID (unique):', uniqueId);

//         // Clear timeout since we got this far
//         clearTimeout(readyTimeout);

//         // Reload user from DB by whatsappNumber if possible, fallback to user
//         let userDoc;
//         try {
//             userDoc = (await User.findOne({ whatsappNumber: selfNumber })) || user;
//             console.log('✅ User document retrieved:', userDoc ? userDoc.email : 'No user found');
//         } catch (userErr) {
//             console.error('❌ Failed to find user:', userErr);
//             userDoc = user; // fallback to original user
//         }

//         // Create or update PhoneRecord (if PhoneRecord model exists)
//         try {
//             // Check if PhoneRecord model exists
//             let PhoneRecord;
//             try {
//                 PhoneRecord = require('./models/PhoneRecord');
//             } catch (modelErr) {
//                 console.log('⚠️ PhoneRecord model not found, skipping phone record creation');
//                 PhoneRecord = null;
//             }

//             if (PhoneRecord) {
//                 let phoneRecord = await PhoneRecord.findOne({ phone: selfNumber });
//                 if (!phoneRecord) {
//                     phoneRecord = await PhoneRecord.create({
//                         phone: selfNumber,
//                         usedByUserId: userDoc?._id || null,
//                         trialUsed: true,
//                         trialStartedAt: new Date(),
//                         trialExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
//                         firstCommandDone: false
//                     });
//                     console.log(`📌 PhoneRecord created for ${selfNumber}`);
//                 } else {
//                     if (!phoneRecord.usedByUserId && userDoc?._id) {
//                         phoneRecord.usedByUserId = userDoc._id;
//                         await phoneRecord.save();
//                         console.log(`🔧 PhoneRecord ${selfNumber} linked to user ${userDoc._id}`);
//                     }
//                 }
//             }
//         } catch (phoneErr) {
//             console.error('❌ PhoneRecord operation failed:', phoneErr.message);
//             // Continue execution - this is not critical
//         }

//         // Update Session DB to connected
//         try {
//             const sessionUpdate = await Session.findOneAndUpdate(
//                 { sessionId },
//                 {
//                     status: 'connected',
//                     phone: selfNumber,
//                     connectedAt: new Date(),
//                     updatedAt: new Date()
//                 },
//                 { upsert: false, new: true }
//             );
            
//             if (sessionUpdate) {
//                 console.log('✅ Session status updated to connected');
//             } else {
//                 console.log('⚠️ Session not found in database for update');
//             }
//         } catch (sErr) {
//             console.error('❌ Could not update Session record on ready:', sErr.message);
//         }

//         // Send welcome messages with proper error handling
//         try {
//             console.log('📤 Attempting to get self chat...');
//             const chat = await client.getChatById(selfId);
//             console.log('✅ Self chat retrieved successfully');

//             // Send welcome message
//             try {
//                 await chat.sendMessage(
//                     `🤖 *Bot Connected Successfully!*\n\n📱 *Your Session ID:* \`${uniqueId}\`\n📞 *Your Number:* ${selfNumber}\n\n⚡ *Status:* Ready for commands!`
//                 );
//                 console.log('✅ Welcome message sent');
//             } catch (welcomeErr) {
//                 console.error('❌ Failed to send welcome message:', welcomeErr);
//             }

//             // Send subscription status message
//             if (userDoc) {
//                 try {
//                     const subStatus = await checkUserSubscriptionStatus(userDoc._id);
//                     let statusMessage = '';
                    
//                     if (subStatus.isOwner) statusMessage = '👑 *Bot Owner Detected*';
//                     else if (subStatus.trial) statusMessage = `🎁 *Trial Active* (${subStatus.trialDaysLeft} days left)`;
//                     else if (subStatus.isExempted) statusMessage = '🛡️ *Payment Exemption Active*';
//                     else if (subStatus.isValid) statusMessage = '💳 *Subscription Active*';
//                     else statusMessage = '⚠️ *Subscription Required*';

//                     await chat.sendMessage(statusMessage);
//                     console.log('✅ Subscription status message sent');
//                 } catch (subErr) {
//                     console.error('❌ Failed to send subscription status:', subErr);
//                 }
//             }

//             // Send commands message
//             try {
//                 // Check if sendCommandsMessage function exists
//                 if (typeof sendCommandsMessage === 'function') {
//                     await sendCommandsMessage(chat, !!(userDoc && (userDoc.isAdmin || userDoc.role === 'system_admin')), uniqueId);
//                     console.log('✅ Commands message sent via helper function');
//                 } else {
//                     // Fallback default commands message
//                     await chat.sendMessage(
//                         `🔧 *Available Commands:*\n\n• !ping\n• !help\n• !status\n• !sessionid\n💡 Type commands here.`
//                     );
//                     console.log('✅ Default commands message sent');
//                 }
//             } catch (helperErr) {
//                 console.error('❌ Failed to send commands message:', helperErr.message);
//             }

//         } catch (chatErr) {
//             console.error('❌ Failed to get self chat or send messages:', chatErr);
//         }

//         // Initialize session validation state (using your existing Map)
//         sessionValidated.set(sessionId, false);
//         console.log(`✅ Session validation state initialized for ${sessionId} (sessionValidated=false)`);

//         // Emit ready event to frontend
//         if (io) {
//             try {
//                 const roomName = isAdmin ? `admin-${userId}` : `user-${userId}`;
//                 io.to(roomName).emit('sessionReady', {
//                     sessionId,
//                     phone: selfNumber,
//                     message: 'WhatsApp connected successfully!'
//                 });
//                 console.log('✅ Ready event emitted to frontend');
//             } catch (ioErr) {
//                 console.error('❌ Failed to emit ready event:', ioErr);
//             }
//         }

//         console.log(`✅ READY completed successfully for session ${sessionId}`);

//     } catch (err) {
//         console.error('❌ READY handler error for session', sessionId, ':', err);
//         console.error('❌ Error stack:', err.stack);
        
//         // Try to update session status to error
//         try {
//             await Session.findOneAndUpdate(
//                 { sessionId },
//                 {
//                     status: 'error',
//                     errorMessage: err.message,
//                     updatedAt: new Date()
//                 }
//             );
//         } catch (updateErr) {
//             console.error('❌ Failed to update session error status:', updateErr);
//         }
//     }
// });

//         // ======================= MESSAGE HANDLER ==========================
//         client.on('message', async (message) => {
//             try {
//                 const selfId = client.selfId || client.info?.wid?._serialized;
//                 const selfNumber = client.info?.wid?.user;
//                 if (!selfId || !selfNumber) return;

//                 const isSelfChat = message.fromMe && message.to === selfId;
//                 if (!isSelfChat || !message.body || !message.body.startsWith('!')) return;

//                 const raw = message.body.trim();
//                 const command = raw.slice(1).split(' ')[0].toLowerCase();

//                 await message.react('🤖');

//                 const BASIC = new Set(['ping', 'help', 'status', 'sessionid']);
//                 const TRIAL_ONLY = new Set(['tag', 'list']);

//                 // reload phoneRecord & user each message (keeps state fresh)
//                 let phoneRecord = await PhoneRecord.findOne({ phone: selfNumber });
//                 const userDoc = await User.findOne({ whatsappNumber: selfNumber });
//                 const userObjId = userDoc?._id;

//                 if (!userDoc) {
//                     return await message.reply("⚠️ Error: User record not found.");
//                 }

//                 // 1) BASIC commands always allowed
//                 if (BASIC.has(command)) {
//                     switch (command) {
//                         case 'ping': return await message.reply('🏓 Pong!');
//                         case 'help':
//                             return await message.reply(
//                                 `🤖 *Bot Commands*\n\n` +
//                                 `• !ping — check if bot is alive\n` +
//                                 `• !help — show help menu\n` +
//                                 `• !status — check your bot account status\n` +
//                                 `• !sessionid — show your session ID\n\n` +
//                                 `🔸 *Trial Commands*: !tag, !list (available only during 7-day trial)\n` +
//                                 `🔸 *Paid Commands* depend on your subscription level\n`
//                             );
//                         case 'status': {
//                             const s = await checkUserSubscriptionStatus(userObjId);
//                             return await message.reply(
//                                 `📊 *Bot Status*\n\n` +
//                                 `📱 Number: ${selfNumber}\n` +
//                                 `🆔 Session ID: ${sessionId}\n` +
//                                 `📌 Status: ${s.reason || 'Unknown'}`
//                             );
//                         }
//                         case 'sessionid': return await message.reply(`📱 *Session ID:* ${sessionId}`);
//                     }
//                 }

//                 // 2) owner/exempt bypass
//                 const subStatus = await checkUserSubscriptionStatus(userObjId);
//                 if (subStatus.isOwner || subStatus.isExempted) {
//                     return await message.reply(`👑 Admin/Owner access granted for *${command}*`);
//                 }

//                 const now = new Date();

//                 // 3) TRIAL active handling
//                 if (phoneRecord && phoneRecord.trialUsed && phoneRecord.usedByUserId?.toString() === userObjId?.toString()) {
//                     if (phoneRecord.trialExpiresAt && phoneRecord.trialExpiresAt > now) {
//                         if (TRIAL_ONLY.has(command)) {
//                             if (command === 'tag') {
//                                 const today = new Date().toISOString().slice(0, 10);
//                                 let usage = await TagUsage.findOne({ phone: selfNumber, date: today });
//                                 if (!usage) {
//                                     usage = await TagUsage.create({ phone: selfNumber, date: today, tagsToday: 0 });
//                                 }
//                                 if (usage.tagsToday >= 3) {
//                                     return await message.reply(
//                                         `🚫 *Trial Limit Reached*\nYou can only tag **3 groups/day** during trial.\nUpgrade: ${process.env.DOMAIN}/payment`
//                                     );
//                                 }
//                                 usage.tagsToday++;
//                                 await usage.save();
//                                 // mark firstCommand if not done
//                                 if (!phoneRecord.firstCommandDone) {
//                                     phoneRecord.firstCommandDone = true;
//                                     await phoneRecord.save();
//                                     sessionValidated.set(sessionId, true);
//                                     console.log(`🔓 Session ${sessionId} validated by first command (trial)`);
//                                 }
//                                 return await message.reply(`📌 *TAG executed* (${usage.tagsToday}/3 today)`);
//                             }
//                             if (command === 'list') {
//                                 if (!phoneRecord.firstCommandDone) {
//                                     phoneRecord.firstCommandDone = true;
//                                     await phoneRecord.save();
//                                     sessionValidated.set(sessionId, true);
//                                     console.log(`🔓 Session ${sessionId} validated by first command (trial)`);
//                                 }
//                                 return await message.reply('📃 *LIST executed (trial)*');
//                             }
//                         }
//                         // trial active and command not allowed
//                         return await message.reply(`🚫 *Command not allowed during trial:* ${command}\nAvailable: !tag, !list`);
//                     }
//                 }

//                 // 4) Fraud-prevention: phone used on other account
//                 if (phoneRecord && phoneRecord.usedByUserId?.toString() !== userObjId?.toString()) {
//                     return await message.reply(
//                         `🚫 *Trial not available for this phone number*\nThis number already used a free trial on another account.\nSubscribe: ${process.env.DOMAIN}/payment`
//                     );
//                 }

//                 // 5) FIRST-COMMAND GRACE for expired users (and expired paid users)
//                 if (phoneRecord && !phoneRecord.firstCommandDone) {
//                     // mark first command done and validate session, but only allow BASIC commands as an info step
//                     phoneRecord.firstCommandDone = true;
//                     await phoneRecord.save();
//                     sessionValidated.set(sessionId, true);
//                     console.log(`🔓 Session ${sessionId} validated by first command; periodic checks enabled for this session.`);

//                     if (!TRIAL_ONLY.has(command)) {
//                         return await message.reply(
//                             `ℹ️ *Welcome back!* Your free trial/subscription has expired.\n` +
//                             `You can use basic commands (ping/help/status/sessionid).\n` +
//                             `To continue using features, please subscribe:\n${process.env.DOMAIN}/payment`
//                         );
//                     }
//                 }

//                 // 6) now enforce subscription for non-trial users
//                 if (!subStatus.isValid) {
//                     return await message.reply(
//                         `🚫 *Subscription Required*\nYour subscription is inactive. Renew: ${process.env.DOMAIN}/payment`
//                     );
//                 }

//                 // 7) Paid users - level based access
//                 const paidPlan = userDoc.subscription?.planType || 'starter';
//                 const PLAN_RULES = {
//                     starter: ['tag-basic', 'autoreply-basic'],
//                     professional: ['tag-advanced', 'list-advanced', 'autoreply', 'scheduler'],
//                     business: ['all'],
//                     enterprise: ['all']
//                 };

//                 if (!PLAN_RULES[paidPlan]) {
//                     return await message.reply('⚠️ Invalid subscription plan.');
//                 }

//                 if (PLAN_RULES[paidPlan][0] !== 'all' && !PLAN_RULES[paidPlan].includes(command)) {
//                     return await message.reply(
//                         `🚫 *Command not available in your plan (${paidPlan})*\nUpgrade: ${process.env.DOMAIN}/payment`
//                     );
//                 }

//                 // Paid command allowed
//                 return await message.reply(`💎 *Paid command executed:* ${command}`);
//             } catch (err) {
//                 console.error('❌ Message handler error:', err);
//             }
//         });

//         // DISCONNECTED handler
//         client.on('disconnected', async (reason) => {
//             console.log(`❌ Client disconnected for session ${sessionId}:`, reason);
//             try {
//                 await Session.findOneAndUpdate(
//                     { sessionId },
//                     { status: 'disconnected', errorMessage: reason, disconnectedAt: new Date() }
//                 );
//             } catch (err) {
//                 console.error('❌ Error updating session after disconnect:', err);
//             } finally {
//                 clients.delete(sessionId);
//             }
//         });

//         // AUTH FAILURE handler
//         client.on('auth_failure', async (msg) => {
//             console.log(`❌ AUTH FAILURE for session ${sessionId}:`, msg);
//             try {
//                 await Session.findOneAndUpdate(
//                     { sessionId },
//                     { status: 'auth_failed', errorMessage: msg, updatedAt: new Date() }
//                 );
//             } catch (err) {
//                 console.error('❌ Error updating session after auth failure:', err);
//             } finally {
//                 clients.delete(sessionId);
//             }
//         });

//         // START THE CLIENT
//         await client.initialize();

//         // Return client to caller
//         return client;
//     } catch (err) {
//         console.error('❌ Error creating bot session:', err);
//         throw err; // REQUIRED so server.js can detect failure
//     }
// }

// async function createBotSession(userId, sessionId, io) {
//     try {
//         let botPhoneNumber = null;
//         let botSelfId = null;
//         console.log('🤖 BOT: Creating bot session');
//     console.log('👤 User ID:', userId);
//     console.log('📱 Session ID:', sessionId);
//     console.log('🔍 BOT: io object exists?', !!io);

//     const user = await User.findById(userId);
//     const isAdmin =
//         user && (user.isAdmin || user.adminLevel !== 'none' || user.role === 'system_admin');

//     console.log(`🤖 Creating ${isAdmin ? 'ADMIN' : 'USER'} bot session`);
//     console.log(`👤 User: ${user?.email || 'Unknown'} | Admin: ${isAdmin}`);

//     // Create the WhatsApp client
//     const client = new Client({
//         authStrategy: new LocalAuth({
//             clientId: `${isAdmin ? 'admin' : 'user'}-${userId}-${sessionId}`,
//             dataPath: './.wwebjs_auth'
//         }),
//         puppeteer: {
//             ...clientConfig.puppeteer,
//             args: [
//                 ...clientConfig.puppeteer.args,
//                 '--no-sandbox',
//                 '--disable-setuid-sandbox',
//                 '--disable-gpu',
//                 '--disable-dev-shm-usage',
//                 '--no-first-run',
//                 '--no-zygote'
//             ],
//             handleSIGINT: false,
//             handleSIGTERM: false
//         },
//         takeoverOnConflict: true,
//         takeoverTimeoutMs: 5000,
//         syncFullHistory: false,
//         markOnlineOnConnect: false,
//         chatLoadingTimeoutMs: 15000,
//         sessionBackupSyncIntervalMs: 300000,
//         qrMaxRetries: clientConfig.qrMaxRetries,
//         authTimeoutMs: clientConfig.authTimeoutMs,
//         restartOnAuthFail: clientConfig.restartOnAuthFail
//     });

//     // Store client so we can access it later
//     clients.set(sessionId, client);

//     // ======================= EVENT HANDLERS ==========================

//     client.on('loading_screen', (percent, message) => {
//         console.log(`📱 ${isAdmin ? 'ADMIN' : 'USER'} DEBUG: Loading screen:`, percent + '%', message);
//     });

//     client.on('authenticated', (session) => {
//         console.log(`🔑 Authentication successful for session: ${sessionId}`);
//         try {
//             if (session && typeof session === 'object') {
//                 const sessionString = JSON.stringify(session);
//                 const phoneMatch = sessionString.match(/(\d{10,15})/);
//                 if (phoneMatch) {
//                     botPhoneNumber = phoneMatch[1];
//                     botSelfId = `${botPhoneNumber}@c.us`;
//                     console.log(`📱 Extracted phone number: ${botPhoneNumber}`);
//                 }
//             }
//         } catch (error) {
//             console.error('❌ Error extracting phone from session object:', error.message);
//         }

//         if (!botPhoneNumber && CONFIG.owner) {
//             botPhoneNumber = CONFIG.owner.replace(/[^0-9]/g, '');
//             botSelfId = `${botPhoneNumber}@c.us`;
//             console.log(`📱 Using config owner number: ${botPhoneNumber}`);
//         }
//     });

//     client.on('change_state', (state) => {
//         console.log(`📱 State changed to: ${state} for session: ${sessionId}`);
        
//         // Update last activity in database
//         Session.findOneAndUpdate(
//             { sessionId },
//             { lastActive: new Date() }
//         ).catch(err => console.error('Failed to update last activity:', err));
//     });

//     client.on('qr', async (qr) => {
//         console.log(`📱 QR CODE GENERATED for session: ${sessionId}`);
//         const roomName = isAdmin ? `admin-${userId}` : `user-${userId}`;

//         if (!io) {
//             console.error(`❌ io is undefined! Cannot emit QR for session: ${sessionId}`);
//             return;
//         }

//         // Emit to specific room
//         io.to(roomName).emit('qrCode', {
//             sessionId,
//             qr,
//             message: 'Scan this QR code with WhatsApp',
//             userId,
//             isAdmin,
//             userType: isAdmin ? 'admin' : 'user'
//         });

//         // Also broadcast as fallback
//         io.emit('qrCode', {
//             sessionId,
//             qr,
//             message: 'Scan this QR code with WhatsApp',
//             userId,
//             isAdmin,
//             userType: isAdmin ? 'admin' : 'user',
//             broadcast: true
//         });

//         console.log(`✅ QR code emitted for session: ${sessionId}`);
//     });

//     // ======================= READY EVENT ==========================
//     client.on('ready', async () => {
//         console.log('✅ BOT: WhatsApp client ready for session:', sessionId);

//         try {
//             // Add timeout protection
//             const readyTimeout = setTimeout(() => {
//                 console.error('❌ Ready event timeout for session:', sessionId);
//             }, 30000);

//             const selfId = client.info?.wid?._serialized;
//             const selfNumber = client.info?.wid?.user;
//             const uniqueId = crypto.randomBytes(4).toString('hex').toUpperCase();

//             if (!selfId || !selfNumber) {
//                 console.error('❌ Missing selfId or selfNumber in ready event for session:', sessionId);
//                 console.error('❌ Client info:', client.info);
//                 clearTimeout(readyTimeout);
//                 return;
//             }

//             client.selfId = selfId;
//             userSessions.set(selfId, sessionId);

//             console.log('📱 Self ID:', selfId);
//             console.log('📞 Phone:', selfNumber);
//             console.log('🆔 Session ID (unique):', uniqueId);

//             // Clear timeout since we got this far
//             clearTimeout(readyTimeout);

//             // Reload user from DB by whatsappNumber if possible, fallback to user
//             let userDoc;
//             try {
//                 userDoc = (await User.findOne({ whatsappNumber: selfNumber })) || user;
//                 console.log('✅ User document retrieved:', userDoc ? userDoc.email : 'No user found');
//             } catch (userErr) {
//                 console.error('❌ Failed to find user:', userErr);
//                 userDoc = user; // fallback to original user
//             }

//             // Create or update PhoneRecord (if PhoneRecord model exists)
//             try {
//                 let PhoneRecord;
//                 try {
//                     PhoneRecord = require('./models/PhoneRecord');
//                 } catch (modelErr) {
//                     console.log('⚠️ PhoneRecord model not found, skipping phone record creation');
//                     PhoneRecord = null;
//                 }

//                 if (PhoneRecord) {
//                     let phoneRecord = await PhoneRecord.findOne({ phone: selfNumber });
//                     if (!phoneRecord) {
//                         phoneRecord = await PhoneRecord.create({
//                             phone: selfNumber,
//                             usedByUserId: userDoc?._id || null,
//                             trialUsed: true,
//                             trialStartedAt: new Date(),
//                             trialExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
//                             firstCommandDone: false
//                         });
//                         console.log(`📌 PhoneRecord created for ${selfNumber}`);
//                     } else {
//                         if (!phoneRecord.usedByUserId && userDoc?._id) {
//                             phoneRecord.usedByUserId = userDoc._id;
//                             await phoneRecord.save();
//                             console.log(`🔧 PhoneRecord ${selfNumber} linked to user ${userDoc._id}`);
//                         }
//                     }
//                 }
//             } catch (phoneErr) {
//                 console.error('❌ PhoneRecord operation failed:', phoneErr.message);
//                 // Continue execution - this is not critical
//             }

//             // Update Session DB to connected
//             try {
//                 const sessionUpdate = await Session.findOneAndUpdate(
//                     { sessionId },
//                     {
//                         status: 'connected',
//                         phone: selfNumber,
//                         connectedAt: new Date(),
//                         updatedAt: new Date()
//                     },
//                     { upsert: false, new: true }
//                 );
                
//                 if (sessionUpdate) {
//                     console.log('✅ Session status updated to connected');
//                 } else {
//                     console.log('⚠️ Session not found in database for update');
//                 }
//             } catch (sErr) {
//                 console.error('❌ Could not update Session record on ready:', sErr.message);
//             }

//             // Send welcome messages with proper error handling
//             try {
//                 console.log('📤 Attempting to get self chat...');
//                 const chat = await client.getChatById(selfId);
//                 console.log('✅ Self chat retrieved successfully');

//                 // Send welcome message
//                 try {
//                     await chat.sendMessage(
//                         `🤖 *Bot Connected Successfully!*\n\n📱 *Your Session ID:* \`${uniqueId}\`\n📞 *Your Number:* ${selfNumber}\n\n⚡ *Status:* Ready for commands!`
//                     );
//                     console.log('✅ Welcome message sent');
//                 } catch (welcomeErr) {
//                     console.error('❌ Failed to send welcome message:', welcomeErr);
//                 }

//                 // Send subscription status message
//                 if (userDoc) {
//                     try {
//                         const subStatus = await checkUserSubscriptionStatus(userDoc._id);
//                         let statusMessage = '';
                        
//                         if (subStatus.isOwner) statusMessage = '👑 *Bot Owner Detected*';
//                         else if (subStatus.trial) statusMessage = `🎁 *Trial Active* (${subStatus.trialDaysLeft} days left)`;
//                         else if (subStatus.isExempted) statusMessage = '🛡️ *Payment Exemption Active*';
//                         else if (subStatus.isValid) statusMessage = '💳 *Subscription Active*';
//                         else statusMessage = '⚠️ *Subscription Required*';

//                         await chat.sendMessage(statusMessage);
//                         console.log('✅ Subscription status message sent');
//                     } catch (subErr) {
//                         console.error('❌ Failed to send subscription status:', subErr);
//                     }
//                 }

//                 // Send commands message
//                 try {
//                     if (typeof sendCommandsMessage === 'function') {
//                         await sendCommandsMessage(chat, !!(userDoc && (userDoc.isAdmin || userDoc.role === 'system_admin')), uniqueId);
//                         console.log('✅ Commands message sent via helper function');
//                     } else {
//                         await chat.sendMessage(
//                             `🔧 *Available Commands:*\n\n• !ping\n• !help\n• !status\n• !sessionid\n💡 Type commands here.`
//                         );
//                         console.log('✅ Default commands message sent');
//                     }
//                 } catch (helperErr) {
//                     console.error('❌ Failed to send commands message:', helperErr.message);
//                 }

//             } catch (chatErr) {
//                 console.error('❌ Failed to get self chat or send messages:', chatErr);
//             }

//             // Initialize session validation state
//             sessionValidated.set(sessionId, false);
//             console.log(`✅ Session validation state initialized for ${sessionId} (sessionValidated=false)`);

//             // Emit ready event to frontend
//             if (io) {
//                 try {
//                     const roomName = isAdmin ? `admin-${userId}` : `user-${userId}`;
//                     io.to(roomName).emit('sessionReady', {
//                         sessionId,
//                         phone: selfNumber,
//                         message: 'WhatsApp connected successfully!'
//                     });
//                     console.log('✅ Ready event emitted to frontend');
//                 } catch (ioErr) {
//                     console.error('❌ Failed to emit ready event:', ioErr);
//                 }
//             }

//             console.log(`✅ READY completed successfully for session ${sessionId}`);

//         } catch (err) {
//             console.error('❌ READY handler error for session', sessionId, ':', err);
//             console.error('❌ Error stack:', err.stack);
            
//             // Try to update session status to error
//             try {
//                 await Session.findOneAndUpdate(
//                     { sessionId },
//                     {
//                         status: 'error',
//                         errorMessage: err.message,
//                         updatedAt: new Date()
//                     }
//                 );
//             } catch (updateErr) {
//                 console.error('❌ Failed to update session error status:', updateErr);
//             }
//         }
//     });

//     // ======================= AUTH FAILURE HANDLER ==========================
//     client.on('auth_failure', async (message) => {
//         console.log('❌ Authentication failed for session:', sessionId, message);
        
//         try {
//             // Update session status in database
//             await Session.findOneAndUpdate(
//                 { sessionId },
//                 { 
//                     status: 'auth_failed',
//                     errorMessage: message,
//                     updatedAt: new Date()
//                 }
//             );
//             console.log('✅ Session status updated to auth_failed');
//         } catch (dbErr) {
//             console.error('❌ Failed to update auth failure status:', dbErr);
//         }
        
//         // Remove from active clients
//         clients.delete(sessionId);
        
//         // Clean up session data
//         if (client.selfId) {
//             userSessions.delete(client.selfId);
//         }
//         sessionValidated.delete(sessionId);
        
//         // Notify frontend
//         if (io) {
//             try {
//                 const roomName = isAdmin ? `admin-${userId}` : `user-${userId}`;
//                 io.to(roomName).emit('authFailure', {
//                     sessionId,
//                     message: 'WhatsApp authentication failed'
//                 });
//                 console.log('✅ Auth failure event emitted to frontend');
//             } catch (ioErr) {
//                 console.error('❌ Failed to emit auth failure event:', ioErr);
//             }
//         }
        
//         console.log(`🧹 Cleaned up session data for ${sessionId} after auth failure`);
//     });

//     // ======================= DISCONNECTION HANDLER ==========================
//     client.on('disconnected', async (reason) => {
//         console.log(`❌ Client disconnected for session ${sessionId}:`, reason);
        
//         try {
//             // Update session status in database
//             await Session.findOneAndUpdate(
//                 { sessionId },
//                 { 
//                     status: 'disconnected',
//                     errorMessage: reason,
//                     disconnectedAt: new Date()
//                 }
//             );
//             console.log('✅ Session status updated to disconnected');
//         } catch (dbErr) {
//             console.error('❌ Failed to update disconnect status:', dbErr);
//         }
        
//         // Clean up session data
//         clients.delete(sessionId);
//         if (client.selfId) {
//             userSessions.delete(client.selfId);
//         }
//         sessionValidated.delete(sessionId);
        
//         // Clear heartbeat interval if it exists
//         if (client.heartbeatInterval) {
//             clearInterval(client.heartbeatInterval);
//             console.log(`🧹 Cleared heartbeat interval for session ${sessionId}`);
//         }
        
//         // Notify frontend
//         if (io) {
//             try {
//                 const roomName = isAdmin ? `admin-${userId}` : `user-${userId}`;
//                 io.to(roomName).emit('sessionDisconnected', {
//                     sessionId,
//                     reason,
//                     message: 'WhatsApp session disconnected'
//                 });
//                 console.log('✅ Disconnect event emitted to frontend');
//             } catch (ioErr) {
//                 console.error('❌ Failed to emit disconnect event:', ioErr);
//             }
//         }
        
//         console.log(`🧹 Cleaned up session data for ${sessionId} after disconnect`);
//     });

//     // ======================= HEARTBEAT MONITORING ==========================
//     const heartbeatInterval = setInterval(() => {
//         if (client && client.info && client.info.wid) {
//             console.log(`💓 Session ${sessionId} heartbeat: ${client.info.wid.user || 'unknown'}`);
//         } else {
//             console.log(`💔 Session ${sessionId} heartbeat: client not ready`);
            
//             // If client is not ready for too long, you could add cleanup logic here
//             // For now, just log the issue
//         }
//     }, 60000); // Every minute

//     // Store the interval ID so we can clear it later
//     client.heartbeatInterval = heartbeatInterval;

//     // ======================= MESSAGE HANDLER ==========================
//     client.on('message', async (message) => {
//         try {
//             const selfId = client.selfId || client.info?.wid?._serialized;
//             const selfNumber = client.info?.wid?.user;
//             if (!selfId || !selfNumber) return;

//             const isSelfChat = message.fromMe && message.to === selfId;
//             if (!isSelfChat || !message.body || !message.body.startsWith('!')) return;

//             const raw = message.body.trim();
//             const command = raw.slice(1).split(' ')[0].toLowerCase();

//             console.log(`📨 Command received in session ${sessionId}: ${command}`);

//             await message.react('🤖');

//             const BASIC = new Set(['ping', 'help', 'status', 'sessionid']);
//             const TRIAL_ONLY = new Set(['tag', 'list']);

//             // Reload phoneRecord & user each message (keeps state fresh)
//             let phoneRecord;
//             let PhoneRecord;
//             try {
//                 PhoneRecord = require('./models/PhoneRecord');
//                 phoneRecord = await PhoneRecord.findOne({ phone: selfNumber });
//             } catch (modelErr) {
//                 console.log('⚠️ PhoneRecord model not available');
//                 phoneRecord = null;
//             }

//             const userDoc = await User.findOne({ whatsappNumber: selfNumber });
//             const userObjId = userDoc?._id;

//             if (!userDoc) {
//                 return await message.reply("⚠️ Error: User record not found.");
//             }

//             // 1) BASIC commands always allowed
//             if (BASIC.has(command)) {
//                 switch (command) {
//                     case 'ping': 
//                         return await message.reply('🏓 Pong!');
//                     case 'help':
//                         return await message.reply(
//                             `🤖 *Bot Commands*\n\n` +
//                             `• !ping — check if bot is alive\n` +
//                             `• !help — show help menu\n` +
//                             `• !status — check your bot account status\n` +
//                             `• !sessionid — show your session ID\n\n` +
//                              `🔸 *Trial Commands*: !tag, !list (available only during 7-day trial)\n` +
//                                 `🔸 *Paid Commands* depend on your subscription level\n`
//                             );
//                         case 'status': {
//                             const s = await checkUserSubscriptionStatus(userObjId);
//                             return await message.reply(
//                                 `📊 *Bot Status*\n\n` +
//                                 `📱 Number: ${selfNumber}\n` +
//                                 `🆔 Session ID: ${sessionId}\n` +
//                                 `📌 Status: ${s.reason || 'Unknown'}`
//                             );
//                         }
//                         case 'sessionid': 
//                             return await message.reply(`📱 *Session ID:* ${sessionId}`);
//                     }
//                 }

//                 // 2) Owner/exempt bypass
//                 const subStatus = await checkUserSubscriptionStatus(userObjId);
//                 if (subStatus.isOwner || subStatus.isExempted) {
//                     console.log(`👑 Admin/Owner access granted for command: ${command}`);
//                     return await message.reply(`👑 Admin/Owner access granted for *${command}*`);
//                 }

//                 const now = new Date();

//                 // 3) TRIAL active handling
//                 if (phoneRecord && phoneRecord.trialUsed && phoneRecord.usedByUserId?.toString() === userObjId?.toString()) {
//                     if (phoneRecord.trialExpiresAt && phoneRecord.trialExpiresAt > now) {
//                         if (TRIAL_ONLY.has(command)) {
//                             if (command === 'tag') {
//                                 const today = new Date().toISOString().slice(0, 10);
                                
//                                 // Check if TagUsage model exists
//                                 let TagUsage;
//                                 try {
//                                     TagUsage = require('./models/TagUsage');
//                                 } catch (modelErr) {
//                                     console.log('⚠️ TagUsage model not found, allowing command');
//                                     TagUsage = null;
//                                 }

//                                 if (TagUsage) {
//                                     let usage = await TagUsage.findOne({ phone: selfNumber, date: today });
//                                     if (!usage) {
//                                         usage = await TagUsage.create({ phone: selfNumber, date: today, tagsToday: 0 });
//                                     }
//                                     if (usage.tagsToday >= 3) {
//                                         return await message.reply(
//                                             `🚫 *Trial Limit Reached*\nYou can only tag **3 groups/day** during trial.\nUpgrade: ${process.env.DOMAIN}/payment`
//                                         );
//                                     }
//                                     usage.tagsToday++;
//                                     await usage.save();
//                                 }

//                                 // Mark firstCommand if not done
//                                 if (!phoneRecord.firstCommandDone) {
//                                     phoneRecord.firstCommandDone = true;
//                                     await phoneRecord.save();
//                                     sessionValidated.set(sessionId, true);
//                                     console.log(`🔓 Session ${sessionId} validated by first command (trial)`);
//                                 }
                                
//                                 const usageCount = TagUsage ? (await TagUsage.findOne({ phone: selfNumber, date: today }))?.tagsToday || 1 : 1;
//                                 return await message.reply(`📌 *TAG executed* (${usageCount}/3 today)`);
//                             }
                            
//                             if (command === 'list') {
//                                 if (!phoneRecord.firstCommandDone) {
//                                     phoneRecord.firstCommandDone = true;
//                                     await phoneRecord.save();
//                                     sessionValidated.set(sessionId, true);
//                                     console.log(`🔓 Session ${sessionId} validated by first command (trial)`);
//                                 }
//                                 return await message.reply('📃 *LIST executed (trial)*');
//                             }
//                         }
//                         // Trial active but command not allowed
//                         return await message.reply(`🚫 *Command not allowed during trial:* ${command}\nAvailable: !tag, !list`);
//                     }
//                 }

//                 // 4) Fraud-prevention: phone used on other account
//                 if (phoneRecord && phoneRecord.usedByUserId?.toString() !== userObjId?.toString()) {
//                     return await message.reply(
//                         `🚫 *Trial not available for this phone number*\nThis number already used a free trial on another account.\nSubscribe: ${process.env.DOMAIN}/payment`
//                     );
//                 }

//                 // 5) FIRST-COMMAND GRACE for expired users (and expired paid users)
//                 if (phoneRecord && !phoneRecord.firstCommandDone) {
//                     // Mark first command done and validate session, but only allow BASIC commands as an info step
//                     phoneRecord.firstCommandDone = true;
//                     await phoneRecord.save();
//                     sessionValidated.set(sessionId, true);
//                     console.log(`🔓 Session ${sessionId} validated by first command; periodic checks enabled for this session.`);

//                     if (!TRIAL_ONLY.has(command)) {
//                         return await message.reply(
//                             `ℹ️ *Welcome back!* Your free trial/subscription has expired.\n` +
//                             `You can use basic commands (ping/help/status/sessionid).\n` +
//                             `To continue using features, please subscribe:\n${process.env.DOMAIN}/payment`
//                         );
//                     }
//                 }

//                 // 6) Now enforce subscription for non-trial users
//                 if (!subStatus.isValid) {
//                     return await message.reply(
//                         `🚫 *Subscription Required*\nYour subscription is inactive. Renew: ${process.env.DOMAIN}/payment`
//                     );
//                 }

//                 // 7) Paid users - level based access
//                 const paidPlan = userDoc.subscription?.planType || 'starter';
//                 const PLAN_RULES = {
//                     starter: ['tag-basic', 'autoreply-basic'],
//                     professional: ['tag-advanced', 'list-advanced', 'autoreply', 'scheduler'],
//                     business: ['all'],
//                     enterprise: ['all']
//                 };

//                 if (!PLAN_RULES[paidPlan]) {
//                     return await message.reply('⚠️ Invalid subscription plan.');
//                 }

//                 if (PLAN_RULES[paidPlan][0] !== 'all' && !PLAN_RULES[paidPlan].includes(command)) {
//                     return await message.reply(
//                         `🚫 *Command not available in your plan (${paidPlan})*\nUpgrade: ${process.env.DOMAIN}/payment`
//                     );
//                 }

//                 // Paid command allowed
//                 console.log(`💎 Paid command executed: ${command} for session: ${sessionId}`);
//                 return await message.reply(`💎 *Paid command executed:* ${command}`);
                
//             } catch (err) {
//                 console.error('❌ Message handler error for session', sessionId, ':', err);
//                 await message.reply('❌ An error occurred while processing your command. Please try again.');
//             }
//         });

//         // ======================= START THE CLIENT ==========================
//         console.log('🚀 Initializing WhatsApp client for session:', sessionId);
//         await client.initialize();

//         console.log('✅ Client initialized successfully for session:', sessionId);
//         return client;

//     } catch (err) {
//         console.error('❌ Error creating bot session:', sessionId, err);
//         console.error('❌ Error stack:', err.stack);
        
//         // Clean up if client was created but failed
//         if (clients.has(sessionId)) {
//             clients.delete(sessionId);
//         }
        
//         // Update session status to failed
//         try {
//             await Session.findOneAndUpdate(
//                 { sessionId },
//                 {
//                     status: 'failed',
//                     errorMessage: err.message,
//                     updatedAt: new Date()
//                 }
//             );
//         } catch (dbErr) {
//             console.error('❌ Failed to update session failure status:', dbErr);
//         }
        
//         throw err; // REQUIRED so server.js can detect failure
//     }
// }

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
                    '--no-zygote',
                    '--disable-extensions',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding'
                ],
                handleSIGINT: false,
                handleSIGTERM: false
            },
            takeoverOnConflict: true,
            takeoverTimeoutMs: 10000, // Increased timeout
            syncFullHistory: false,
            markOnlineOnConnect: false,
            chatLoadingTimeoutMs: 30000, // Increased timeout
            sessionBackupSyncIntervalMs: 300000,
            qrMaxRetries: clientConfig.qrMaxRetries,
            authTimeoutMs: 60000, // Increased timeout
            restartOnAuthFail: clientConfig.restartOnAuthFail
        });

        // Store client so we can access it later
        clients.set(sessionId, client);

        // ======================= COMPREHENSIVE EVENT HANDLERS ==========================

        // Loading screen handler
        client.on('loading_screen', (percent, message) => {
            console.log(`📱 ${isAdmin ? 'ADMIN' : 'USER'} Loading: ${percent}% - ${message} (Session: ${sessionId})`);
            
            // Update session status during loading
            if (percent === 100) {
                console.log(`✅ Loading completed for session: ${sessionId}`);
            }
        });

        // Authentication handler
        client.on('authenticated', (session) => {
            console.log(`🔑 Authentication successful for session: ${sessionId}`);
            
            try {
                if (session && typeof session === 'object') {
                    const sessionString = JSON.stringify(session);
                    const phoneMatch = sessionString.match(/(\d{10,15})/);
                    if (phoneMatch) {
                        botPhoneNumber = phoneMatch[1];
                        botSelfId = `${botPhoneNumber}@c.us`;
                        console.log(`📱 Extracted phone number: ${botPhoneNumber}`);
                    }
                }
            } catch (error) {
                console.error('❌ Error extracting phone from session object:', error.message);
            }

            if (!botPhoneNumber && CONFIG.owner) {
                botPhoneNumber = CONFIG.owner.replace(/[^0-9]/g, '');
                botSelfId = `${botPhoneNumber}@c.us`;
                console.log(`📱 Using config owner number: ${botPhoneNumber}`);
            }
        });

        // State change handler with detailed logging
        client.on('change_state', (state) => {
            console.log(`📱 State changed to: ${state} for session: ${sessionId}`);
            
            // Log important state transitions
            if (state === 'CONNECTED') {
                console.log(`🟢 WhatsApp connected for session: ${sessionId}`);
            } else if (state === 'OPENING') {
                console.log(`🔄 WhatsApp opening for session: ${sessionId}`);
            } else if (state === 'PAIRING') {
                console.log(`🔗 WhatsApp pairing for session: ${sessionId}`);
            }
        });

        // QR code handler
        client.on('qr', async (qr) => {
            console.log(`📱 QR CODE GENERATED for session: ${sessionId}`);
            const roomName = isAdmin ? `admin-${userId}` : `user-${userId}`;

            if (!io) {
                console.error(`❌ io is undefined! Cannot emit QR for session: ${sessionId}`);
                return;
            }

            // Emit to specific room
            io.to(roomName).emit('qrCode', {
                sessionId,
                qr,
                message: 'Scan this QR code with WhatsApp',
                userId,
                isAdmin,
                userType: isAdmin ? 'admin' : 'user'
            });

            // Also broadcast as fallback
            io.emit('qrCode', {
                sessionId,
                qr,
                message: 'Scan this QR code with WhatsApp',
                userId,
                isAdmin,
                userType: isAdmin ? 'admin' : 'user',
                broadcast: true
            });

            console.log(`✅ QR code emitted for session: ${sessionId}`);
        });

        // ======================= READY EVENT WITH ENHANCED DEBUGGING ==========================
        client.on('ready', async () => {
            console.log('🎉 ===== READY EVENT FIRED =====');
            console.log('✅ BOT: WhatsApp client ready for session:', sessionId);

            try {
                // Add timeout protection
                const readyTimeout = setTimeout(() => {
                    console.error('❌ Ready event processing timeout for session:', sessionId);
                }, 45000); // Increased to 45 seconds

                console.log('🔍 Checking client info...');
                const selfId = client.info?.wid?._serialized;
                const selfNumber = client.info?.wid?.user;
                const uniqueId = crypto.randomBytes(4).toString('hex').toUpperCase();

                console.log('📊 Client info debug:', {
                    hasInfo: !!client.info,
                    hasWid: !!client.info?.wid,
                    selfId: selfId || 'MISSING',
                    selfNumber: selfNumber || 'MISSING'
                });

                if (!selfId || !selfNumber) {
                    console.error('❌ Missing selfId or selfNumber in ready event for session:', sessionId);
                    console.error('❌ Full client info:', JSON.stringify(client.info, null, 2));
                    clearTimeout(readyTimeout);
                    return;
                }

                client.selfId = selfId;
                userSessions.set(selfId, sessionId);

                console.log('📱 Self ID:', selfId);
                console.log('📞 Phone:', selfNumber);
                console.log('🆔 Session ID (unique):', uniqueId);

                // Clear timeout since we got this far
                clearTimeout(readyTimeout);

                // Update session in database first
                try {
                    const sessionUpdate = await Session.findOneAndUpdate(
                        { sessionId },
                        {
                            status: 'connected',
                            phone: selfNumber,
                            connectedAt: new Date(),
                            updatedAt: new Date()
                        },
                        { upsert: false, new: true }
                    );
                    
                    if (sessionUpdate) {
                        console.log('✅ Session status updated to connected in database');
                    } else {
                        console.log('⚠️ Session not found in database for update');
                    }
                } catch (sErr) {
                    console.error('❌ Could not update Session record on ready:', sErr.message);
                }

                // Get user document
                let userDoc;
                try {
                    userDoc = (await User.findOne({ whatsappNumber: selfNumber })) || user;
                    console.log('✅ User document retrieved:', userDoc ? userDoc.email : 'No user found');
                } catch (userErr) {
                    console.error('❌ Failed to find user:', userErr);
                    userDoc = user;
                }

                // Initialize session validation state
                sessionValidated.set(sessionId, false);
                console.log(`✅ Session validation state initialized for ${sessionId} (sessionValidated=false)`);

                // Send welcome messages with comprehensive error handling
                try {
                    console.log('📤 Attempting to get self chat...');
                    
                    // Add retry logic for getting chat
                    let chat;
                    let retryCount = 0;
                    const maxRetries = 3;
                    
                    while (retryCount < maxRetries) {
                        try {
                            chat = await client.getChatById(selfId);
                            console.log('✅ Self chat retrieved successfully');
                            break;
                        } catch (chatErr) {
                            retryCount++;
                            console.log(`⚠️ Chat retrieval attempt ${retryCount}/${maxRetries} failed:`, chatErr.message);
                            if (retryCount < maxRetries) {
                                await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
                            }
                        }
                    }

                    if (!chat) {
                        throw new Error('Failed to retrieve self chat after all retries');
                    }

                    // Send welcome message
                    try {
                        await chat.sendMessage(
                            `🤖 *Bot Connected Successfully!*\n\n📱 *Your Session ID:* \`${uniqueId}\`\n📞 *Your Number:* ${selfNumber}\n\n⚡ *Status:* Ready for commands!`
                        );
                        console.log('✅ Welcome message sent successfully');
                    } catch (welcomeErr) {
                        console.error('❌ Failed to send welcome message:', welcomeErr);
                    }

                    // Send subscription status message
                    if (userDoc) {
                        try {
                            const subStatus = await checkUserSubscriptionStatus(userDoc._id);
                            let statusMessage = '';
                            
                            if (subStatus.isOwner) statusMessage = '👑 *Bot Owner Detected*';
                            else if (subStatus.trial) statusMessage = `🎁 *Trial Active* (${subStatus.trialDaysLeft} days left)`;
                            else if (subStatus.isExempted) statusMessage = '🛡️ *Payment Exemption Active*';
                            else if (subStatus.isValid) statusMessage = '💳 *Subscription Active*';
                            else statusMessage = '⚠️ *Subscription Required*';

                            await chat.sendMessage(statusMessage);
                            console.log('✅ Subscription status message sent');
                        } catch (subErr) {
                            console.error('❌ Failed to send subscription status:', subErr);
                        }
                    }

                    // Send commands message
                    try {
                        await chat.sendMessage(
                            `🔧 *Available Commands:*\n\n• !ping\n• !help\n• !status\n• !sessionid\n💡 Type commands here.`
                        );
                        console.log('✅ Commands message sent');
                    } catch (cmdErr) {
                        console.error('❌ Failed to send commands message:', cmdErr);
                    }

                } catch (chatErr) {
                    console.error('❌ Failed to get self chat or send messages:', chatErr);
                }

                // Emit ready event to frontend
                if (io) {
                    try {
                        const roomName = isAdmin ? `admin-${userId}` : `user-${userId}`;
                        io.to(roomName).emit('sessionReady', {
                            sessionId,
                            phone: selfNumber,
                            message: 'WhatsApp connected successfully!'
                        });
                        console.log('✅ Ready event emitted to frontend');
                    } catch (ioErr) {
                        console.error('❌ Failed to emit ready event:', ioErr);
                    }
                }

                console.log('🎉 ===== READY EVENT COMPLETED SUCCESSFULLY =====');
                console.log(`✅ Session ${sessionId} is now fully operational`);

            } catch (err) {
                console.error('❌ READY handler error for session', sessionId, ':', err);
                console.error('❌ Error stack:', err.stack);
            }
        });

        // ======================= OTHER EVENT HANDLERS ==========================

        // Auth failure handler
        client.on('auth_failure', async (message) => {
            console.log('❌ Authentication failed for session:', sessionId, message);
            
            try {
                await Session.findOneAndUpdate(
                    { sessionId },
                    { 
                        status: 'auth_failed',
                        errorMessage: message,
                        updatedAt: new Date()
                    }
                );
            } catch (dbErr) {
                console.error('❌ Failed to update auth failure status:', dbErr);
            }
            
            clients.delete(sessionId);
            if (client.selfId) userSessions.delete(client.selfId);
            sessionValidated.delete(sessionId);
        });

        // Disconnection handler
        client.on('disconnected', async (reason) => {
            console.log(`❌ Client disconnected for session ${sessionId}:`, reason);
            
            try {
                await Session.findOneAndUpdate(
                    { sessionId },
                    { 
                        status: 'disconnected',
                        errorMessage: reason,
                        disconnectedAt: new Date()
                    }
                );
            } catch (dbErr) {
                console.error('❌ Failed to update disconnect status:', dbErr);
            }
            
            clients.delete(sessionId);
            if (client.selfId) userSessions.delete(client.selfId);
            sessionValidated.delete(sessionId);
            
            if (client.heartbeatInterval) {
                clearInterval(client.heartbeatInterval);
            }
        });

        // Enhanced heartbeat monitoring
        const heartbeatInterval = setInterval(() => {
            if (client && client.info && client.info.wid) {
                console.log(`💚 Session ${sessionId} heartbeat: ${client.info.wid.user || 'unknown'} - HEALTHY`);
            } else {
                console.log(`💔 Session ${sessionId} heartbeat: client not ready`);
            }
        }, 60000);

        client.heartbeatInterval = heartbeatInterval;

        // ======================= MESSAGE HANDLER ==========================
        client.on('message', async (message) => {
            try {
                const selfId = client.selfId || client.info?.wid?._serialized;
                const selfNumber = client.info?.wid?.user;
                if (!selfId || !selfNumber) return;

                const isSelfChat = message.fromMe && message.to === selfId;
                if (!isSelfChat || !message.body || !message.body.startsWith('!')) return;

                const command = message.body.slice(1).split(' ')[0].toLowerCase();
                console.log(`📨 Command received in session ${sessionId}: ${command}`);

                await message.react('🤖');

                // Basic commands
                switch (command) {
                    case 'ping':
                        return await message.reply('🏓 Pong!');
                    case 'help':
                        return await message.reply('🤖 *Bot Commands*\n\n• !ping\n• !help\n• !status\n• !sessionid');
                    case 'status':
                        return await message.reply(`🤖 *Bot Status*\n\n📱 Number: ${selfNumber}\n🆔 Session: ${sessionId}\n⏱️ Uptime: ${Math.floor(process.uptime())}s`);
                    case 'sessionid':
                        return await message.reply(`📱 *Session ID:* ${sessionId}`);
                    default:
                        return await message.reply(`❌ Unknown command: *${command}*`);
                }
                
            } catch (err) {
                console.error('❌ Message handler error for session', sessionId, ':', err);
            }
        });

        // ======================= START THE CLIENT ==========================
        console.log('🚀 Initializing WhatsApp client for session:', sessionId);
        
        // Set a timeout to detect if initialization hangs
        const initTimeout = setTimeout(() => {
            console.error('❌ Client initialization timeout for session:', sessionId);
        }, 120000); // 2 minutes

        await client.initialize();
        clearTimeout(initTimeout);

        console.log('✅ Client initialized successfully for session:', sessionId);
        return client;

    } catch (err) {
        console.error('❌ Error creating bot session:', sessionId, err);
        console.error('❌ Error stack:', err.stack);
        
        if (clients.has(sessionId)) {
            clients.delete(sessionId);
        }
        
        try {
            await Session.findOneAndUpdate(
                { sessionId },
                {
                    status: 'failed',
                    errorMessage: err.message,
                    updatedAt: new Date()
                }
            );
        } catch (dbErr) {
            console.error('❌ Failed to update session failure status:', dbErr);
        }
        
        throw err;
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


// Also check on startup
setTimeout(periodicSubscriptionCheck, 120000); // Check 30 seconds after startup

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



