const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const qrcode = require('qrcode-terminal');
const Contact = require('./models/Contact');
const User = require('./models/User');
const PhoneRecord = require('./models/PhoneRecord');
const Session = require('./models/Session');
const TagUsage = require('./models/TagUsage');

const puppeteer = require('puppeteer'); // ensure installed and up-to-date
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

require('events').EventEmitter.defaultMaxListeners = 1000;

const sessionValidated = new Map();

// ----------------- CONFIG -----------------
const getDefaultPath = (dirName) => path.join(__dirname, dirName);

const CONFIG = {
  sessionDataPath: getDefaultPath('sessions'),
  mediaPath: getDefaultPath('media'),
  authPath: getDefaultPath('auth'),   // kept for backward compatibility though LocalAuth is used
  adminSettings: {
    selfChatOnly: false,
    secondaryAdmins: {}
  },
  prefix: '!',
  maxSessions: 1000,
  owner: undefined, // fill with owner number in config.json if you want
  allowedUsers: []
};

// load config.json if present (non-destructive)
try {
  const cfgPath = path.join(__dirname, 'config.json');
  if (fs.existsSync(cfgPath)) {
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    // shallow merge, keep defaults if missing
    Object.assign(CONFIG, raw);
    CONFIG.adminSettings = { ...CONFIG.adminSettings, ...(raw.adminSettings || {}) };
    console.log('Loaded configuration from config.json');
  } else {
    console.warn('config.json not found — using defaults');
  }
} catch (err) {
  console.warn('Failed to load config.json, using defaults:', err.message);
}

// ensure directories exist
const requiredDirs = [
  CONFIG.sessionDataPath,
  CONFIG.mediaPath,
  CONFIG.authPath
];

for (const d of requiredDirs) {
  try {
    if (!d || typeof d !== 'string') throw new Error('Invalid path');
    fs.mkdirSync(d, { recursive: true });
  } catch (err) {
    console.error('FATAL: Could not create directory', d, err.message);
    process.exit(1);
  }
}

// ----------------- CONSTANTS & STATE -----------------
const SESSION_DIR = CONFIG.sessionDataPath;
const MEDIA_DIR = CONFIG.mediaPath;
const COMMAND_PREFIX = CONFIG.prefix || '!';
const MAX_SESSIONS_DEFAULT = CONFIG.maxSessions || 1000;

const mediaPath = {
  audio: path.join(MEDIA_DIR, 'audio.mp3'),
  document: path.join(MEDIA_DIR, 'document.pdf'),
  image: path.join(MEDIA_DIR, 'image.jpg')
};

const clients = new Map();            // sessionId => client
const userSessions = new Map();       // selfId => sessionUniqueId (for quick lookup)
const savedContactsFile = path.join(SESSION_DIR, 'saved_contacts.json');
const savedContacts = new Set(fs.existsSync(savedContactsFile) ? JSON.parse(fs.readFileSync(savedContactsFile, 'utf8')) : []);

const logger = {
  info: (m) => console.log(`[${new Date().toISOString()}] INFO: ${m}`),
  error: (m, e) => console.error(`[${new Date().toISOString()}] ERROR: ${m}`, e || '')
};

// authorized numbers
const authorizedNumbers = new Set();
if (CONFIG.owner) {
  let ownerNumber = CONFIG.owner;
  if (!ownerNumber.includes('@')) ownerNumber = `${ownerNumber.replace(/[^0-9]/g, '')}@c.us`;
  authorizedNumbers.add(ownerNumber);
  logger.info(`Added owner to authorizedNumbers: ${ownerNumber}`);
}
if (Array.isArray(CONFIG.allowedUsers)) {
  for (const u of CONFIG.allowedUsers) {
    let num = u;
    if (!num.includes('@')) num = `${num.replace(/[^0-9]/g,'')}@c.us`;
    authorizedNumbers.add(num);
  }
  logger.info(`Loaded ${CONFIG.allowedUsers.length || 0} allowed users`);
}

const isPrimaryAdmin = (userId) => authorizedNumbers.has(userId);
const isSecondaryAdmin = (userId) => {
  if (!CONFIG.adminSettings?.secondaryAdmins) return false;
  const clean = userId.replace('@c.us','');
  return CONFIG.adminSettings.secondaryAdmins[clean]?.enabled === true;
};
const isAuthorized = (userId) => isPrimaryAdmin(userId) || isSecondaryAdmin(userId);

// ----------------- HELPERS -----------------
function createClientOptions(sessionId) {
  // Detect platform: on Windows prefer headless:false for dev; on Linux default headless true
  const isWindows = process.platform === 'win32';
  const headless = !isWindows; // dev convenience: show browser on Windows

  const puppeteerArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage'
  ];
  if (!isWindows) {
    // on linux we can add single-process / no-zygote if needed by environment; leave minimal for portability
    puppeteerArgs.push('--disable-gpu');
  }

  return {
    authStrategy: new LocalAuth({ clientId: `session-${sessionId}` }),
    puppeteer: {
      headless: false,  // show Chrome window, more stable on Windows
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ],
      defaultViewport: null
    },
    takeoverOnConflict: true,
    restartOnAuthFail: true
  };
}

async function saveContactsToDisk() {
  try {
    fs.writeFileSync(savedContactsFile, JSON.stringify([...savedContacts], null, 2));
    logger.info('Saved contacts file updated');
  } catch (err) {
    logger.error('Failed to write saved contacts file', err);
  }
}

async function saveNewContact(client, phoneNumber, name = null) {
  try {
    if (savedContacts.has(phoneNumber)) {
      logger.info(`Contact ${phoneNumber} already saved`);
      return false;
    }
    // Use page evaluate via client to call WWebJS contactAdd if available
    if (client.pupPage && client.pupPage.evaluate) {
      await client.pupPage.evaluate((contact, displayName) => {
        // This uses the internal WWebJS function if present
        // eslint-disable-next-line no-undef
        return window.WWebJS?.contactAdd ? window.WWebJS.contactAdd(contact, displayName) : null;
      }, phoneNumber, name || `Contact ${phoneNumber}`);
      savedContacts.add(phoneNumber);
      await saveContactsToDisk();
      logger.info(`Saved new contact: ${phoneNumber}`);
      return true;
    } else {
      logger.error('client.pupPage is not available to add contact');
      return false;
    }
  } catch (err) {
    logger.error(`Failed to save contact ${phoneNumber}`, err);
    return false;
  }
}

// ----------------- SESSION / CLIENT CREATION -----------------
function createClient(sessionId) {
  const opts = createClientOptions(sessionId);
  const client = new Client(opts);

  // remove any previous listeners (defensive)
  client.removeAllListeners();
  setupClientEvents(client, sessionId);
  return client;
}

// FIX: Add the missing createSession function
function createSession(sessionId) {
  try {
    logger.info(`Creating session: ${sessionId}`);
    const client = createClient(sessionId);
    clients.set(sessionId, client);
    client.initialize().catch(err => {
      logger.error(`Failed to initialize client ${sessionId}:`, err);
      clients.delete(sessionId);
    });
    return sessionId;
  } catch (err) {
    logger.error('Failed to create session', err);
    throw err;
  }
}

function createNewSession() {
  try {
    const sessionId = Date.now().toString();
    return createSession(sessionId);
  } catch (err) {
    logger.error('Failed to create new session', err);
  }
}

// ----------------- EVENT HANDLERS -----------------
function setupClientEvents(client, sessionId) {
  let keepAliveInterval = null;

  client.on('qr', (qr) => {
    console.log(`📱 QR CODE GENERATED for session: ${sessionId}`);
    
    // Emit to frontend dashboard
    if (global.io) {
        // Extract userId from sessionId (format: session-userId-timestamp)
        const userIdMatch = sessionId.match(/session-([^-]+)-/);
        const userId = userIdMatch ? userIdMatch[1] : 'unknown';
        const roomName = `user-${userId}`;
        
        global.io.to(roomName).emit('qrCode', {
            sessionId,
            qr,
            message: 'Scan this QR code with WhatsApp',
            userId,
            userType: 'user',
            broadcast: true
        });
        
        // Also global broadcast
        global.io.emit('qrCode', {
            sessionId,
            qr,
            broadcast: true,
            message: 'Scan this QR code'
        });
        
        console.log(`✅ QR emitted to dashboard for user: ${userId}`);
    } else {
        console.error('❌ global.io not available - cannot emit QR to dashboard');
    }
    
    // Also show in terminal for debugging
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => {
    logger.info(`Session ${sessionId}: authenticated`);
  });

  client.on('auth_failure', (err) => {
    logger.error(`Session ${sessionId}: auth failure`, err);
  });

  client.on('ready', async () => {
    logger.info(`Session ${sessionId}: ready`);
    try {
      // Wait until client.info.wid is available (max 1.5s)
      for (let i = 0; i < 15; i++) {
        if (client.info?.wid?._serialized) break;
        await new Promise(r => setTimeout(r, 100));
      }
      const selfId = client.info?.wid?._serialized;
      if (!selfId) {
        logger.error(`Session ${sessionId}: client.info not available after ready`);
        return;
      }

  // client.on('ready', async () => {
  //   console.log(`🎉 READY EVENT FIRED for session: ${sessionId}`);
  //   logger.info(`Session ${sessionId}: ready`);
    
  //   try {
  //       console.log(`🔍 Waiting for client.info.wid...`);
        
  //       // Wait until client.info.wid is available (max 1.5s)
  //       for (let i = 0; i < 15; i++) {
  //           if (client.info?.wid?._serialized) {
  //               console.log(`✅ client.info.wid found after ${i * 100}ms`);
  //               break;
  //           }
  //           await new Promise(r => setTimeout(r, 100));
  //       }
        
  //       const selfId = client.info?.wid?._serialized;
  //       if (!selfId) {
  //           console.error(`❌ Session ${sessionId}: client.info not available after ready`);
  //           logger.error(`Session ${sessionId}: client.info not available after ready`);
  //           return;
  //       }

  //       console.log(`📱 Self ID: ${selfId}`);
      // store mapping
      const uniqueId = crypto.randomBytes(4).toString('hex').toUpperCase();
      userSessions.set(selfId, uniqueId);

      // FIX: Move session validation here (inside ready event)
      sessionValidated.set(sessionId, true);
      console.log(`🔓 Session ${sessionId} validated - ready for commands`);

      // send welcome messages to self chat
      try {
        await client.sendMessage(selfId, `🤖 *BOT CONNECTED* — Session: ${sessionId}`);
        await new Promise(r => setTimeout(r, 300));
        await client.sendMessage(selfId,
          `👋 Hello! This account is now connected.\n*Available Commands (self-chat only):*\n${COMMAND_PREFIX}ping\n${COMMAND_PREFIX}help\n${COMMAND_PREFIX}status\n${COMMAND_PREFIX}sessionid`
        );
        logger.info(`Session ${sessionId}: welcome messages sent to ${selfId}`);
      } catch (err) {
        logger.error(`Session ${sessionId}: failed to send welcome messages`, err);
      }

      // keep-alive
      keepAliveInterval = setInterval(async () => {
        try {
          await client.getState();
          logger.info(`Session ${sessionId}: keep-alive OK`);
        } catch (err) {
          logger.error(`Session ${sessionId}: keep-alive failed`, err);
        }
      }, 300000);

    } catch (err) {
      logger.error(`Session ${sessionId}: ready handler error`, err);
      // try to recover by destroying and creating new session
      setTimeout(async () => {
        try {
          await client.destroy();
        } catch (_) {}
        clients.delete(sessionId);
        createNewSession();
      }, 5000);
    }
  });

  client.on('disconnected', (reason) => {
    logger.info(`Session ${sessionId}: disconnected (${reason})`);
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    clients.delete(sessionId);
    sessionValidated.delete(sessionId); // Clean up validation
  });

  // call handling
  client.on('call', async (call) => {
    try {
      const caller = call.from;
      logger.info(`Session ${sessionId}: incoming ${call.isVideo ? 'video' : 'voice'} call from ${caller}`);

      // auto save contact if unknown
      const contact = await client.getContactById(caller);
      if (!contact.name || contact.name === contact.pushname || contact.name === caller.split('@')[0]) {
        const saved = await saveNewContact(client, caller, contact.pushname || null);
        if (saved) {
          for (const adminNumber of authorizedNumbers) {
            try {
              const adminChat = await client.getChatById(adminNumber);
              await adminChat.sendMessage(`📞 New contact saved: ${caller} (${contact.pushname || 'Unknown'})`);
            } catch (err) {
              logger.error('Failed to notify admin about saved contact', err);
            }
          }
        }
      }
    } catch (err) {
      logger.error('Call handler error', err);
    }
  });

  // message handlers: split message_create and message (incoming)
client.on('message_create', async (message) => {
  try {
    if (!message.body || message.from === 'status@broadcast') return;

    const selfId = client.info?.wid?._serialized;
    if (!selfId) return;

    // true sender detection (self-chat compatible)
    const sender = message.fromMe ? selfId : message.from;
    const isSelfChat = sender === selfId;

    // react to group messages (optional)
    if (!message.fromMe) {
      const chat = await message.getChat();
      if (chat.isGroup && chat.participants.some(p => p.id._serialized === selfId)) {
        try { await message.react("🚗"); } catch {}
      }
    }

    // only commands should continue
    if (!message.body.startsWith(COMMAND_PREFIX)) return;

    // allow ONLY:
    // - self chat
    // - authorized users
    if (!isSelfChat && !isAuthorized(sender)) {
      await message.reply("🔒 Admin-only command");
      return;
    }

    // parse command
    const [cmd, ...args] = message.body
      .slice(COMMAND_PREFIX.length)
      .trim()
      .split(/\s+/);

   switch (cmd.toLowerCase()) {

  case "ping":
    await message.reply("🏓 Pong!");
    break;

  case "help":
    await message.reply(
      `*Available Commands:*\n` +
      `!ping\n` +
      `!help\n` +
      `!status\n` +
      `!sessionid\n` +
      `!tag\n` +
      `!tagexcept`
    );
    break;

  case "status":
    await message.reply(
      `*Bot Status:*\n` +
      `Uptime: ${Math.floor(process.uptime() / 60)} minutes\n` +
      `Sessions: ${clients.size}`
    );
    break;

  case "sessionid":
    await message.reply(
      `Your Session ID: ${userSessions.get(selfId) || "N/A"}`
    );
    break;


  /* ====================================================
     TAG EVERYONE  (Self-chat safe)
     ==================================================== */
  case "tag": {
    const chat = await message.getChat();

    if (!chat.isGroup) {
      await message.reply("❌ This command only works in groups.\nSend it inside a group.");
      return;
    }

    let text = "*Group Mentions:*\n\n";
    let mentions = [];

    for (let participant of chat.participants) {
      const jid = participant.id._serialized;
      mentions.push(await client.getContactById(jid));
      text += `mention (${jid.split("@")[0]})\n`;
    }

    await chat.sendMessage(text, { mentions });
    break;
  }


  /* ====================================================
     TAG EXCEPT  (Self-chat safe)
     Format: !tagexcept 1,2,3 @2345,@554433
     ==================================================== */
  case "tagexcept": {
    const chat = await message.getChat();

    if (!chat.isGroup) {
      await message.reply("❌ This command only works in groups.\nMove to a group to use it.");
      return;
    }

    if (args.length < 1) {
      await message.reply("Usage:\n!tagexcept 1,2,3 @23455,@889922");
      return;
    }

    // group number list
    let groupsToTag = args[0]
      .split(",")
      .map(x => parseInt(x.trim()))
      .filter(n => !isNaN(n));

    // excluded numbers
    let excludedRaw = args.slice(1).join(" ");
    let excluded = excludedRaw
      .split("@")
      .filter(x => x.trim() !== "")
      .map(x => x.replace(/[^0-9]/g, "") + "@c.us");

    const allMembers = chat.participants.map(p => p.id._serialized);

    let text = "*Filtered Mentions:*\n\n";
    let mentions = [];

    for (let num of groupsToTag) {
      let memberJid = allMembers[num - 1]; // 1-indexed
      if (!memberJid) continue;
      if (excluded.includes(memberJid)) continue;

      mentions.push(await client.getContactById(memberJid));
      text += `mention (${memberJid.split("@")[0]})\n`;
    }

    await chat.sendMessage(text, { mentions });
    break;
  }


  default:
    await message.reply("Unknown command. Try !help");
}


  } catch (err) {
    logger.error("message_create command error", err);
  }
});


  // handle other client events (optional)
  client.on('error', (err) => {
    logger.error(`Session ${sessionId} client error:`, err);
  });
}

// Multi-session function for dashboard integration
async function createBotSession(userId, sessionId, io) {
    try {
        console.log('🤖 BOT: Creating bot session');
        console.log('👤 User ID:', userId);
        console.log('📱 Session ID:', sessionId);
        console.log('🔍 BOT: io object exists?', !!io);

        // Set global.io if not already set
        if (io && !global.io) {
            global.io = io;
        }

        // FIX: Use createSession instead of non-existent function
        const createdSessionId = createSession(sessionId);
        
        console.log('✅ Bot session created successfully');
        
        // Return the client for compatibility
        return clients.get(sessionId);
        
    } catch (error) {
        console.error('❌ Error creating bot session:', error);
        throw error;
    }
}

// exported API
module.exports = {
  start: (count = 1) => {
    // existing start code
    for (let i = 0; i < count; i++) {
      createSession(`session-${Date.now()}-${i}`);
    }
  },
  createBotSession,  // Add this for dashboard integration
  clients,           // Export clients map
  userSessions,      // Export user sessions
  createSession      // FIX: Export the createSession function
};

// ----------------- CLEAN SHUTDOWN -----------------
let isShuttingDown = false;
async function gracefulShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info('Shutting down all clients...');
  for (const client of clients.values()) {
    try {
      await client.destroy();
    } catch (err) {
      logger.error('Error destroying client', err);
    }
  }
  process.exit(0);
}

process.once('SIGINT', gracefulShutdown);
process.once('SIGTERM', gracefulShutdown);
process.once('SIGHUP', gracefulShutdown);

// ADD THIS AUTO-START CODE HERE:
if (require.main === module) {
    console.log('🚀 Starting WhatsApp Bot...');
    module.exports.start(1); // Start with 1 session for testing
}