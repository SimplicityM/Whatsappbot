const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const qrcode = require('qrcode-terminal');
const { Client, MessageMedia } = require('whatsapp-web.js');
const mongoose = require('mongoose');
const MongoStore = require('./MongoDBAuth');
const SessionAuth = require('./models/SessionAuth');
const Contact = require('./models/Contact');
const PhoneRecord = require('./models/PhoneRecord');
const Session = require('./models/Session');
const TagUsage = require('./models/TagUsage');
const Usage = require('./models/Usage');
const SavedGroupList = require('./models/SavedGroupList');
const ActiveGroup = require('./models/ActiveGroup');
const GroupMembers = require('./models/GroupMembers');
const AutoReply = require('./models/AutoReply');
const config = require('./config');
const RestorationMonitor = require('./restorationMonitor');


// Create a global monitor instance
const restorationMonitor = new RestorationMonitor();

const BASE_AUTH_PATH = path.join(__dirname, '..', '.wwebjs_auth'); 
// or use process.cwd() if bot.js is not in worker folder
// console.log("Auth path:", BASE_AUTH_PATH);


// bot.js (multi-session, isolated per-client implementation)
// - Exports createBotSession, restoreAllSessions, start (dev helper) and clients map
// - Requires separate Mongoose models (listed after this file)
// - Uses LocalAuth with clientId=sessionId so sessions persist and DO NOT log out on server restart

// =========================
// GROUP MEMBER DB HELPERS
// =========================

// Save full member list for a group
async function setMembersForGroup(sessionId, groupId, memberJids = []) {
    try {
        await GroupMembers.updateOne(
            { sessionId, groupId },
            { $set: { members: memberJids, updatedAt: new Date() } },
            { upsert: true }
        );
    } catch (err) {
        console.error(`[${sessionId}] Failed to set members for group ${groupId}:`, err);
    }
}

// Add/update one member
async function addMemberToGroup(sessionId, groupId, jid) {
    try {
        await GroupMembers.updateOne(
            { sessionId, groupId },
            { $addToSet: { members: jid }, $set: { updatedAt: new Date() } },
            { upsert: true }
        );
    } catch (err) {
        console.error(`[${sessionId}] Failed to add member ${jid}:`, err);
    }
}

// Remove a member
async function removeMemberFromGroup(sessionId, groupId, jid) {
    try {
        await GroupMembers.updateOne(
            { sessionId, groupId },
            { $pull: { members: jid }, $set: { updatedAt: new Date() } }
        );
    } catch (err) {
        console.error(`[${sessionId}] Failed to remove member ${jid}:`, err);
    }
}

// Read stored members
async function getMembersFromDB(sessionId, groupId) {
    try {
        const doc = await GroupMembers.findOne({ sessionId, groupId }).lean();
        return doc?.members || [];
    } catch (err) {
        console.error(`[${sessionId}] Failed to fetch members for group ${groupId}:`, err);
        return [];
    }
}

// Add this function near the top of the file
async function trackDailyUsage(userId, type = 'message') {
    try {
        const today = new Date().toISOString().split('T')[0];
        
        if (type === 'message') {
            await Usage.findOneAndUpdate(
                { userId, date: today },
                { 
                    $inc: { messagesCount: 1 },
                    $setOnInsert: { 
                        commandsUsed: [],
                        sessionsActive: 0,
                        groupsManaged: 0
                    }
                },
                { upsert: true }
            );
        } else if (type === 'command') {
            await Usage.findOneAndUpdate(
                { userId, date: today },
                { 
                    $push: { 
                        commandsUsed: {
                            command: type,
                            timestamp: new Date(),
                            sessionId
                        }
                    },
                    $setOnInsert: { 
                        messagesCount: 0,
                        sessionsActive: 0,
                        groupsManaged: 0
                    }
                },
                { upsert: true }
            );
        }
    } catch (err) {
        console.error('Error tracking daily usage:', err);
    }
}


// ========================================
// CONFIGURATION (from config.js)
// ========================================
const CACHE_TTL_MS = config.memberCache.CACHE_TTL_MS;
const CACHE_REFRESH_AFTER_MS = config.memberCache.CACHE_REFRESH_AFTER_MS;
const CHUNK_SIZE = config.tagging.CHUNK_SIZE;
const CONCURRENCY = config.tagging.CONCURRENCY;
const CHUNK_DELAY_MS = config.tagging.CHUNK_DELAY_MS;
const MAX_RETRIES = config.tagging.MAX_RETRIES;
const RATE_LIMIT_TOKENS = config.rateLimit.TOKENS;
const RATE_LIMIT_WINDOW_MS = config.rateLimit.WINDOW_MS;
const COMMAND_PREFIX = config.client.COMMAND_PREFIX;

// In-memory member cache (per-process). Key: `${sessionId}|${groupId}`
const membersCache = new Map();

// Fetch members from available sources (DB -> chat API -> fallback chat.participants)
async function fetchMembersFromSource(sessionId, groupId, chat) {
  try {
    const dbList = await getMembersFromDB(sessionId, groupId);
    if (Array.isArray(dbList) && dbList.length) return Array.from(new Set(dbList));

    if (chat && typeof chat.getParticipants === 'function') {
      const fetched = await chat.getParticipants().catch(()=>[]);
      if (Array.isArray(fetched) && fetched.length) {
        const jids = fetched.map(p => p.id && p.id._serialized ? p.id._serialized : null).filter(Boolean);
        if (jids.length) {
          // persist async
          setMembersForGroup(sessionId, groupId, jids).catch(()=>{});
          return Array.from(new Set(jids));
        }
      }
    }

    if (chat && Array.isArray(chat.participants) && chat.participants.length) {
      const jids = chat.participants.map(p => p.id && p.id._serialized ? p.id._serialized : null).filter(Boolean);
      if (jids.length) {
        setMembersForGroup(sessionId, groupId, jids).catch(()=>{});
        return Array.from(new Set(jids));
      }
    }

    return [];
  } catch (e) {
    return [];
  }
}

async function getCachedMembers(sessionId, groupId, chat) {
  const key = `${sessionId}|${groupId}`;
  const now = Date.now();
  const entry = membersCache.get(key);

  if (entry && (now - entry.ts) < CACHE_TTL_MS) {
    // background refresh if older than refresh threshold
    if (!entry.refreshing && (now - entry.ts) > CACHE_REFRESH_AFTER_MS) {
      entry.refreshing = true;
      (async () => {
        try {
          const fresh = await fetchMembersFromSource(sessionId, groupId, chat);
          if (fresh && fresh.length) membersCache.set(key, { jids: fresh, ts: Date.now(), refreshing: false });
          else entry.refreshing = false;
        } catch (e) { entry.refreshing = false; }
      })();
    }
    return entry.jids;
  }

  // fetch now and cache
  const jids = await fetchMembersFromSource(sessionId, groupId, chat);
  membersCache.set(key, { jids, ts: Date.now(), refreshing: false });
  return jids;
}

// Simple per-user token-bucket rate limiter
const rateBuckets = new Map();
function checkRateLimit(userId) {
  const now = Date.now();
  const key = String(userId);
  let b = rateBuckets.get(key);
  if (!b) { b = { tokens: RATE_LIMIT_TOKENS, lastRefill: now }; rateBuckets.set(key, b); }
  const elapsed = now - b.lastRefill;
  if (elapsed > RATE_LIMIT_WINDOW_MS) { b.tokens = RATE_LIMIT_TOKENS; b.lastRefill = now; }
  if (b.tokens > 0) { b.tokens -= 1; return { allowed: true, remaining: b.tokens }; }
  return { allowed: false, remaining: 0, retryAfter: RATE_LIMIT_WINDOW_MS - elapsed };
}

// Chunked sender with bounded concurrency & retries
async function sendMentionsInChunks({ client, groupId, jids, text, chunkSize=CHUNK_SIZE, concurrency=CONCURRENCY, delayMs=CHUNK_DELAY_MS }) {
  if (!Array.isArray(jids) || !jids.length) return { sent: 0, chunks: 0 };
  const chunks = [];
  for (let i = 0; i < jids.length; i += chunkSize) chunks.push(jids.slice(i, i+chunkSize));
  let sent = 0;
  let idx = 0;
  const workers = new Array(Math.min(concurrency, chunks.length)).fill(0).map(async () => {
    while (true) {
      if (idx >= chunks.length) break;
      const my = idx++;
      const c = chunks[my];
      let attempt = 0, ok = false;
      while (attempt < MAX_RETRIES && !ok) {
        try {
          await client.sendMessage(groupId, text, { mentions: c });
          sent += c.length;
          ok = true;
        } catch (err) {
          attempt++;
          const backoff = 200 * (2 ** attempt);
          await new Promise(r => setTimeout(r, backoff));
        }
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
  });
  await Promise.all(workers);
  return { sent, chunks: chunks.length };
}

// ---------------- CONFIG (adjust as needed) ----------------
const SESSION_DIR = path.join(__dirname, 'sessions');
const MEDIA_DIR = path.join(__dirname, 'media');
const CHAT_SYNC_THRESHOLD = 20; // number of chats to consider "synced"
const CHAT_SYNC_WAIT_ITER = 40; // iterations (500ms each) to wait for chat sync (~20s)
const SCHEDULER_POLL_MS = 30 * 1000; // 30s

// ensure directories
fs.mkdirSync(SESSION_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ---------------- Models (expected to be defined separately) ----------------
// You should create these model files under ./models:
// - ./models/GroupPermission.js   (per-group allow/deny lists)
// - ./models/WelcomeMeta.js       (stores welcomeSent per group per session)
// - ./models/Schedule.js          (scheduling)
const GroupPermission = require('./models/GroupPermission'); // { botUserId, groupId, allowed:[], blocked:[] }
const WelcomeMeta = require('./models/WelcomeMeta');         // { sessionId, groupId, welcomeSent: Boolean }
const Schedule = require('./models/Schedule');               // scheduling model per earlier spec

// ---------------- State containers ----------------
const clients = new Map();        // sessionId -> client instance
const sessionWorkers = new Map(); // sessionId -> { schedulerInterval, ... }
const logger = {
  info: (m) => console.log(`[${new Date().toISOString()}] INFO: ${m}`),
  warn: (m) => console.warn(`[${new Date().toISOString()}] WARN: ${m}`),
  error: (m, e) => console.error(`[${new Date().toISOString()}] ERROR: ${m}`, e || '')
};



function createClientOptions(sessionId) {
  const store = new MongoStore(sessionId);
  
  return {
    authStrategy: new (require('whatsapp-web.js').LocalAuth)({
      clientId: sessionId,
      dataPath: BASE_AUTH_PATH,  // ✅ ABSOLUTE PATH
      store: store
    }),

    puppeteer: {
      headless: true,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      defaultViewport: null,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-infobars',
        '--no-first-run',
        '--no-zygote',
        '--enable-features=NetworkService',
        '--ignore-certificate-errors'
      ]
    },

    restartOnAuthFail: true,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 0,
    qrMaxRetries: 3,

    webVersionCache: {
      type: "local"
    }
  };
}

// ===============================================================
// 🔄 AUTO MEMBER SYNC (Every 30 minutes + real-time join/leave)
// ===============================================================

function startAutoMemberSync(client, sessionId, mySelf) {
    const INTERVAL = 30 * 60 * 1000; // 30 minutes

    async function refreshAllMembers() {
        try {
            console.log(`♻️ [${sessionId}] Auto-member-sync started...`);

            const chats = await client.getChats();

            for (const c of chats) {
                if (!c.isGroup) continue;

                let participants = [];

                try {
                    if (Array.isArray(c.participants) && c.participants.length) {
                        participants = c.participants;
                    } else if (typeof c.getParticipants === "function") {
                        participants = await c.getParticipants();
                    }
                } catch {
                    participants = [];
                }

                const jids = participants
                    .map(p => p.id?._serialized || null)
                    .filter(Boolean);

                await setMembersForGroup(sessionId, c.id._serialized, jids);
            }

            console.log(`✅ [${sessionId}] Auto-member-sync complete.`);
        } catch (e) {
            console.error(`❌ Auto-member-sync failed for ${sessionId}:`, e.message || e);
        }
    }

    // First run 20 seconds after startup
    setTimeout(refreshAllMembers, 20000);

    // Background interval
    setInterval(refreshAllMembers, INTERVAL);
}


// ---------------- Utility ----------------
function formatJid(n) {
  // Accepts phone or jid -> returns normalized jid
  if (!n) return null;
  if (n.includes('@')) return n;
  const digits = n.replace(/[^0-9]/g, '');
  return digits ? `${digits}@c.us` : null;
}

function hhmmToNextDate(hhmm) {
  const [hh, mm] = hhmm.split(':').map(x => parseInt(x, 10));
  const now = new Date();
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
  if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

// ---------------- Core: setup per-client event handlers ----------------
function setupClientEvents(client, sessionId, workerIO) {
  // local variables captured per client
  let selfId = null;
  let keepAliveInterval = null;
  let schedulerInterval = null;
  const sessionName = sessionId;

  // small helper to safe send
  async function safeSend(jid, content, options = {}) {
    try {
      if (!jid) throw new Error('No jid provided to safeSend');
      return await client.sendMessage(jid, content, options);
    } catch (e) {
      logger.error(`safeSend failed to ${jid}`, e.message || e);
      return null;
    }
  }

  // Normalize jid helper (re-usable)
function normalizeJid(jid) {
  if (!jid) return null;
  if (jid.includes('@')) return jid;
  return jid.replace(/[^0-9]/g, '') + '@c.us';
}


  // QR
  client.on('qr', (qr) => {
    logger.info(`[${sessionName}] QR generated`);
    qrcode.generate(qr, { small: true });

   if (workerIO) {
      // attempt to find userId portion from sessionId if following format session-<userId>-<ts>
      const userMatch = sessionId.match(/^session-([^-]+)-/);
      const userId = userMatch ? userMatch[1] : null;
      if (userId) {
        workerIO.to(`user-${userId}`).emit('qrCode', { sessionId, qr });
      }
      // global broadcast
      workerIO.emit('qrCode', { sessionId, qr });
    }
  });


  client.on('auth_failure', (err) => {
    logger.error(`[${sessionName}] auth failure`, err && err.message ? err.message : err);
  });

  client.on('loading_screen', (percent, message) => {
    logger.info(`[${sessionName}] loading ${percent}% ${message}`);
  });


client.on('ready', async () => {
    try {
        logger.info(`[${sessionName}] READY fired`);

        // 🔹 Wait until client.info is available
        let attempts = 0;
        let state = null;
        
        while ((!client.info || !client.info.wid) && attempts < 60) {
            await new Promise(r => setTimeout(r, 100));
            attempts++;
        }
        if (!client.info || !client.info.wid) {
            logger.error(`[${sessionName}] client.info.wid missing after READY`);
            return;
        }

        selfId = client.info.wid._serialized;
        logger.info(`[${sessionName}] selfId set to ${selfId}`);

        
        // 🔒 SECURITY: Check if this WhatsApp number is blacklisted
        const whatsappNumber = selfId.split('@')[0]; // Extract number from JID
        const BlacklistedNumber = require('./models/BlacklistedNumber');
        const User = require('./models/User');
        const Session = require('./models/Session');
try {
             // Check if number is blacklisted
             const blacklisted = await BlacklistedNumber.findOne({ 
                 whatsappNumber: whatsappNumber 
             });
         if (blacklisted && !blacklisted.canReactivate) {
                logger.warn(`[${sessionName}] ⛔ Blacklisted number attempted connection: ${whatsappNumber}`);
                
                logger.info(`[${sessionName}] Attempting to send blacklist notification to ${selfId}`);
                
                const messageSent = await safeSend(selfId, `⛔ *ACCESS DENIED*

This WhatsApp number was previously used with: ${blacklisted.originalEmail}

Your trial expired on: ${new Date(blacklisted.trialUsedAt).toLocaleDateString()}

✅ *TO CONTINUE USING OUR SERVICE:*

Option 1: Log in to your original account
→ Email: ${blacklisted.originalEmail}
→ Reset password if needed: https://tagthemall.com.ng/reset-password

Option 2: Upgrade to a paid plan
→ Visit: https://tagthemall.com.ng
→ After payment, you can use this number again

Option 3: Contact support
→ Email: support@tagthemall.com
→ Include this reference: ${blacklisted._id}

This policy prevents trial abuse and ensures fair access for all users.`);
                
                if (messageSent) {
                    logger.info(`[${sessionName}] ✅ Blacklist notification sent successfully`);
                    // Wait 10 seconds to ensure message is delivered
                    await new Promise(r => setTimeout(r, 10000));
                } else {
                    logger.error(`[${sessionName}] ❌ Failed to send blacklist notification`);
                    // Still wait a bit before destroying, just in case
                    await new Promise(r => setTimeout(r, 3000));
                }
                
                logger.info(`[${sessionName}] Destroying client for blacklisted number`);
                
                // Disconnect the session
                await client.destroy();
                
                logger.info(`[${sessionName}] Updating session status to blocked`);
                
                // Update session status in database
                await Session.findOneAndUpdate(
                    { sessionId },
                    { 
                        status: 'blocked',
                        errorMessage: 'WhatsApp number blacklisted - trial abuse detected',
                        updatedAt: new Date()
                    }
                );

                logger.info(`[${sessionName}] Blacklist handling complete`);
                return; // Stop further execution
            }

            // Check if this number is already connected to another active account
            const existingUser = await User.findOne({ 
                whatsappNumber: whatsappNumber,
                status: { $in: ['active', 'approved'] }
            });

            // Get current session's userId
            const currentSession = await Session.findOne({ sessionId });
            const currentUserId = currentSession?.userId?.toString();

            if (existingUser && existingUser._id.toString() !== currentUserId) {
                logger.warn(`[${sessionName}] ⚠️ Number already connected to another account: ${whatsappNumber}`);
                
                await safeSend(selfId, `⚠️ *DUPLICATE ACCOUNT DETECTED*\n\nThis WhatsApp number is already connected to another account:\n\nEmail: ${existingUser.email}\nSubscription: ${existingUser.subscription}\n\nYou cannot use the same WhatsApp number on multiple accounts.\n\nPlease:\n1. Log in to your original account (${existingUser.email})\n2. Or disconnect from the other account first\n\nContact support if you need help.`);
                
                await client.destroy();
                
                await Session.findOneAndUpdate(
                    { sessionId },
                    { 
                        status: 'blocked',
                        errorMessage: 'WhatsApp number already in use by another account',
                        updatedAt: new Date()
                    }
                );

                return;
            }

            // After all security checks pass, save the whatsappNumber to User model
            if (currentSession && currentSession.userId) {
                await User.findByIdAndUpdate(
                    currentSession.userId,
                    { whatsappNumber: whatsappNumber },
                    { new: true }
                );
                logger.info(`[${sessionName}] ✅ Saved whatsappNumber to User model: ${whatsappNumber}`);
            }

        } catch (error) {
            logger.error(`[${sessionName}] Error checking blacklist:`, error);
            // Continue anyway if there's an error
        }

        // Continue with normal flow...
        // 🔹 Wait for full WhatsApp connection
        attempts = 0;
        state = null;
        while (attempts < 50) {
            try { state = await client.getState(); } catch {}
            if (state === 'CONNECTED' || state === 'OPEN') break;
            await new Promise(r => setTimeout(r, 100));
            attempts++;
        }
        logger.info(`[${sessionName}] final state=${state}`);

        // 🔹 Allow WhatsApp to sync chats
        await new Promise(r => setTimeout(r, 2500));

        // ✅ SEND PROFESSIONAL WELCOME
        await safeSend(selfId, `🤖 *BOT CONNECTED*\nSession: ${sessionId}`);
        await new Promise(r => setTimeout(r, 400));

        await safeSend(selfId, `
━━━━━━━━━━━━━━━━━━━━━━━
✨ WELCOME TO TAGTHEMALL BOT ✨
━━━━━━━━━━━━━━━━━━━━━━━

🤖 Your automation assistant is now active!

📌 GROUP TOOLS
• !list — Groups where you're admin
• !members — View group members
• !admins — View group admins

👥 TAGGING
• !tag — Tag all members
• !tagexcept — Tag everyone except selected users

📨 DIRECT MESSAGING
• !dmall — DM all members
• !dmselected — DM selected members only

💡 Type *!help* for full command list.
        `);

        // 🔄 -----------------------------------------
        // 🔥 AUTO ADMIN GROUP REFRESH (every 12 hours)
        // --------------------------------------------
        startAutoAdminGroupRefresh(client, sessionId, selfId);
        startAutoMemberSync(client, sessionId, selfId); 
        logger.info(`[${sessionName}] Auto-admin-refresh activated`);

        // 🔄 -----------------------------------------
        // Existing keepalive + scheduler
        // --------------------------------------------
        keepAliveInterval = setInterval(async () => {
            try { 
                await client.getState(); 
                logger.info(`[${sessionName}] keepalive OK`); 
            } catch (e) { 
                logger.error(`[${sessionName}] keepalive failed`, e.message || e); 
            }
        }, 300000);

        schedulerInterval = setInterval(
            () => runSchedulerForSession(sessionId, client),
            SCHEDULER_POLL_MS
        );

        setTimeout(() => runSchedulerForSession(sessionId, client), 3000);

        sessionWorkers.set(sessionId, { keepAliveInterval, schedulerInterval });

        logger.info(`[${sessionName}] setup complete`);
    } catch (e) {
        logger.error(`[${sessionName}] ready handler error`, e);
    }
});


client.on('disconnected', (reason) => {
    logger.info(`[${sessionName}] disconnected: ${reason}`);
    // cleanup
    const w = sessionWorkers.get(sessionId);
    if (w) {
      if (w.keepAliveInterval) clearInterval(w.keepAliveInterval);
      if (w.schedulerInterval) clearInterval(w.schedulerInterval);
      sessionWorkers.delete(sessionId);
    }
    clients.delete(sessionId);
  });

  // group participants change handler (for welcome + block enforcement)
client.on('group_participants_changed', async (notification) => {
    try {
        const chatId =
            notification.id?._serialized ||
            notification.chatId ||
            notification.from;

        if (!chatId) return;

        // ---- Normalize action & participant list ----
        const action = (notification.action || notification.type || '').toLowerCase();
        const participants = notification.participants ||
                             notification.who ||
                             notification.participantsChanged ||
                             [];
        const added = Array.isArray(participants) ? participants : [participants];

        for (const p of added) {

            // Resolve participant JID
            const pid = (typeof p === 'string')
                ? p
                : (p?._serialized || p.id?._serialized || p);

            if (!pid) continue;

            // =====================================================
            // 1️⃣ BOT ITSELF WAS ADDED
            // =====================================================
            if (pid === client.info?.wid?._serialized) {

                const meta = await WelcomeMeta.findOne({
                    sessionId,
                    groupId: chatId
                }).lean().catch(() => null);

                if (!meta || !meta.welcomeSent) {
                    await safeSend(
                        chatId,
                        `Thank you for having me here. I introduce to you all TagThemAll Bot.\nClick here to learn more: https://example.com`
                    );

                    await WelcomeMeta.updateOne(
                        { sessionId, groupId: chatId },
                        { $set: { welcomeSent: true } },
                        { upsert: true }
                    ).catch(() => null);
                }

                // Ensure group member DB includes bot
                await addMemberToGroup(sessionId, chatId, pid);

                continue;
            }

            // =====================================================
            // 2️⃣ REAL-TIME MEMBER SYNC (JOIN / LEAVE)
            // =====================================================
            try {
                if (action.includes('add') ||
                    action.includes('invite') ||
                    action.includes('promote')) {

                    await addMemberToGroup(sessionId, chatId, pid);

                } else if (action.includes('remove') ||
                           action.includes('leave')) {

                    await removeMemberFromGroup(sessionId, chatId, pid);

                } else {
                    // unknown action → still ensure DB consistency
                    await addMemberToGroup(sessionId, chatId, pid);
                }
            } catch (e) {
                logger.error('DB update error (join/leave):', e);
            }

            // =====================================================
            // 3️⃣ WELCOME MESSAGE + BLOCKLIST ENFORCEMENT
            // =====================================================
            try {
                const chat = await client.getChatById(chatId).catch(() => null);
                if (!chat) continue;

                // ---- Safe participant fetch ----
                let participantsList = [];
                try {
                    if (Array.isArray(chat.participants) && chat.participants.length) {
                        participantsList = chat.participants;
                    } else if (typeof chat.getParticipants === 'function') {
                        participantsList = await chat.getParticipants();
                    }
                } catch {
                    participantsList = [];
                }

                const botAdmin = participantsList.some(
                    obj =>
                        obj.id._serialized === client.info?.wid?._serialized &&
                        (obj.isAdmin || obj.isSuperAdmin)
                );

                const perm = await GroupPermission.findOne({
                    botUserId: sessionId,
                    groupId: chatId
                }).lean().catch(() => null);

                const whitelist = (perm && Array.isArray(perm.allowed)) ? perm.allowed : [];
                const blocklist = (perm && Array.isArray(perm.blocked)) ? perm.blocked : [];

                // ---- Blocklist handling ----
                if (blocklist.includes(pid) && botAdmin) {

                    await safeSend(chatId, `⛔ ${pid} is on the blocklist and has been removed.`);

                    try {
                        await chat.removeParticipants([pid]);
                    } catch (e) {
                        logger.error(
                            `[${sessionName}] failed to remove ${pid}`,
                            e.message || e
                        );
                    }

                    continue;
                }

                // ---- Welcome message ----
                try {
                    const num = pid.split('@')[0];
                    const contact = await client.getContactById(pid).catch(() => null);

                    const mentionOpts = contact ? { mentions: [contact] } : {};
                    const welcome = contact
                        ? `Welcome @${num}! Thank you for having me here. I introduce to you all TagThemAll Bot.\nClick here to learn more: https://example.com`
                        : `Welcome! Thank you for having me here. I introduce to you all TagThemAll Bot.\nClick here to learn more: https://example.com`;

                    await safeSend(chatId, welcome, mentionOpts);

                } catch (e) {
                    // ignore welcome failure
                }

            } catch (e) {
                // ignore failures here to avoid blocking the event
            }
        }

    } catch (e) {
        logger.error(`[${sessionName}] group_participants_changed error`, e);
    }
});

  // Get saved group entry by sessionId and 1-based index
async function getGroupFromIndex(sessionId, index) {
  if (!index || isNaN(index)) return null;
  const doc = await SavedGroupList.findOne({ sessionId }).lean();
  if (!doc || !Array.isArray(doc.groups) || doc.groups.length === 0) return null;
  return doc.groups[index - 1] || null; // 1-based index
}

// Set default active group for this session (per session)
async function setActiveGroup(sessionId, index) {
  const group = await getGroupFromIndex(sessionId, index);
  if (!group) return null;
  const res = await ActiveGroup.findOneAndUpdate(
    { sessionId },
    {
      sessionId,
      activeIndex: index,
      groupId: group.groupId,
      groupName: group.name,
      updatedAt: new Date()
    },
    { upsert: true, new: true }
  );
  return res;
}

// Get active group (if set) for the session
async function getActiveGroup(sessionId) {
  const doc = await ActiveGroup.findOne({ sessionId }).lean();
  if (!doc || !doc.groupId) return null;
  return {
    index: doc.activeIndex,
    groupId: doc.groupId,
    name: doc.groupName
  };
}

async function sendMentionsInChunks(chatId, mentionContacts, textAfter='') {
  const chunkSize = 50; // safe default, tune as needed
  for (let i = 0; i < mentionContacts.length; i += chunkSize) {
    const chunk = mentionContacts.slice(i, i + chunkSize);
    try {
      await client.sendMessage(chatId, textAfter, { mentions: chunk });
      await new Promise(r => setTimeout(r, 1000)); // small pause between chunks
    } catch (e) {
      logger.error('chunked send error', e);
    }
  }
}
 
client.on('message_create', async (message) => {
  try {
    // only process commands (ignore status & empty)
    if (!message.body || message.from === 'status@broadcast') return;

    // ✅ Extract userId ONCE - reused throughout this handler
        const userMatch = sessionId.match(/^session-([^-]+)-/);
        const userId = userMatch ? userMatch[1] : null;
    
        // Track daily usage
        if (userId) {
            await trackDailyUsage(userId, 'message');
        }
        
// Auto-save contact when they message the bot
if (!message.fromMe && message.from !== 'status@broadcast') {
    try {
        const contact = await message.getContact();
        const chat = await message.getChat();
        
        // Get user email from session
        const sessionDoc = await Session.findOne({ sessionId }).populate('userId');
        const userEmail = sessionDoc?.userId?.email;
        
        if (userId && userEmail) {
            await Contact.findOneAndUpdate(
                { 
                    sessionId: sessionId,
                    whatsappId: message.from
                },
                {
                    sessionId: sessionId,
                    userId: userId,
                    whatsappId: message.from,
                    name: contact.pushname || contact.name || message.from.split('@')[0],
                    phone: message.from.split('@')[0],
                    type: chat.isGroup ? 'group' : 'individual',
                    isGroup: chat.isGroup || false,
                    groupId: chat.isGroup ? chat.id._serialized : null,
                    groupName: chat.isGroup ? chat.name : null,
                    hasMessagedBot: true,
                    lastMessageAt: new Date()
                },
                { upsert: true, new: true }
            );
            
            // Update user's contactsSaved count
            await User.findByIdAndUpdate(userId, {
                $inc: { 'usage.contactsSaved': 1 }
            });
        }
    } catch (err) {
        logger.error(`[${sessionName}] Error auto-saving contact:`, err);
    }
}
        
    // ✅ Track message processing
    try {
    const sessionDoc = await Session.findOne({ sessionId });
    if (sessionDoc) {
        await sessionDoc.updateUsage('messagesProcessed', 1);
    }
    } catch (err) {
    console.error('Error updating message usage:', err);
    }

    // ensure selfId is set
    if (!client.info || !client.info.wid) {
      if (message.fromMe) {
        client.info = client.info || {};
        client.info.wid = client.info.wid || { _serialized: message.from };
      }
    }

    const mySelf = client.info?.wid?._serialized;

    // Load auto-reply settings for this session
    const auto = await AutoReply.findOne({ sessionId }).lean().catch(() => null);

    // determine sender
    const sender = message.fromMe ? mySelf : message.from;
    const isSelfChat = sender === mySelf;

    // --------------------------------------------------
    // 🟢 RECORD GROUP MESSAGE SENDERS INTO DB (NEW)
    // --------------------------------------------------
    try {
      const chat = await message.getChat().catch(() => null);

      if (chat && chat.isGroup) {
        const senderJid = message.author || message.from;

        if (senderJid) {
          await addMemberToGroup(
            sessionId,
            chat.id._serialized || chat.id,
            senderJid
          );
        }
      }
    } catch (e) {
      // ignore db errors
    }

// --------------------------------------------------
// 🟢 AUTO-SAVE INDIVIDUAL CONTACTS (NEW)
// --------------------------------------------------
// Save individual contacts when they first message the bot
if (!message.fromMe && message.from !== 'status@broadcast') {
    try {
        const chat = await message.getChat().catch(() => null);
        
        // Only save individual contacts (not groups, not group members)
        if (chat && !chat.isGroup) {
            const contact = await message.getContact().catch(() => null);
            
            if (contact && userId) {
                // Get user email from User model
                const User = require('./models/User');
                const userDoc = await User.findById(userId).select('email').lean();
                const userEmail = userDoc?.email;
                
                if (userEmail) {
                    // Extract phone number from WhatsApp ID
                    const phoneNumber = message.from.split('@')[0];
                    
                    // Get contact name (priority: pushname > name > phone)
                    const contactName = contact.pushname || 
                                      contact.name || 
                                      contact.verifiedName || 
                                      phoneNumber;
                    
                    // Try to get profile picture
                    let profilePicUrl = null;
                    try {
                        profilePicUrl = await contact.getProfilePicUrl().catch(() => null);
                    } catch {}
                    
                    // Save or update contact in database
                    const savedContact = await Contact.findOneAndUpdate(
                        { 
                            sessionId: sessionId,
                            whatsappId: message.from
                        },
                        {
                            $set: {
                                sessionId: sessionId,
                                userId: userId,
                                whatsappId: message.from,
                                name: contactName,
                                phone: phoneNumber,
                                type: 'individual',
                                isGroup: false,
                                profilePicture: profilePicUrl,
                                hasMessagedBot: true,
                                lastMessageAt: new Date()
                            },
                            $setOnInsert: {
                                addedAt: new Date()
                            }
                        },
                        { 
                            upsert: true, 
                            new: true 
                        }
                    );
                    
                    // Only increment contactsSaved if this is a NEW contact
                    if (savedContact && !savedContact.hasMessagedBot) {
                        await User.findByIdAndUpdate(
                            userId,
                            { $inc: { 'usage.contactsSaved': 1 } }
                        );
                    }
                    
                    logger.info(`[${sessionName}] ✅ Contact saved: ${contactName} (${phoneNumber}) for user ${userEmail}`);
                }
            }
        }
    } catch (e) {
        logger.error(`[${sessionName}] Error auto-saving individual contact:`, e);
    }
}
// --------------------------------------------------

    // --------------------------------------------------

    // --------------------------------------------------
    // 🟢 SELF-CHAT COMMAND FILTER + ✔️ REACTION
    // --------------------------------------------------
    if (message.body.startsWith(COMMAND_PREFIX)) {

      // Only owner can run commands
      if (sender !== mySelf) return;

      // Only self-chat allowed
      if (!isSelfChat) return;

      // Reaction to confirm command
      try {
        await message.react('✔️');
      } catch {}
    }

  // --------------------------------------------------
  // 🟢 MEDIA AUTO-REPLY (NEW)
  // --------------------------------------------------
  // MEDIA AUTO-REPLY
  if (!message.fromMe && message.hasMedia) {
      const mime = (message._data?.mimeType || '').toLowerCase();
      let mediaType = null;
      if (mime.includes('image')) mediaType = 'image';
      else if (mime.includes('video')) mediaType = 'video';
      else if (mime.includes('audio')) mediaType = 'audio';
      else if (mime.includes('pdf')) mediaType = 'document';
      else if (mime.includes('application')) mediaType = 'document';
      else if (mime.includes('sticker')) mediaType = 'sticker';
      if (mediaType && auto && Array.isArray(auto.mediaRules)) {
          const match = auto.mediaRules.find(r => r.type === mediaType);
          if (match) {
              await safeSend(message.from, match.response);
          }
      }

  }  
    // --------------------------------------------------
// 🟢 AUTO-REPLY TRIGGER (works in all groups & chats)
// --------------------------------------------------
try {
    const chat = await message.getChat();
    const text = (message.body || '').toLowerCase().trim();

    // Ignore own messages to prevent loops
    if (message.fromMe) {
        // allow commands but ignore auto reply triggers
    } else {
        // Fetch rules once per session
        const auto = await AutoReply.findOne({ sessionId }).lean().catch(() => null);

        if (auto && Array.isArray(auto.rules)) {
            for (const rule of auto.rules) {
                const key = rule.keyword.toLowerCase();

                // keyword match (contains)
                if (text.includes(key)) {
                    await safeSend(message.from, rule.response);
                    break; // stop after first match
                }
            }
        }
    }
} catch (e) {
    console.error("Auto-reply error:", e);
}

        // ------------------ RECALL ENGINE (members + natural triggers) ------------------
        // Paste this block BEFORE: if (!message.body.startsWith(COMMAND_PREFIX)) return;
        try {
        const rawText = (message.body || '').trim();
        const textLower = rawText.toLowerCase();

        // Only act on non-empty text in chats (not status, not protocol messages)
        if (!message.fromMe && textLower && message.from !== 'status@broadcast') {
            // --- Helper: parse user-supplied tokens ---
            const tokens = textLower.split(/\s+/).filter(Boolean);

            // Quick match patterns (requires index number for member-facing commands)
            // Examples:
            //  "yesterday picture 3"
            //  "last week pdf 2"
            //  "resend last picture 1"
            //  "ana asa 4"  (where "ana" or "asa" may be custom keywords)
            // We will load custom keywords from AutoReply.recalls (recallKeywords)

            // Load custom recall keywords mapping for this session (cached per request)
            let recallDoc = null;
            try { recallDoc = await AutoReply.findOne({ sessionId }).lean().catch(()=>null); } catch { recallDoc = null; }
            const customKws = (recallDoc && Array.isArray(recallDoc.recallKeywords)) ? recallDoc.recallKeywords : [];

            // Helper: resolve a token to either a time-token or media-type or custom mapping
            function resolveToken(tok) {
            const t = tok.toLowerCase();
            // Time keywords
            const timeMap = ['today','yesterday','thisweek','this_week','this-week','lastweek','last_week','last-week','lastmonth','last_month','last-month'];
            const weekday = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
            if (timeMap.includes(t) || weekday.includes(t) || /\d+\s*days?\s*ago/.test(t) || /^\d+dago$/.test(t)) return { kind: 'time', value: t };

            // media types
            if (['picture','image','photo','img','pic','pics'].includes(t)) return { kind:'media', value:'image' };
            if (['video','vid','movie','mp4'].includes(t)) return { kind:'media', value:'video' };
            if (['document','doc','pdf','file','ppt','pptx','xls','xlsx','docx'].includes(t)) return { kind:'media', value:'document' };
            if (['audio','voice','vn','ptt','mp3','ogg'].includes(t)) return { kind:'media', value:'audio' };
            if (['sticker','gif'].includes(t)) return { kind:'media', value:'sticker' };
            if (['last','resend','send'].includes(t)) return { kind:'special', value: t };

            // custom keywords (exact term match)
            const custom = customKws.find(c => c.term.toLowerCase() === t);
            if (custom) {
                // custom may map to time or to media or both
                return { kind: 'custom', value: custom };
            }

            // number tokens
            if (/^\d+$/.test(t)) return { kind: 'index', value: parseInt(t,10) };

            return { kind: 'unknown', value: t };
            }

            // Helper: parse a phrase into components: {timeRange, mediaType, index}
            function parseUserQuery(tokens) {
            let timeToken = null, mediaType = null, index = null;
            // allow flexible order; scan tokens for index, media, time, custom
            for (const tok of tokens) {
                const r = resolveToken(tok);
                if (r.kind === 'index') { index = r.value; continue; }
                if (r.kind === 'media') { mediaType = r.value; continue; }
                if (r.kind === 'time') { timeToken = r.value; continue; }
                if (r.kind === 'custom') {
                // custom may declare both time and/or media in stored mapping
                if (r.value.mapsToTime) timeToken = r.value.mapsToTime;
                if (r.value.mapsToMedia) mediaType = r.value.mapsToMedia;
                continue;
                }
                if (r.kind === 'special') {
                // e.g., "resend last" – treat "last" as time shortcut (no-op)
                continue;
                }
            }
            return { timeToken, mediaType, index };
            }

            // Helper: convert timeToken -> start and end Date objects (inclusive)
            function computeTimeWindow(timeToken) {
            const now = new Date();
            const t = (timeToken || '').toLowerCase();
            // default: if null -> no time filter
            if (!t) return null;

            // "today"
            if (t === 'today') {
                const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,0,0,0);
                const end = new Date(start.getTime() + 24*60*60*1000 - 1);
                return { start, end };
            }
            // "yesterday"
            if (t === 'yesterday' || t === 'ana') {
                const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()-1, 0,0,0,0);
                const end = new Date(start.getTime() + 24*60*60*1000 - 1);
                return { start, end };
            }
            // "lastweek" or "last week" -> last 7 days (from 7 days ago to now - or previous whole week)
            if (t.includes('lastweek') || t.includes('last_week') || t === 'last-week' || t === 'last week') {
                const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23,59,59,999);
                const start = new Date(end.getTime() - 7*24*60*60*1000 + 1);
                return { start, end };
            }
            if (t.includes('thisweek') || t.includes('this_week') || t === 'this week' || t === 'this-week') {
                const weekday = now.getDay(); // 0-6 Sun-Sat
                const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - weekday, 0,0,0,0);
                const end = new Date(start.getTime() + 7*24*60*60*1000 - 1);
                return { start, end };
            }
            // last month -> last 30 days window
            if (t.includes('lastmonth') || t.includes('last_month') || t === 'last-month' || t === 'last month') {
                const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23,59,59,999);
                const start = new Date(end.getTime() - 30*24*60*60*1000 + 1);
                return { start, end };
            }
            // "X days ago" or "3 days ago"
            const daysMatch = t.match(/(\d+)\s*days?\s*ago/);
            if (daysMatch) {
                const n = parseInt(daysMatch[1],10);
                const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()-n, 0,0,0,0);
                const end = new Date(start.getTime() + 24*60*60*1000 - 1);
                return { start, end };
            }
            // Weekday name -> search recent occurrences of that weekday (last 4 weeks)
            const wk = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
            if (wk.includes(t)) {
                // collect messages from the last 28 days that match that weekday
                const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23,59,59,999);
                const start = new Date(end.getTime() - 28*24*60*60*1000 + 1);
                return { start, end, weekday: t };
            }

            // fallback -> null (no time window)
            return null;
            }

            // Helper: check message matches desired media type
            function messageMatchesMediaType(m, mediaType) {
            try {
                const mime = (m._data?.mimeType || '').toLowerCase();
                if (!mediaType) return true; // if none specified, accept any media
                if (mediaType === 'image') return mime.includes('image');
                if (mediaType === 'video') return mime.includes('video');
                if (mediaType === 'audio') return mime.includes('audio') || mime.includes('ogg') || mime.includes('opus');
                if (mediaType === 'document') return (mime.includes('application') || mime.includes('pdf') || mime.includes('msword') || mime.includes('vnd'));
                if (mediaType === 'sticker') return mime.includes('webp') || (m.type && m.type === 'sticker');
            } catch {}
            return false;
            }

            // Helper: find Nth matching media in a chat given time window & mediaType
            async function findNthMediaInChat(chat, timeWindow, mediaType, requestedIndex) {
            const SCAN_LIMIT = 1000; // scan up to 1000 recent messages
            let msgs = [];
            try {
                msgs = await chat.fetchMessages({ limit: SCAN_LIMIT });
            } catch (e) {
                try { msgs = await client.getMessages(chat.id._serialized, SCAN_LIMIT); } catch(e2){ msgs = []; }
            }
            // messages returned newest -> oldest usually; filter by time window and media
            const filtered = [];
            const startTs = timeWindow ? (timeWindow.start.getTime()) : null;
            const endTs = timeWindow ? (timeWindow.end.getTime()) : null;
            for (const m of msgs) {
                const hasMedia = (typeof m.hasMedia === 'function') ? await m.hasMedia() : m.hasMedia;
                if (!hasMedia) continue;
                const ts = m.timestamp ? (m.timestamp*1000) : (m._data?.t ? m._data.t*1000 : null);
                if (timeWindow) {
                if (!ts) continue;
                if (startTs && ts < startTs) continue;
                if (endTs && ts > endTs) continue;
                // weekday filtering (optional)
                if (timeWindow.weekday) {
                    const d = new Date(ts);
                    const dayName = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][d.getDay()];
                    if (dayName !== timeWindow.weekday) continue;
                }
                }
                if (!messageMatchesMediaType(m, mediaType)) continue;
                filtered.push(m);
            }
            // filtered is ordered newest-first -> nth requestedIndex -> return that (1-based)
            if (!filtered.length) return { found: null, available: 0 };
            if (requestedIndex < 1 || requestedIndex > filtered.length) return { found: null, available: filtered.length };
            return { found: filtered[requestedIndex - 1], available: filtered.length };
            }

            // Now check if tokens represent a recall query (time-based, natural or custom) requiring index
            const parsed = parseUserQuery(tokens);

            // If parsed contains either timeToken OR custom mapping OR special "resend last" AND index must be present (you chose B)
            const hasRecallTrigger = parsed.timeToken || parsed.mediaType || textLower.startsWith('resend') || textLower.startsWith('send') || tokens.some(t => customKws.some(c=>c.term.toLowerCase()===t));
            if (hasRecallTrigger) {
            // Require index per your choice B
            if (!parsed.index) {
                await safeSend(message.from, 'Please specify which item number you want. Example: "yesterday picture 3" or "resend last picture 1"');
                // Do not fall through to command parsing
                return;
            }

            // compute time window
            const timeWindow = computeTimeWindow(parsed.timeToken);
            // find in current chat only (members recall uses current group)
            const originChat = await message.getChat().catch(()=>null);
            if (!originChat) {
                await safeSend(message.from, 'Unable to access the chat. Try again.');
                return;
            }

            const { found, available } = await findNthMediaInChat(originChat, timeWindow, parsed.mediaType, parsed.index);

            if (!found) {
                await safeSend(message.from, `I couldn't find that item. Available matching items in this time range: ${available}.`);
                return;
            }

            // forward or re-send
            try {
                await found.forward(message.from);
            } catch (e) {
                try {
                const media = await found.downloadMedia();
                const mm = new MessageMedia(media.mimetype, media.data, media.filename);
                await safeSend(message.from, mm, { caption: found.body || '' });
                } catch (e2) {
                await safeSend(message.from, 'Found the media but failed to resend it. Check bot logs.');
                }
            }
            return; // do not proceed to command parsing
            }

        } // end if-not-from-me and text
        } catch (err) {
        logger.error(`[${sessionId}] recall engine error:`, err);
        // swallow to avoid crashing event handler
        }


    // If no command prefix, stop here
    if (!message.body.startsWith(COMMAND_PREFIX)) return;

    // --------------------------------------------------
    // 🟢 COMMAND PARSER
    // --------------------------------------------------
    const full = message.body.slice(COMMAND_PREFIX.length).trim();
    const [cmdRaw, ...args] = full.split(/\s+/);
    const cmd = (cmdRaw || '').toLowerCase();

    // ✅ Track command execution
try {
    const sessionDoc = await Session.findOne({ sessionId });
    if (sessionDoc) {
        await sessionDoc.updateUsage('commandsExecuted', 1);
    }
} catch (err) {
    console.error('Error updating command usage:', err);
}

 // --------------------------------------------------
// 🟢 COMMAND PERMISSION CHECK (UNIFIED & SECURE)
// --------------------------------------------------

if (userId) {
    try {
        // Fetch user document
        const User = require('./models/User');
        const userDoc = await User.findById(userId);
        
        if (!userDoc) {
            await safeSend(message.from, '❌ User not found. Please contact support.');
            return;
        }

        // ✅ 1. Check if user is exempt (owner, admin, or payment-exempt)
        const isExempt = userDoc.isExemptFromPayment() || 
                        userDoc.isBotOwner() || 
                        (userDoc.isSystemAdmin && userDoc.isSystemAdmin());
        
        if (isExempt) {
            // Exempt users bypass all checks - allow command execution
            logger.info(`[${sessionId}] ✅ Exempt user ${userDoc.email} executing: !${cmd}`);
            // Continue to command execution below
        } else {
            // ✅ 2. Check subscription status (expiry & payment)
            const now = new Date();
            const isSubscriptionActive = userDoc.subscriptionExpiry && 
                                        new Date(userDoc.subscriptionExpiry) > now;
            const isPaymentValid = userDoc.paymentStatus === 'paid' || 
                                  userDoc.paymentStatus === 'trial';

            // Block expired subscriptions (except basic commands)
            if (!isSubscriptionActive && !isPaymentValid) {
                if (!['ping', 'help', 'status'].includes(cmd)) {
                    await safeSend(
                        message.from, 
                        `❌ Your subscription has expired.\n\n` +
                        `Please renew to continue using premium commands.\n\n` +
                        `Visit: ${process.env.DOMAIN || 'https://yourwebsite.com'}/pricing`
                    );
                    return;
                }
            }

            // ✅ 3. Use canUseCommand helper for comprehensive permission check
            const hasPermission = await canUseCommand(
                userId, 
                cmd, 
                userDoc.subscription || 'free'
            );

            if (!hasPermission) {
                // Get subscription plans from server (single source of truth)
                const { subscriptionPlans } = require('../server/server');
                
                // Find which plan includes this command
                const requiredPlan = Object.keys(subscriptionPlans).find(plan => {
                    const planCommands = subscriptionPlans[plan].allowedCommands;
                    return planCommands === 'all' || 
                           (Array.isArray(planCommands) && planCommands.includes(cmd));
                }) || 'business';
                
                await safeSend(
                    message.from, 
                    `❌ Command !${cmd} requires ${requiredPlan} subscription or higher.\n\n` +
                    `Your current plan: ${userDoc.subscription || 'free'}\n\n` +
                    `Upgrade at: ${process.env.DOMAIN || 'https://tagthemall.com.ng'}/pricing\n\n` +
                    `💡 Or contact admin for special access.`
                );
                return;
            }
        }
        
    } catch (error) {
        logger.error(`[${sessionId}] Permission check error:`, error);
        // Continue anyway if there's an error checking permissions
        // Change to 'return;' for fail-closed security (deny on error)
    }
}

    // --------------------------------------------------
    // Your entire command switch block stays exactly as is
    // --------------------------------------------------

    async function fetchAndSaveAdminGroups() {
      let chats = await client.getChats();

      if (chats.length < CHAT_SYNC_THRESHOLD) {
        for (let i = 0; i < CHAT_SYNC_WAIT_ITER; i++) {
          if (chats.length > CHAT_SYNC_THRESHOLD) break;
          await new Promise(r => setTimeout(r, 500));
          chats = await client.getChats();
        }
      }

      const adminGroups = [];

      for (const c of chats) {
        if (!c.isGroup) continue;

        let participants = [];
        try {
          if (Array.isArray(c.participants) && c.participants.length) {
            participants = c.participants;
          } else if (typeof c.getParticipants === "function") {
            participants = await c.getParticipants();
          }
        } catch {
          participants = [];
        }

        const amIAdmin = participants.some(p =>
          p.id._serialized === mySelf &&
          (p.isAdmin || p.isSuperAdmin)
        );

        if (amIAdmin)
          adminGroups.push({
            name: c.name || 'Unnamed group',
            groupId: c.id._serialized
          });
      }

      if (adminGroups.length) {
        await SavedGroupList.findOneAndUpdate(
          { sessionId },
          { groups: adminGroups, updatedAt: new Date() },
          { upsert: true }
        );
      }

      return adminGroups;
    }

    
  async function resolveTargetGroupArg(argIndex) {
    try {
        // 1️⃣ Load cached admin groups for this session
        let cached = await SavedGroupList.findOne({ sessionId })
            .lean()
            .catch(() => null);

        let adminGroups =
            cached && Array.isArray(cached.groups) ? cached.groups : [];

        // If no cache exists → rebuild FAST
        if (!adminGroups.length) {
            logger.warn(`[${sessionId}] No cached admin groups — rebuilding list.`);

            const chats = await client.getChats();
            adminGroups = [];

            for (const c of chats) {
                if (!c.isGroup) continue;

                let parts = [];
                try {
                    if (Array.isArray(c.participants) && c.participants.length) {
                        parts = c.participants;
                    } else if (typeof c.getParticipants === "function") {
                        parts = await c.getParticipants();
                    }
                } catch { parts = []; }

                const amIAdmin = parts.some(
                    p =>
                        p.id?._serialized === client.info?.wid?._serialized &&
                        (p.isAdmin || p.isSuperAdmin)
                );

                if (amIAdmin) {
                    adminGroups.push({
                        name: c.name || 'Unnamed Group',
                        groupId: c.id._serialized,
                    });
                }
            }

            // Save rebuilt cache
            await SavedGroupList.findOneAndUpdate(
                { sessionId },
                { groups: adminGroups, updatedAt: new Date() },
                { upsert: true }
            ).catch(() => null);
        }

        // 2️⃣ If user passed an index → resolve directly
        if (argIndex && !isNaN(argIndex)) {
            const idx = parseInt(argIndex);
            const arrayIndex = idx - 1;

            if (adminGroups[arrayIndex]) {
                return {
                    index: idx,
                    group: adminGroups[arrayIndex],
                };
            }

            return { index: null, group: null };
        }

        // 3️⃣ No index → try to load last active group (from !use)
        const active = await ActiveGroup.findOne({ sessionId })
            .lean()
            .catch(() => null);

        if (active) {
            // Find this active group in cache
            const match = adminGroups.find(g => g.groupId === active.groupId);

            if (match) {
                return {
                    index: adminGroups.indexOf(match) + 1,
                    group: match
                };
            }
        }

        // 4️⃣ Nothing found
        return { index: null, group: null };

    } catch (e) {
        logger.error(`[${sessionId}] resolveTargetGroupArg ERROR`, e);
        return { index: null, group: null };
    }
}

// NEW FUNCTION: Resolve group from ALL groups (admin + member)
async function resolveTargetGroupFromAll(argIndex) {
    try {
        // 1️⃣ Load cached ALL groups for this session
        let cached = await SavedGroupList.findOne({ sessionId: sessionId + "_all" })
            .lean()
            .catch(() => null);

        let allGroups = cached && Array.isArray(cached.groups) ? cached.groups : [];

        // If no cache exists → rebuild from all groups
        if (!allGroups.length) {
            logger.warn(`[${sessionId}] No cached all groups — rebuilding list.`);

            const chats = await client.getChats();
            allGroups = chats
                .filter(c => c.isGroup)
                .map(c => ({
                    name: c.name || "Unnamed Group",
                    groupId: c.id._serialized
                }));

            // Save rebuilt cache
            await SavedGroupList.findOneAndUpdate(
                { sessionId: sessionId + "_all" },
                { groups: allGroups, updatedAt: new Date() },
                { upsert: true }
            ).catch(() => null);
        }

        // 2️⃣ If user passed an index → resolve directly
        if (argIndex && !isNaN(argIndex)) {
            const idx = parseInt(argIndex);
            const arrayIndex = idx - 1;

            if (allGroups[arrayIndex]) {
                return {
                    index: idx,
                    group: allGroups[arrayIndex],
                };
            }

            return { index: null, group: null };
        }

        // 3️⃣ No index → try to load last active group (from !use)
        const lastActive = await ActiveGroup.findOne({ sessionId }).lean().catch(() => null);

        if (lastActive && lastActive.groupId) {
            const found = allGroups.find(g => g.groupId === lastActive.groupId);
            if (found) {
                return { index: null, group: found };
            }
        }

        // 4️⃣ Fallback: return first group if available
        if (allGroups.length > 0) {
            return { index: 1, group: allGroups[0] };
        }

        return { index: null, group: null };

    } catch (err) {
        logger.error(`resolveTargetGroupFromAll error:`, err);
        return { index: null, group: null };
    }
}

    // ------------ COMMANDS ------------
    switch (cmd) {
case 'help': {
    if (!isSelfChat) return;

    const text = `
━━━━━━━━━━━━━━━━━━━━━━━
✨ *TAGTHEMALL BOT COMMANDS* ✨
━━━━━━━━━━━━━━━━━━━━━━━

📋 *GROUP MANAGEMENT*
• !list — Groups where you're an admin
• !listall — All groups you're a member of
• !use <index> — Set active group
• !members <groupIndex> — Show group members
• !admins <groupIndex> — Show admins
• !mygroups — Groups you created

👥 *TAGGING TOOLS*
• !tag <groupIndex> — Tag all members
• !tagexcept <groupIndex> <excluded>
   Examples:
     - !tagexcept 2 @john @mary
     - !tagexcept 4 08123456789
     - !tagexcept 1 1,3,5   (index skip)

   ✔ Supports: @mentions, phone numbers, DB cache
   ✔ Works with 700+ member groups & communities

📨 *DIRECT MESSAGING*
• !dmall <groupIndex> | <message>
• !dmselected <groupIndex> <targets> | <message>
   Accepted target formats:
   - @mentions
   - 08123456789 / 2348012345678
   - index list: 1,3,5

🔁 *FORWARDING TOOLS*
• (reply) !forwardall <groupIndex>
• (reply) !forward <groupIndex> <targets>

🔐 *PERMISSION CONTROLS*
• !allow <number>
• !deny <number>
• !whitelist — Show allowed users
• !blocklist — Show blocked users
• !unallow <number>
• !unblock <number>

⏰ *SCHEDULER*
• !schedule HH:MM mode repeat | message
• !listschedules
• !cancelschedule <id>

🗄 *SYSTEM & UTILITIES*
• !ping — Check bot status
• !cleanupcache — Rebuild group cache
• !help — Show this help menu

━━━━━━━━━━━━━━━━━━━━━━━
💡 *TIP:* You can type !tag without index if you used !use before.
━━━━━━━━━━━━━━━━━━━━━━━
`;

    await safeSend(message.from, text);
    break;
}


      case 'ping':
        await safeSend(message.from, '🏓 Pong!');
        break;

      /* ---------- SAVE ADMIN GROUPS: !list ---------- */
case 'list': {
    // Usage: !list OR !list refresh
    const isRefresh = args[0] && args[0].toLowerCase() === "refresh";

    if (!isRefresh) {
        // Try loading cached list first
        const cached = await SavedGroupList.findOne({ sessionId }).lean().catch(() => null);

        if (cached && cached.groups && cached.groups.length) {
            let out = '📋 *Groups Where You Are Admin (Cached):*\n\n';
            cached.groups.forEach((g, i) => {
                out += `${i + 1}. ${g.name}\n`;  // ✅ CHANGED: Removed ID line
            });
            out += '\n🔄 To refresh the list, use: `!list refresh`';
            await safeSend(message.from, out);
            break;
        }
    }

    // If refresh or no cache → perform FULL SCAN (slow)
    await safeSend(message.from, '⏳ Scanning all your groups… please wait (first time may take a while)…');

    const chats = await client.getChats();
    const adminGroups = [];

    for (const c of chats) {
        if (!c.isGroup) continue;

        let participants = [];
        try {
            if (Array.isArray(c.participants) && c.participants.length) {
                participants = c.participants;
            } else if (typeof c.getParticipants === "function") {
                participants = await c.getParticipants();
            }
        } catch {
            participants = [];
        }

        const amIAdmin = participants.some(
            p => p.id._serialized === mySelf && (p.isAdmin || p.isSuperAdmin)
        );
        if (amIAdmin) {
            adminGroups.push({
                name: c.name || 'Unnamed group',
                groupId: c.id._serialized
            });
        }
    }

    // Save cache
    if (adminGroups.length) {
        await SavedGroupList.findOneAndUpdate(
            { sessionId },
            { groups: adminGroups, updatedAt: new Date() },
            { upsert: true }
        );
        
        // ✅ Update session usage with group count
        try {
            const sessionDoc = await Session.findOne({ sessionId });
            if (sessionDoc) {
                sessionDoc.usage.groupsTagged = adminGroups.length;
                await sessionDoc.save();
            }
        } catch (err) {
            console.error('Error updating groups count:', err);
        }
    }

    if (!adminGroups.length) {
        await safeSend(message.from, '❌ You are not an admin in any group.');
        break;
    }

    let out = '*📋 Updated Admin Group List:*\n\n';
    adminGroups.forEach((g, i) => {
        out += `${i + 1}. ${g.name}\n`;  // ✅ CHANGED: Removed ID line
    });
    out += '\n⚡ Next time, just run `!list` (instant)\n🔄 To re-scan again use: `!list refresh`';
    await safeSend(message.from, out);

    break;
}

case 'autoreply': {
    if (!isSelfChat) return;

    const sub = (args[0] || '').toLowerCase();

    // ============= ADD RULE =============
    if (sub === 'add') {
        const full = args.slice(1).join(' ');
        const pipe = full.indexOf('|');

        if (pipe === -1) {
            await safeSend(message.from,
                'Usage:\n' +
                '!autoreply add <keyword> | <response>\n\n' +
                'Example:\n!autoreply add hi | Hello there!'
            );
            break;
        }

        const keyword = full.slice(0, pipe).trim();
        const response = full.slice(pipe + 1).trim();

        if (!keyword || !response) {
            await safeSend(message.from, '❗ Keyword or response missing.');
            break;
        }

        let doc = await AutoReply.findOne({ sessionId }).catch(() => null);
        if (!doc) doc = await AutoReply.create({ sessionId, rules: [] });

        doc.rules.push({ keyword, response });
        await doc.save();

        await safeSend(message.from,
            `✅ Auto-reply added.\nKeyword: *${keyword}*\nResponse: ${response}`
        );

        break;
    }

        // ============= REMOVE RULE =============
    if (sub === 'remove') {
        const keyword = args.slice(1).join(' ').trim().toLowerCase();

        if (!keyword) {
            await safeSend(message.from,
                'Usage:\n!autoreply remove <keyword>'
            );
            break;
        }

        const doc = await AutoReply.findOne({ sessionId });
        if (!doc || !doc.rules.length) {
            await safeSend(message.from, '❌ No rules saved.');
            break;
        }

        doc.rules = doc.rules.filter(r => r.keyword.toLowerCase() !== keyword);
        await doc.save();

        await safeSend(message.from,
            `🗑 Removed auto-reply for keyword: *${keyword}*`
        );

        break;
    }

        // ============= LIST RULES =============
    if (sub === 'list') {
        const doc = await AutoReply.findOne({ sessionId }).lean().catch(() => null);

        if (!doc || !doc.rules.length) {
            await safeSend(message.from, '📭 No auto-reply rules saved.');
            break;
        }

        let out = '*📄 AUTO-REPLY RULES:*\n\n';
        doc.rules.forEach((r, i) => {
            out += `${i + 1}. Keyword: *${r.keyword}*\n   Reply: ${r.response}\n\n`;
        });

        await safeSend(message.from, out);
        break;
    }

        await safeSend(message.from,
        'Usage:\n' +
        '!autoreply add <keyword> | <response>\n' +
        '!autoreply remove <keyword>\n' +
        '!autoreply list'
    );

    break;
}

if (sub === 'addmedia') {
    const full = args.slice(1).join(' ');
    const pipe = full.indexOf('|');

    if (pipe === -1) {
        await safeSend(message.from,
            'Usage:\n!autoreply addmedia <type> | <response>\n\n' +
            'Types: image, video, audio, sticker, document'
        );
        break;
    }

    const type = full.slice(0, pipe).trim().toLowerCase();
    const response = full.slice(pipe + 1).trim();

    const valid = ['image', 'video', 'audio', 'sticker', 'document'];
    if (!valid.includes(type)) {
        await safeSend(message.from,
            `❌ Invalid type. Use: ${valid.join(', ')}`
        );
        break;
    }

    let doc = await AutoReply.findOne({ sessionId });
    if (!doc) doc = await AutoReply.create({ sessionId, rules: [], mediaRules: [] });

    doc.mediaRules.push({ type, response });
    await doc.save();

    await safeSend(message.from,
        `✅ Media auto-reply added.\nType: *${type}*\nResponse: ${response}`
    );
    break;
}


if (sub === 'removemedia') {
    const type = args[1]?.toLowerCase();

    if (!type) {
        await safeSend(message.from,
            'Usage:\n!autoreply removemedia <type>'
        );
        break;
    }

    let doc = await AutoReply.findOne({ sessionId });
    if (!doc || !doc.mediaRules.length) {
        await safeSend(message.from, '❌ No media auto-reply rules saved.');
        break;
    }

    doc.mediaRules = doc.mediaRules.filter(r => r.type !== type);
    await doc.save();

    await safeSend(message.from,
        `🗑 Removed media auto-reply for type: *${type}*`
    );
    break;
}


if (sub === 'listmedia') {
    const doc = await AutoReply.findOne({ sessionId }).lean();

    if (!doc || !doc.mediaRules.length) {
        await safeSend(message.from, '📭 No media auto-reply rules saved.');
        break;
    }

    let out = '*📄 MEDIA AUTO-REPLY RULES:*\n\n';
    doc.mediaRules.forEach((r, i) => {
        out += `${i + 1}. Type: *${r.type}*\n   Reply: ${r.response}\n\n`;
    });

    await safeSend(message.from, out);
    break;
}



case 'broadcast': {
    if (!isSelfChat) return;

    const msgText = args.join(' ').trim();
    if (!msgText) {
        await safeSend(message.from,
            '❗ Usage:\n!broadcast <message>\n\nSends the message to ALL groups where you are an admin.'
        );
        break;
    }

    // Load cached admin groups
    let cache = await SavedGroupList.findOne({ sessionId }).lean().catch(() => null);
    let adminGroups = cache?.groups || [];

    // If cache empty, rebuild it
    if (!adminGroups.length) {
        await safeSend(message.from, '⏳ Cache empty — rescanning groups...');
        const chats = await client.getChats().catch(() => []);

        adminGroups = [];

        for (const c of chats) {
            if (!c.isGroup) continue;
            let parts = [];

            try {
                if (Array.isArray(c.participants)) {
                    parts = c.participants;
                } else if (typeof c.getParticipants === "function") {
                    parts = await c.getParticipants();
                }
            } catch {}

            const amIAdmin = parts.some(p =>
                p.id._serialized === mySelf &&
                (p.isAdmin || p.isSuperAdmin)
            );

            if (amIAdmin) {
                adminGroups.push({
                    name: c.name || 'Unnamed Group',
                    groupId: c.id._serialized
                });
            }
        }

        await SavedGroupList.findOneAndUpdate(
            { sessionId },
            { groups: adminGroups, updatedAt: new Date() },
            { upsert: true }
        );
    }

    if (!adminGroups.length) {
        await safeSend(message.from, '❌ No admin groups found.');
        break;
    }

    await safeSend(
        message.from,
        `📣 *Broadcast Started*\nSending message to ${adminGroups.length} admin groups...`
    );

    let delivered = 0;

    for (const g of adminGroups) {
        try {
            await client.sendMessage(g.groupId, msgText);
            delivered++;
        } catch (e) {}

        // Throttle
        await new Promise(r => setTimeout(r, 500));
    }

    await safeSend(
        message.from,
        `✅ *Broadcast Completed*\nMessage delivered to *${delivered}* groups.`
    );

    break;
}

case 'broadcastdm': {
    if (!isSelfChat) return;

    const msgText = args.join(' ').trim();
    if (!msgText) {
        await safeSend(message.from,
            '❗ Usage:\n!broadcastdm <message>\n\nSends a direct message to ALL your contacts.'
        );
        break;
    }

    await safeSend(message.from, '⏳ Fetching contacts...');

    let contacts = [];
    try {
        contacts = await client.getContacts();
    } catch {}

    if (!contacts.length) {
        await safeSend(message.from, '❌ No contacts available.');
        break;
    }

    // Filter real WhatsApp contacts only
    const jids = contacts
        .filter(c => c.id && c.id._serialized.endsWith('@c.us'))
        .map(c => c.id._serialized)
        .filter(j => j !== mySelf);  // skip bot

    await safeSend(
        message.from,
        `📣 *DM Broadcast Started*\nSending message to ${jids.length} contacts...`
    );

    let delivered = 0;

    for (const jid of jids) {
        try {
            await client.sendMessage(jid, msgText);
            delivered++;
        } catch (e) {}

        // Important to avoid WhatsApp ban
        await new Promise(r => setTimeout(r, 400));
    }

    await safeSend(
        message.from,
        `✅ *DM Broadcast Completed*\nDelivered to *${delivered}* contacts.`
    );

    break;
}


case 'status': {
    if (!isSelfChat) return;

    // Fetch admin groups cache
    const adminCache = await SavedGroupList.findOne({ sessionId }).lean().catch(() => null);
    const adminCount = adminCache?.groups?.length || 0;

    // Fetch all-groups cache
    const allCache = await SavedGroupList.findOne({ sessionId: sessionId + "_all" })
        .lean()
        .catch(() => null);
    const allCount = allCache?.groups?.length || 0;

    // Count total member records in DB for this session
    const memberCount = await GroupMembers.countDocuments({ sessionId }).catch(() => 0);

    // Check WhatsApp client state
    let waState = "UNKNOWN";
    try { waState = await client.getState(); } catch {}

    const text = `
📊 *BOT STATUS REPORT*

🤖 *WhatsApp Connection:* ${waState}
🔑 *Session:* ${sessionId}

📂 *Cached Admin Groups:* ${adminCount}
📂 *Cached All Groups:* ${allCount}
👥 *Cached Member Lists:* ${memberCount}

🕒 *Auto-refresh every:* 12 hours (admin groups)
🕒 *Member auto-sync:* Every 30 minutes

💡 Use:
• !list refresh  → refresh admin groups
• !listall refresh → refresh all joined groups
• !syncmembers <index> → refresh specific group members
`;

    await safeSend(message.from, text);
    break;
}


        case 'listall': {
    const isRefresh = args[0] && args[0].toLowerCase() === "refresh";

    if (!isRefresh) {
        const cached = await SavedGroupList.findOne({ sessionId: sessionId + "_all" })
            .lean()
            .catch(() => null);

        if (cached && cached.groups && cached.groups.length) {
            let out = '📋 *All Groups (Cached):*\n\n';
            cached.groups.forEach((g, i) => {
                out += `${i + 1}. ${g.name}\n`;
            });
            out += '\n🔄 To refresh: `!listall refresh`';
            await safeSend(message.from, out);
            break;
        }
    }

    await safeSend(
        message.from,
        '⏳ Scanning ALL your groups… (may take 10–20s on 50+ groups)…'
    );

    const chats = await client.getChats();

    const allGroups = chats
        .filter(c => c.isGroup)
        .map(c => ({
            name: c.name || "Unnamed Group",
            groupId: c.id._serialized
        }));

    await SavedGroupList.findOneAndUpdate(
        { sessionId: sessionId + "_all" },
        { groups: allGroups, updatedAt: new Date() },
        { upsert: true }
    );

    let out = '*📋 Updated List of ALL Groups:*\n\n';
    allGroups.forEach((g, i) => {
        out += `${i + 1}. ${g.name}\n`;
    });

    out += '\n⚡ Cached for instant display.\nUse `!listall refresh` to scan again.';
    await safeSend(message.from, out);

    break;
}

            case 'syncmembers': {
        // usage: !syncmembers <groupIndex>
        if (!isSelfChat) return;
        const idx = args[0] && !isNaN(args[0]) ? parseInt(args[0]) : null;
        const resolved = await resolveTargetGroupArg(idx);
        if (!resolved.group) { await safeSend(message.from, '❌ No target group found.'); break; }

        const chat = await client.getChatById(resolved.group.groupId).catch(()=>null);
        if (!chat) { await safeSend(message.from, 'Could not fetch group chat.'); break; }

        let participants = [];
        try {
            if (typeof chat.getParticipants === 'function') {
            participants = await chat.getParticipants();
            } else if (Array.isArray(chat.participants) && chat.participants.length) {
            participants = chat.participants;
            }
        } catch (e) {
            participants = [];
        }

        if (participants && participants.length) {
            const jids = participants.map(p => p.id?._serialized || p);
            await setMembersForGroup(sessionId, resolved.group.groupId, jids);
            await safeSend(message.from, `✅ Synced ${jids.length} members for ${resolved.group.name}.`);
        } else {
            await safeSend(message.from,
            `⚠ Could not read participant list directly. This happens for Community-subgroups or when server-side restrictions apply.\n` +
            `Suggestions:\n` +
            `• Promote the bot to Admin and run !syncmembers again.\n` +
            `• Or ask active members to send a message in the group so the bot collects them automatically.\n` +
            `I will still collect members automatically as they send messages.` );
        }
        break;
        }


      /* ---------- SET DEFAULT ACTIVE GROUP: !use ---------- */
      case 'use': {
        if (!args[0]) { await safeSend(message.from, 'Usage: !use <groupIndex>'); break; }
        const idx = parseInt(args[0]);
        if (isNaN(idx)) { await safeSend(message.from, 'Invalid index'); break; }
        // ensure list exists
        const group = await getGroupFromIndex(sessionId, idx);
        if (!group) {
          // try fetching and saving fresh list, then re-check
          await fetchAndSaveAdminGroups();
        }
        const group2 = await getGroupFromIndex(sessionId, idx);
        if (!group2) { await safeSend(message.from, 'Group not found. Run !list then try again.'); break; }
        await setActiveGroup(sessionId, idx);
        await safeSend(message.from, `✅ Default active group set to *${group2.name}* (index ${idx}).`);
        break;
      }

      case 'unset': {
        await ActiveGroup.deleteOne({ sessionId }).catch(()=>null);
        await safeSend(message.from, '✅ Default active group cleared.');
        break;
      }

      /* ---------- DMALL ---------- */
case 'dmall': {
    if (!isSelfChat) return;

    // ------------------------------------------------------------
    // 1️⃣ PARSE GROUP INDEX AND MESSAGE
    // ------------------------------------------------------------
    const pipeIndex = message.body.indexOf('|');
    if (pipeIndex === -1) {
        await safeSend(message.from,
            '❗ Usage:\n!dmall <groupIndex> | <message>');
        break;
    }

    const beforePipe = message.body.substring(0, pipeIndex).trim();
    const afterPipe = message.body.substring(pipeIndex + 1).trim();

    const parts = beforePipe.split(/\s+/);
    const groupIndex = parseInt(parts[1]);

    if (isNaN(groupIndex)) {
        await safeSend(message.from,
            '❗ First argument must be the group index.\nExample:\n!dmall 3 | Hello');
        break;
    }

    if (!afterPipe.length) {
        await safeSend(message.from,
            '❗ Empty message detected.\nPut your message after the "|" symbol.');
        break;
    }

    const msgText = afterPipe;
    
    // ------------------------------------------------------------
    // 2️⃣ RESOLVE THE GROUP FROM INDEX (USING listall CACHE)
    // ------------------------------------------------------------
    let allGroups = [];

    try {
        const cached = await SavedGroupList.findOne({ sessionId: sessionId + "_all" })
            .lean()
            .catch(() => null);

        if (cached && Array.isArray(cached.groups)) {
            allGroups = cached.groups;
        }

        if (!allGroups.length) {
            const chats = await client.getChats();
            allGroups = chats
                .filter(c => c.isGroup)
                .map(c => ({
                    name: c.name || "Unnamed Group",
                    groupId: c.id._serialized
                }));

            await SavedGroupList.findOneAndUpdate(
                { sessionId: sessionId + "_all" },
                { groups: allGroups, updatedAt: new Date() },
                { upsert: true }
            );
        }
    } catch {}

    const arrayIndex = groupIndex - 1;
    const group = allGroups[arrayIndex];

    if (!group) {
        await safeSend(message.from,
            '❌ Invalid group index.\nUse !listall to see indexes.');
        break;
    }

    const groupId = group.groupId;
    const chat = await client.getChatById(groupId).catch(() => null);

    if (!chat) {
        await safeSend(message.from,
            '❌ Could not load group. Bot may not be a member.');
        break;
    }

    // ------------------------------------------------------------
    // 3️⃣ REFRESH MEMBERS ALWAYS (YOUR CHOICE C)
    // ------------------------------------------------------------
    let participants = [];

    try {
        // Always fetch fresh members
        const fetched = await chat.getParticipants().catch(() => []);

        if (fetched.length) {
            participants = fetched;
            await setMembersForGroup(
                sessionId,
                groupId,
                fetched.map(p => p.id._serialized)
            );
        }
    } catch {}

    if (!participants.length) {
        await safeSend(message.from,
            `⚠ Unable to fetch members for *${chat.name}*.\nTry promoting bot to admin.`);
        break;
    }

    // Convert to JIDs
    const allJIDs = participants
        .map(p => p.id._serialized)
        .filter(j => j !== mySelf);

    if (!allJIDs.length) {
        await safeSend(message.from,
            '⚠ No eligible members found.');
        break;
    }

    // ------------------------------------------------------------
    // 4️⃣ AUTO-BATCH SETUP
    // ------------------------------------------------------------
    const batchSize = 60;               // safe batch
    const delayPerMessage = () => 1200 + Math.random() * 1300;  // strong safety
    const batchDelay = 10 * 60 * 1000;  // 10 minutes = 600000 ms

    const batches = [];
    for (let i = 0; i < allJIDs.length; i += batchSize) {
        batches.push(allJIDs.slice(i, i + batchSize));
    }

    await safeSend(
        message.from,
        `📨 *DM-All Started (Auto-Batch Mode)*  
Group: *${chat.name}*  
Total Members: *${allJIDs.length}*  
Total Batches: *${batches.length}*  
Batch Size: *60*  
Delay Between Batches: *10 minutes*

Sending first batch now…`
    );

    // ------------------------------------------------------------
    // 5️⃣ AUTO-BATCH EXECUTION (NO USER INTERACTION NEEDED)
    // ------------------------------------------------------------
    async function sendBatch(batchIndex) {
        if (batchIndex >= batches.length) {
            await safeSend(
                message.from,
                `🎉 *DM-All Completed!*  
Total messages sent: *${allJIDs.length}*`
            );
            return;
        }

        const batch = batches[batchIndex];
        let sent = 0;

        for (const jid of batch) {
            try {
                await client.sendMessage(jid, msgText);
                sent++;
            } catch {}
            await new Promise(r => setTimeout(r, delayPerMessage()));
        }

        await safeSend(
            message.from,
            `📦 *Batch ${batchIndex + 1}/${batches.length} complete*  
Sent: *${sent}/${batch.length}*  
Next batch in 10 minutes…`
        );

        // Schedule next batch after 10 minutes
        setTimeout(() => {
            sendBatch(batchIndex + 1);
        }, batchDelay);
    }

    // Start first batch
    sendBatch(0);

    break;
}


case 'dmallmulti': {
    if (!isSelfChat) return;

    // ------------------------------------------------------------
    // 1️⃣ PARSE GROUP INDEXES + MESSAGE
    // ------------------------------------------------------------
    const pipeIndex = message.body.indexOf('|');
    if (pipeIndex === -1) {
        await safeSend(message.from,
            '❗ Usage:\n!dmallmulti <groupIndexes> | <message>\nExample:\n!dmallmulti 1,2,5 | Hello');
        break;
    }

    const beforePipe = message.body.substring(0, pipeIndex).trim();
    const msgText = message.body.substring(pipeIndex + 1).trim();

    if (!msgText.length) {
        await safeSend(message.from, '❗ Message cannot be empty.');
        break;
    }

    const parts = beforePipe.split(/\s+/);
    const rawIndexes = parts[1];

    if (!rawIndexes) {
        await safeSend(message.from,
            '❗ You must provide group indexes.\nExample:\n!dmallmulti 1,2,5 | Hello');
        break;
    }

    // Convert "1,2,5" → [1, 2, 5]
    const groupIndexes = rawIndexes.split(',')
        .map(i => parseInt(i.trim()))
        .filter(n => !isNaN(n) && n > 0);

    if (!groupIndexes.length) {
        await safeSend(message.from,
            '❗ Invalid group indexes.\nUse comma-separated numbers.');
        break;
    }

    // ------------------------------------------------------------
    // 2️⃣ LOAD OR REBUILD GROUP LIST
    // ------------------------------------------------------------
    let allGroups = [];

    try {
        const cached = await SavedGroupList.findOne({ sessionId: sessionId + "_all" }).lean();
        if (cached && Array.isArray(cached.groups)) allGroups = cached.groups;

        if (!allGroups.length) {
            const chats = await client.getChats();
            allGroups = chats
                .filter(c => c.isGroup)
                .map(c => ({
                    name: c.name || "Unnamed Group",
                    groupId: c.id._serialized
                }));

            await SavedGroupList.findOneAndUpdate(
                { sessionId: sessionId + "_all" },
                { groups: allGroups, updatedAt: new Date() },
                { upsert: true }
            );
        }
    } catch {}

    const selectedGroups = groupIndexes
        .map(i => allGroups[i - 1])
        .filter(Boolean);

    if (!selectedGroups.length) {
        await safeSend(message.from,
            '❌ None of the requested groups were found.\nUse !listall to see indexes.');
        break;
    }

    // ------------------------------------------------------------
    // 3️⃣ SAFETY CONSTANTS
    // ------------------------------------------------------------
    const batchSize = 60;                     // safe WhatsApp batch
    const msgDelay = () => 1200 + Math.random() * 1300;  // 1.2–2.5 sec per DM
    const batchDelay = 10 * 60 * 1000;        // 10 minutes between batches
    const groupDelay = 10 * 60 * 1000;        // 10 minutes between groups

    await safeSend(
        message.from,
        `📨 *DM-All MULTI Started*  
Groups: *${rawIndexes}*  
Batch Size: *60*  
Delay Between Batches: *10 mins*  
Delay Between Groups: *10 mins*`
    );

    // ------------------------------------------------------------
    // 4️⃣ PROCESS A SINGLE GROUP (ALL BATCHES)
    // ------------------------------------------------------------
    async function processGroup(groupObj, groupNumber, totalGroups) {
        const groupId = groupObj.groupId;
        const chat = await client.getChatById(groupId).catch(() => null);

        if (!chat) {
            await safeSend(message.from,
                `❌ Skipping Group #${groupIndexes[groupNumber - 1]} — Cannot load chat.`);
            return;
        }

        // Always refresh members (Option C)
        let participants = [];
        try {
            const fetched = await chat.getParticipants().catch(() => []);
            if (fetched.length) {
                participants = fetched;
                await setMembersForGroup(
                    sessionId,
                    groupId,
                    fetched.map(p => p.id._serialized)
                );
            }
        } catch {}

        if (!participants.length) {
            await safeSend(message.from,
                `⚠ Skipping *${chat.name}* — Cannot fetch members.`);
            return;
        }

        // Convert to JIDs
        const allJIDs = participants
            .map(p => p.id._serialized)
            .filter(j => j !== mySelf);

        if (!allJIDs.length) {
            await safeSend(
                message.from,
                `⚠ Skipping *${chat.name}* — No eligible members.`
            );
            return;
        }

        // Create safe batches (60 per batch)
        const batches = [];
        for (let i = 0; i < allJIDs.length; i += batchSize) {
            batches.push(allJIDs.slice(i, i + batchSize));
        }

        await safeSend(
            message.from,
            `📦 *Group ${groupNumber}/${totalGroups} — ${chat.name}*  
Members: *${allJIDs.length}*  
Batches: *${batches.length}*`
        );

        // SEND EACH BATCH
        async function sendBatch(batchIndex) {
            if (batchIndex >= batches.length) {
                await safeSend(message.from,
                    `✔ Finished *${chat.name}*\nWaiting 10 mins before next group…`);
                return;
            }

            const batch = batches[batchIndex];
            let sent = 0;

            for (const jid of batch) {
                try {
                    await client.sendMessage(jid, msgText);
                    sent++;
                } catch {}
                await new Promise(r => setTimeout(r, msgDelay()));
            }

            await safeSend(
                message.from,
                `📨 Batch ${batchIndex + 1}/${batches.length} complete for *${chat.name}*\nSent: *${sent}/${batch.length}*\nNext batch in 10 mins…`
            );

            setTimeout(() => sendBatch(batchIndex + 1), batchDelay);
        }

        await sendBatch(0);  // start batches
    }

    // ------------------------------------------------------------
    // 5️⃣ PROCESS ALL GROUPS SEQUENTIALLY
    // ------------------------------------------------------------
    async function processGroupsSequentially(index) {
        if (index >= selectedGroups.length) {
            await safeSend(message.from, '🎉 *DM-All MULTI Completed for ALL groups!*');
            return;
        }

        const groupObj = selectedGroups[index];

        await processGroup(groupObj, index + 1, selectedGroups.length);

        // Wait 10 minutes before next group
        setTimeout(() => {
            processGroupsSequentially(index + 1);
        }, groupDelay);
    }

    processGroupsSequentially(0);

    break;
}



/* ---------- DMSELECTED ---------- */
case 'dmselected': {
    if (!isSelfChat) return;

    // Usage examples displayed if empty:
    if (!args.length) {
        await safeSend(message.from,
`Usage:
!dmselected <groupIndex> <targets> | <message>

Examples:
!dmselected 2 @john @mary | Private meeting
!dmselected 1 08123456789 3 | Hello
!dmselected 3 1,3,5 | Important update

💡 Use !listall to see all your groups`);
        break;
    }

    // ------------------------------------------------------------
    // 1️⃣ Group Index
    // ------------------------------------------------------------
    const groupIndex = parseInt(args[0]);
    if (isNaN(groupIndex)) {
        await safeSend(message.from,
            '❗ First argument must be group index.\nExample: !dmselected 2 @john | Hello');
        break;
    }

    // ------------------------------------------------------------
    // 2️⃣ Resolve Group from ALL groups
    // ------------------------------------------------------------
    let resolved = { index: null, group: null };
    
    try {
        // Load cached ALL groups
        let cached = await SavedGroupList.findOne({ sessionId: sessionId + "_all" })
            .lean()
            .catch(() => null);

        let allGroups = cached && Array.isArray(cached.groups) ? cached.groups : [];

        // If no cache, rebuild from all groups
        if (!allGroups.length) {
            const chats = await client.getChats();
            allGroups = chats
                .filter(c => c.isGroup)
                .map(c => ({
                    name: c.name || "Unnamed Group",
                    groupId: c.id._serialized
                }));

            // Save cache
            await SavedGroupList.findOneAndUpdate(
                { sessionId: sessionId + "_all" },
                { groups: allGroups, updatedAt: new Date() },
                { upsert: true }
            ).catch(() => null);
        }

        // Resolve group by index
        const arrayIndex = groupIndex - 1;
        if (allGroups[arrayIndex]) {
            resolved = {
                index: groupIndex,
                group: allGroups[arrayIndex]
            };
        }
    } catch (err) {
        logger.error('Error resolving group:', err);
    }

    if (!resolved.group) {
        await safeSend(message.from, '❌ Invalid group index. Use !listall to see all groups.');
        break;
    }

    // ------------------------------------------------------------
    // 3️⃣ Extract target-part and message-part
    // ------------------------------------------------------------
    const full = args.slice(1).join(' ');
    const pipeIndex = full.indexOf('|');

    if (pipeIndex === -1) {
        await safeSend(message.from, '❗ Missing message.\nUse: | <message>');
        break;
    }

    const targetPart = full.slice(0, pipeIndex).trim();
    const msgText = full.slice(pipeIndex + 1).trim();

    if (!msgText) {
        await safeSend(message.from, '❗ The message after "|" cannot be empty.');
        break;
    }

    // ------------------------------------------------------------
    // 4️⃣ Fetch Group Participants (DB → getParticipants → fallback)
    // ------------------------------------------------------------
    const chat = await client.getChatById(resolved.group.groupId).catch(() => null);
    if (!chat) {
        await safeSend(message.from, '❌ Could not fetch group.');
        break;
    }

    let participants = [];
    try {
        const dbList = await getMembersFromDB(sessionId, resolved.group.groupId);

        if (Array.isArray(dbList) && dbList.length) {
            participants = dbList.map(j => ({ id: { _serialized: j } }));
        } else if (typeof chat.getParticipants === "function") {
            const fetched = await chat.getParticipants().catch(() => []);
            if (fetched.length) {
                participants = fetched;
                await setMembersForGroup(
                    sessionId,
                    resolved.group.groupId,
                    fetched.map(p => p.id?._serialized || p)
                );
            }
        } else if (Array.isArray(chat.participants) && chat.participants.length) {
            participants = chat.participants;
            const jids = participants
                .map(p => p.id?._serialized || null)
                .filter(Boolean);
            if (jids.length)
                await setMembersForGroup(sessionId, resolved.group.groupId, jids);
        }
    } catch {
        participants = [];
    }

    if (!participants.length) {
        await safeSend(
            message.from,
            `⚠ Cannot determine members for *${resolved.group.name}*.\n` +
            `Group might be a Community subgroup.\n` +
            `Try running !syncmembers after promoting bot to admin.`
        );
        break;
    }

    const participantJIDs = participants.map(p => p.id._serialized);

    // ------------------------------------------------------------
    // 5️⃣ Parse Targets (mentions, numbers, indexes)
    // ------------------------------------------------------------
    const targetSet = new Set();
    const tokens = targetPart.split(/\s+/);

    for (const token of tokens) {

        // A — @mentions (@john)
        if (token.includes('@')) {
            const num = token.replace(/[^0-9]/g, '');
            if (num.length >= 7) targetSet.add(`${num}@c.us`);
        }

        // B — Phone numbers (081..., 234..., 090...)
        else if (/^\d+$/.test(token) && token.length >= 7) {
            const formatted = token.startsWith('234') ? token : '234' + token;
            targetSet.add(`${formatted}@c.us`);
        }

        // C — Index list (1,3,5)
        else if (/^\d+(,\d+)*$/.test(token)) {
            const idxs = token.split(',').map(n => parseInt(n.trim()));
            for (const i of idxs) {
                const jid = participantJIDs[i - 1];
                if (jid) targetSet.add(jid);
            }
        }
    }

    if (!targetSet.size) {
        await safeSend(message.from, '❗ No valid targets detected.');
        break;
    }

    // ------------------------------------------------------------
    // 6️⃣ Sending DM to each selected member (anti-spam throttled)
    // ------------------------------------------------------------
    let delivered = 0;

    for (const jid of targetSet) {
        if (jid === mySelf) continue;

        try {
            await client.sendMessage(jid, msgText);
            delivered++;
        } catch (e) {}

        await new Promise(r => setTimeout(r, 300)); // throttle
    }

    // ------------------------------------------------------------
    // 7️⃣ Final Confirmation
    // ------------------------------------------------------------
    await safeSend(
        message.from,
        `📨 *DM-Selected Completed*  
Sent to **${delivered}** members in *${resolved.group.name}*.`
    );

    break;
}


      /* ---------- MEMBERS ---------- */
case 'members': {
    // 1️⃣ Parse group index (or use active group)
    const providedIdx = args[0] && !isNaN(args[0]) ? parseInt(args[0]) : null;
    
    // 2️⃣ Resolve Group from ALL groups
    let resolved = { index: null, group: null };
    
    if (providedIdx) {
        try {
            // Load cached ALL groups
            let cached = await SavedGroupList.findOne({ sessionId: sessionId + "_all" })
                .lean()
                .catch(() => null);

            let allGroups = cached && Array.isArray(cached.groups) ? cached.groups : [];

            // If no cache, rebuild from all groups
            if (!allGroups.length) {
                const chats = await client.getChats();
                allGroups = chats
                    .filter(c => c.isGroup)
                    .map(c => ({
                        name: c.name || "Unnamed Group",
                        groupId: c.id._serialized
                    }));

                // Save cache
                await SavedGroupList.findOneAndUpdate(
                    { sessionId: sessionId + "_all" },
                    { groups: allGroups, updatedAt: new Date() },
                    { upsert: true }
                ).catch(() => null);
            }

            // Resolve group by index
            const arrayIndex = providedIdx - 1;
            if (allGroups[arrayIndex]) {
                resolved = {
                    index: providedIdx,
                    group: allGroups[arrayIndex]
                };
            }
        } catch (err) {
            logger.error('Error resolving group:', err);
        }
    } else {
        // No index provided, try to use active group
        const lastActive = await ActiveGroup.findOne({ sessionId }).lean().catch(() => null);
        
        if (lastActive && lastActive.groupId) {
            // Load all groups to find the active one
            let cached = await SavedGroupList.findOne({ sessionId: sessionId + "_all" })
                .lean()
                .catch(() => null);

            let allGroups = cached && Array.isArray(cached.groups) ? cached.groups : [];
            
            const found = allGroups.find(g => g.groupId === lastActive.groupId);
            if (found) {
                resolved = { index: null, group: found };
            }
        }
    }

    if (!resolved.group) {
        await safeSend(message.from, '❌ No target group found. Use !listall to see all groups or !use <index> to set default');
        break;
    }

    const chat = await client.getChatById(resolved.group.groupId).catch(() => null);
    if (!chat) {
        await safeSend(message.from, '❌ Could not fetch group chat.');
        break;
    }

    // ------------------------------------------------------------
    // 🟢 PARTICIPANT RESOLVER (DB → getParticipants → fallback)
    // ------------------------------------------------------------
    let participants = [];
    try {
        const dbList = await getMembersFromDB(sessionId, resolved.group.groupId);

        // 1) DB fallback
        if (Array.isArray(dbList) && dbList.length) {
            participants = dbList.map(j => ({ id: { _serialized: j } }));
        }

        // 2) Official API (preferred)
        else if (typeof chat.getParticipants === "function") {
            const fetched = await chat.getParticipants().catch(() => []);
            if (Array.isArray(fetched) && fetched.length) {
                participants = fetched;
                // update DB cache
                const jids = fetched.map(p => p.id?._serialized || p);
                await setMembersForGroup(sessionId, resolved.group.groupId, jids);
            }
        }

        // 3) Fallback to chat.participants (old API)
        else if (Array.isArray(chat.participants) && chat.participants.length) {
            participants = chat.participants;

            const jids = participants
                .map(p => p.id?._serialized || null)
                .filter(Boolean);

            if (jids.length) {
                await setMembersForGroup(sessionId, resolved.group.groupId, jids);
            }
        }

    } catch {
        participants = [];
    }

    // ------------------------------------------------------------
    // 🟡 NO PARTICIPANTS AVAILABLE?
    // ------------------------------------------------------------
    if (!participants.length) {
        await safeSend(
            message.from,
            `⚠ Cannot list members of *${resolved.group.name}*.\n` +
            `Group may be a WhatsApp Community subgroup (restricted).\n` +
            `Try using: !syncmembers after promoting bot to admin.`
        );
        break;
    }

    // ------------------------------------------------------------
    // 🟢 BUILD MEMBER LIST OUTPUT
    // ------------------------------------------------------------
    let out = `*👥 Members of ${resolved.group.name}:*\n\n`;

    participants.forEach((p, i) => {
        const jid = p.id?._serialized || '';
        const num = jid.split('@')[0];
        out += `${i + 1}. ${num}\n`;
    });

    await safeSend(message.from, out);
    break;
}


/* ---------- ADMINS ---------- */
case 'admins': {
    const providedIdx = args[0] && !isNaN(args[0]) ? parseInt(args[0]) : null;
    
    // Resolve Group from ALL groups
    let resolved = { index: null, group: null };
    
    if (providedIdx) {
        try {
            // Load cached ALL groups
            let cached = await SavedGroupList.findOne({ sessionId: sessionId + "_all" })
                .lean()
                .catch(() => null);

            let allGroups = cached && Array.isArray(cached.groups) ? cached.groups : [];

            // If no cache, rebuild from all groups
            if (!allGroups.length) {
                const chats = await client.getChats();
                allGroups = chats
                    .filter(c => c.isGroup)
                    .map(c => ({
                        name: c.name || "Unnamed Group",
                        groupId: c.id._serialized
                    }));

                // Save cache
                await SavedGroupList.findOneAndUpdate(
                    { sessionId: sessionId + "_all" },
                    { groups: allGroups, updatedAt: new Date() },
                    { upsert: true }
                ).catch(() => null);
            }

            // Resolve group by index
            const arrayIndex = providedIdx - 1;
            if (allGroups[arrayIndex]) {
                resolved = {
                    index: providedIdx,
                    group: allGroups[arrayIndex]
                };
            }
        } catch (err) {
            logger.error('Error resolving group:', err);
        }
    } else {
        // No index provided, try to use active group
        const lastActive = await ActiveGroup.findOne({ sessionId }).lean().catch(() => null);
        
        if (lastActive && lastActive.groupId) {
            // Load all groups to find the active one
            let cached = await SavedGroupList.findOne({ sessionId: sessionId + "_all" })
                .lean()
                .catch(() => null);

            let allGroups = cached && Array.isArray(cached.groups) ? cached.groups : [];
            
            const found = allGroups.find(g => g.groupId === lastActive.groupId);
            if (found) {
                resolved = { index: null, group: found };
            }
        }
    }

    if (!resolved.group) {
        await safeSend(message.from, '❌ No target group found. Use !listall to see all groups or !use <index>');
        break;
    }

    const groupId = resolved.group.groupId;

    let participants = [];

    try {
        // 1️⃣ Try DB members first
        const dbList = await getMembersFromDB(sessionId, groupId);
        if (Array.isArray(dbList) && dbList.length) {
            participants = dbList.map(j => ({ id: { _serialized: j } }));
        }

        // 2️⃣ Try official getParticipants
        if (!participants.length) {
            const chat = await client.getChatById(groupId).catch(() => null);
            if (chat && typeof chat.getParticipants === 'function') {
                const fetched = await chat.getParticipants().catch(() => []);
                if (fetched.length) {
                    participants = fetched;

                    // update DB cache
                    const jids = fetched.map(p => p.id._serialized);
                    await setMembersForGroup(sessionId, groupId, jids);
                }
            }
        }

        // 3️⃣ Fallback to chat.participants
        if (!participants.length) {
            const chat = await client.getChatById(groupId).catch(() => null);
            if (chat && Array.isArray(chat.participants) && chat.participants.length) {
                participants = chat.participants;

                // update DB
                const jids = participants.map(p => p.id._serialized);
                await setMembersForGroup(sessionId, groupId, jids);
            }
        }
    } catch (e) {
        participants = [];
    }

    if (!participants.length) {
        await safeSend(
            message.from,
            `⚠ Unable to fetch admins for ${resolved.group.name}.\nThis is common for Community groups.\nTry:\n• Promote bot to admin\n• Use !syncmembers <index>\n• Ask members to send a short message`
        );
        break;
    }

    const admins = participants.filter(p => p.isAdmin || p.isSuperAdmin);

    if (!admins.length) {
        await safeSend(message.from, `⚠ No admin data available for ${resolved.group.name}.`);
        break;
    }

    let out = `*🛡 Admins of ${resolved.group.name}:*\n\n`;
    admins.forEach((a, i) => {
        out += `${i + 1}. ${a.id._serialized.split('@')[0]}\n`;
    });

    await safeSend(message.from, out);
    break;
}


case 'mygroups': {
    if (!isSelfChat) return;

    await safeSend(message.from, `⏳ Checking groups you created...`);

    let chats = await client.getChats().catch(() => []);

    const myGroups = [];

    for (const c of chats) {
        if (!c.isGroup) continue;

        let participants = [];

        try {
            if (typeof c.getParticipants === "function") {
                participants = await c.getParticipants();
            } else if (Array.isArray(c.participants) && c.participants.length) {
                participants = c.participants;
            }
        } catch {
            participants = [];
        }

        const me = participants.find(
            p => p.id._serialized === mySelf
        );

        if (!me) continue;

        // WhatsApp assigns creator as SuperAdmin
        if (me.isSuperAdmin) {
            myGroups.push({
                name: c.name || "Unnamed Group",
                groupId: c.id._serialized
            });
        }
    }

    if (!myGroups.length) {
        await safeSend(message.from, `❌ No groups were detected as created by you.`);
        break;
    }

    let out = `*👑 Groups YOU Created:*\n\n`;
    myGroups.forEach((g, i) => {
        out += `${i + 1}. ${g.name}\n`;
    });

    await safeSend(message.from, out);
    break;
}


case 'tag': {
    if (!isSelfChat) return;

    // Rate limit check (per user)
    const rl = checkRateLimit(message.from);
    if (!rl.allowed) {
        await safeSend(message.from, `⚠ Rate limit: try again in ${Math.ceil(rl.retryAfter / 1000)}s`);
        break;
    }

    // Parse command
    let raw = message.body.trim().replace(/^!tag\s*/i, '').trim();
    const parts = raw.split(/\s+/);

    // ------- FIXED MULTI-GROUP PARSER -------
    // Extract ALL leading numeric parts until the first non-number
    let idxParts = [];
    let msgStartIndex = 0;

    for (let i = 0; i < parts.length; i++) {
        if (/^\d+$/.test(parts[i])) {
            idxParts.push(parseInt(parts[i]));
            msgStartIndex = i + 1;
        } else {
            break;
        }
    }

    let groupIndexes = [];
    let messageText = "";

    if (idxParts.length > 0) {
        groupIndexes = idxParts;
        messageText = parts.slice(msgStartIndex).join(" ").trim();
    } else {
        groupIndexes = [null]; // default group
        messageText = raw.trim();
    }

    if (!messageText) messageText = "*🔔 Attention everyone!*";

    // ----------------------------------------

    if (!groupIndexes.length) {
        await safeSend(message.from, "❌ Invalid group indexes.");
        break;
    }

    // Contact cache per invocation
    const contactCache = new Map();

    // Fetch contacts in parallel (bounded)
    async function fetchContactsMerged(jids, concurrency = 30) {
        const missing = jids.filter(j => !contactCache.has(j));
        if (!missing.length) return;

        let i = 0;
        const workers = new Array(Math.min(concurrency, missing.length))
            .fill(0)
            .map(async () => {
                while (true) {
                    const idx = i++;
                    if (idx >= missing.length) break;

                    const jid = missing[idx];
                    try {
                        const c = await client.getContactById(jid).catch(() => null);
                        contactCache.set(jid, c || { id: { _serialized: jid } });
                    } catch {
                        contactCache.set(jid, { id: { _serialized: jid } });
                    }
                }
            });

        await Promise.all(workers);
    }

    const successfulGroups = [];

    for (const idx of groupIndexes) {
        const resolved = await resolveTargetGroupArg(idx);
        if (!resolved.group) {
            await safeSend(message.from, `❌ No group found for index: ${idx}`);
            continue;
        }

        const groupId = resolved.group.groupId;
        const chat = await client.getChatById(groupId).catch(() => null);

        if (!chat) {
            await safeSend(message.from, `❌ Could not fetch group: ${resolved.group.name}`);
            continue;
        }

        // Cached member list
        const memberJIDs = await getCachedMembers(sessionId, groupId, chat);
        if (!Array.isArray(memberJIDs) || !memberJIDs.length) {
            await safeSend(
                message.from,
                `⚠ Could not determine members for *${resolved.group.name}*.\nTry !syncmembers.`
            );
            continue;
        }

        // Exclude bot itself
        const filteredJIDs = memberJIDs.filter(j => j !== mySelf);
        if (!filteredJIDs.length) {
            await safeSend(message.from, `⚠ No members to tag in ${resolved.group.name}.`);
            continue;
        }

        // Parallel contact fetch
        await fetchContactsMerged(filteredJIDs, 30);

        // Chunked sending
        const chunkSize = CHUNK_SIZE || 100;
        const chunks = [];
        for (let i = 0; i < filteredJIDs.length; i += chunkSize) {
            chunks.push(filteredJIDs.slice(i, i + chunkSize));
        }

        let totalSent = 0;
        let totalChunks = 0;

        for (const chunk of chunks) {
            const mentions = [];

            for (const jid of chunk) {
                const c = contactCache.get(jid);
                if (!c) continue;
                const jidSerialized = c.id?._serialized || jid;
                mentions.push(jidSerialized);
            }

            if (!mentions.length) continue;

            // SEND ONLY MESSAGE TEXT – NO visible @names
            const chunkMessage = messageText;

            try {
                await client.sendMessage(groupId, chunkMessage, { mentions });
                totalSent += mentions.length;
                totalChunks++;
            } catch (err) {
                logger.error(`[${sessionName}] tag chunk failed`, err);

                // Retry once
                try {
                    await new Promise(r => setTimeout(r, 500));
                    await client.sendMessage(groupId, chunkMessage, { mentions });
                    totalSent += mentions.length;
                    totalChunks++;
                } catch (e) {
                    logger.error(`[${sessionName}] retry failed`, e);
                }
            }

            await new Promise(r => setTimeout(r, CHUNK_DELAY_MS || 400));
        }

        successfulGroups.push(
            `${resolved.group.name} (${totalSent} mentions across ${totalChunks} chunks)`
        );

        await new Promise(r => setTimeout(r, 600));
    }

    if (!successfulGroups.length) {
        await safeSend(message.from, "❌ No groups tagged.");
    } else {
        await safeSend(message.from, `✅ Tag executed in:\n• ${successfulGroups.join("\n• ")}`);
    }

    break;
}

case 'tagexcept': {
  if (!isSelfChat) return;

  // RATE LIMIT (per user)
  const rl = checkRateLimit(message.from);
  if (!rl.allowed) {
    await safeSend(message.from, `⚠ Rate limit: try again in ${Math.ceil(rl.retryAfter/1000)}s`);
    break;
  }

  // parse multi-indexes + exclusions + message
  let raw = message.body.trim().replace(/^!tagexcept\s*/i, '').trim();
  const first = raw.split(/\s+/)[0] || '';
  if (!/^[0-9, ]+$/.test(first)) {
    await safeSend(message.from,
      '❗ Usage: !tagexcept <groupIndexes> <excluded> | <message>\nExamples:\n' +
      '!tagexcept 2 @john @mary | Meeting starts\n' +
      '!tagexcept 1,3 08123456789 | Hello team\n' +
      '!tagexcept 2 1,3,5 | Quick notice'
    );
    break;
  }

  const groupIndexes = first.split(/[, ]+/).map(n=>parseInt(n)).filter(Boolean);
  const beforePipe = raw.split('|')[0].replace(first,'').trim();
  const afterPipe = raw.split('|').slice(1).join('|').trim();
  const exclusionArgs = beforePipe.split(/\s+/).filter(x=>x && x!=='|');

  const exclusionTokens = [];
  const excludedSetGlobal = new Set();
  for (const t of exclusionArgs) {
    if (t.includes('@')) {
      const num = t.replace(/[^0-9]/g,''); if (num.length>=7) excludedSetGlobal.add(num+'@c.us'); continue;
    }
    if (/^\d+$/.test(t) && t.length>=7) { const f = t.startsWith('234')?t:'234'+t; excludedSetGlobal.add(f+'@c.us'); continue; }
    if (/^\d+(,\d+)*$/.test(t)) exclusionTokens.push(...t.split(',').map(x=>parseInt(x)));
  }

  const finalMsg = afterPipe || '*🔔 Attention (filtered)*';
  const success = [];

  for (const gIndex of groupIndexes) {
    const resolved = await resolveTargetGroupArg(gIndex);
    if (!resolved.group) { await safeSend(message.from, `❌ No group found for index ${gIndex}`); continue; }

    const groupId = resolved.group.groupId;
    const chat = await client.getChatById(groupId).catch(()=>null);
    if (!chat) { await safeSend(message.from, `❌ Could not fetch group for index ${gIndex}`); continue; }

    // use cache-aware fetch
    const participantJIDs = await getCachedMembers(sessionId, groupId, chat);
    if (!participantJIDs || !participantJIDs.length) {
      await safeSend(message.from, `⚠ No members found for ${resolved.group.name}; try !syncmembers`);
      continue;
    }

    // index-based exclusions
    for (const exIdx of exclusionTokens) {
      const j = participantJIDs[exIdx - 1]; if (j) excludedSetGlobal.add(j);
    }

    const mentionJIDs = participantJIDs.filter(j => !excludedSetGlobal.has(j) && j !== mySelf);
    if (!mentionJIDs.length) { await safeSend(message.from, `⚠ Nothing to mention in ${resolved.group.name} after exclusions.`); continue; }

    // high-perf chunk sender
    try {
      const res = await sendMentionsInChunks({ client, groupId, jids: mentionJIDs, text: finalMsg });
      success.push(`${resolved.group.name} (${res.sent} mentions across ${res.chunks} chunks)`);
    } catch (e) {
      logger.error(`[${sessionName}] tagexcept send failed for ${resolved.group.name}`, e);
    }

    // polite pause between groups
    await new Promise(r=>setTimeout(r, 500));
  }

  if (!success.length) await safeSend(message.from, "❌ No groups processed.");
  else await safeSend(message.from, `✅ Tag-except completed:\n• ${success.join("\n• ")}`);

  break;
}



case 'tagfew': {
    if (!isSelfChat) return;

    // ------------------------------------------------------------
    // 0️⃣ CLEAN GROUP INDEX
    // ------------------------------------------------------------
    const cleanedIndex = args[0] ? args[0].replace(/[^0-9]/g, '') : null;
    const providedIdx = cleanedIndex && !isNaN(cleanedIndex) ? parseInt(cleanedIndex) : null;

    if (!providedIdx) {
        await safeSend(message.from,
`❗ Usage: !tagfew <groupIndex> <targets> | <message>

Examples:
!tagfew 3 @john @mary | Private update
!tagfew 4 08123334444 07056667777 | Check this
!tagfew 2 1,3 | Important message for two people
`);
        break;
    }

    // ------------------------------------------------------------
    // 1️⃣ RESOLVE GROUP
    // ------------------------------------------------------------
    const resolved = await resolveTargetGroupArg(providedIdx);
    if (!resolved.group) {
        await safeSend(message.from, '❌ No target group found. Use !list or !use <index>');
        break;
    }

    const groupId = resolved.group.groupId;
    const chat = await client.getChatById(groupId).catch(() => null);

    if (!chat) {
        await safeSend(message.from, '❌ Could not fetch group chat.');
        break;
    }

    // ------------------------------------------------------------
    // 2️⃣ SAFE PARTICIPANT RESOLVER (DB → getParticipants → fallback)
    // ------------------------------------------------------------
    let participants = [];

    try {
        const dbList = await getMembersFromDB(sessionId, groupId);
        if (Array.isArray(dbList) && dbList.length) {
            participants = dbList.map(j => ({ id: { _serialized: j } }));
        }

        if (!participants.length && typeof chat.getParticipants === "function") {
            const fetched = await chat.getParticipants().catch(() => []);
            if (fetched.length) {
                participants = fetched;
                const jids = fetched.map(p => p.id._serialized);
                await setMembersForGroup(sessionId, groupId, jids);
            }
        }

        if (!participants.length && Array.isArray(chat.participants) && chat.participants.length) {
            participants = chat.participants;
            const jids = participants.map(p => p.id._serialized);
            await setMembersForGroup(sessionId, groupId, jids);
        }
    } catch {
        participants = [];
    }

    if (!participants.length) {
        await safeSend(
            message.from,
            `⚠ Unable to get members for *${resolved.group.name}*.\nTry promoting bot to admin and run !syncmembers.`
        );
        break;
    }

    const participantJIDs = participants.map(p => p.id._serialized);

    // ------------------------------------------------------------
    // 3️⃣ PARSE TARGETS (ONLY USERS YOU WANT TO TAG)
    // ------------------------------------------------------------
    const targetSet = new Set();

    // Everything after the index until the |
    const rawTargetSection = message.body.includes('|')
        ? message.body.split('|')[0]
        : message.body;

    const tokens = rawTargetSection.split(' ').slice(2); // skip command + index

    for (const token of tokens) {

        // A — @mentions
        if (token.includes('@')) {
            const num = token.replace(/[^0-9]/g, '');
            if (num.length >= 7) targetSet.add(`${num}@c.us`);
        }

        // B — phone numbers
        else if (/^\d+$/.test(token) && token.length >= 7) {
            const formatted = token.startsWith('234') ? token : '234' + token;
            targetSet.add(`${formatted}@c.us`);
        }

        // C — index list 1,3,5
        else if (/^\d+(,\d+)*$/.test(token)) {
            const idxs = token.split(',').map(n => parseInt(n.trim()));
            for (const i of idxs) {
                const jid = participantJIDs[i - 1];
                if (jid) targetSet.add(jid);
            }
        }
    }

    if (!targetSet.size) {
        await safeSend(message.from, '❗ No valid targets found.');
        break;
    }

    // ------------------------------------------------------------
    // 4️⃣ EXTRACT CUSTOM MESSAGE USING |
    // ------------------------------------------------------------
    let finalMsg = null;
    if (message.body.includes('|')) {
        finalMsg = message.body.split('|')[1].trim();
    }
    if (!finalMsg) finalMsg = '*🔔 Attention (selected users only)*';

    // ------------------------------------------------------------
    // 5️⃣ BUILD FINAL MENTION LIST
    // ------------------------------------------------------------
    const finalMentions = [];
    for (const jid of targetSet) {
        const contact = await client.getContactById(jid).catch(() => null);
        if (contact) finalMentions.push(contact);
    }

    // ------------------------------------------------------------
    // 6️⃣ SEND SAFELY (CHUNKED)
    // ------------------------------------------------------------
    async function sendInChunks(list, chunkSize = 50) {
        for (let i = 0; i < list.length; i += chunkSize) {
            const chunk = list.slice(i, i + chunkSize);
            try {
                await client.sendMessage(groupId, finalMsg, { mentions: chunk });
                await new Promise(r => setTimeout(r, 600));
            } catch (e) {
                logger.error(`[${sessionName}] tagfew chunk error`, e);
            }
        }
    }

    await sendInChunks(finalMentions);

    // ------------------------------------------------------------
    // 7️⃣ CONFIRMATION
    // ------------------------------------------------------------
    await safeSend(
        message.from,
        `✅ *TagFew completed* in *${resolved.group.name}*.\nTagged: ${[...targetSet].join(', ')}`
    );

    break;
}
  


      /* ---------- FORWARD ---------- */
case 'forwardone': {
    if (!isSelfChat) return;

    // must be a reply to a message to forward
    const quoted = await (async () => {
        try { return await message.getQuotedMessage(); } catch { return null; }
    })();

    if (!quoted) {
        await safeSend(message.from, '❗ Usage (reply to a message):\nReply to the message you want to forward, then type:\n!forwardone <groupIndex>');
        break;
    }

    // parse index
    const parts = message.body.trim().split(/\s+/);
    const groupIndex = parseInt(parts[1]);
    if (isNaN(groupIndex)) {
        await safeSend(message.from, '❗ First argument must be the group index. Example:\n!forwardone 3');
        break;
    }

    // resolve all groups (listall cache)
    let allGroups = [];
    try {
        const cached = await SavedGroupList.findOne({ sessionId: sessionId + "_all" }).lean().catch(() => null);
        if (cached && Array.isArray(cached.groups)) allGroups = cached.groups;
        if (!allGroups.length) {
            const chats = await client.getChats();
            allGroups = chats.filter(c => c.isGroup).map(c => ({ name: c.name || "Unnamed Group", groupId: c.id._serialized }));
            await SavedGroupList.findOneAndUpdate({ sessionId: sessionId + "_all" }, { groups: allGroups, updatedAt: new Date() }, { upsert: true }).catch(()=>null);
        }
    } catch {}

    const group = allGroups[groupIndex - 1];
    if (!group) {
        await safeSend(message.from, '❌ Invalid group index. Use !listall to view indexes.');
        break;
    }

    // load group chat and refresh members (Option C)
    const chat = await client.getChatById(group.groupId).catch(()=>null);
    if (!chat) {
        await safeSend(message.from, '❌ Could not load group. Bot may not be a member.');
        break;
    }

    let participants = [];
    try {
        const fetched = await chat.getParticipants().catch(()=>[]);
        if (fetched.length) {
            participants = fetched;
            await setMembersForGroup(sessionId, group.groupId, fetched.map(p => p.id._serialized)).catch(()=>null);
        }
    } catch { participants = []; }

    if (!participants.length) {
        await safeSend(message.from, `⚠ Unable to fetch members for *${chat.name}*.\nTry promoting bot to admin or !syncmembers.`);
        break;
    }

    const allJIDs = participants.map(p => p.id._serialized).filter(j => j !== mySelf);
    if (!allJIDs.length) {
        await safeSend(message.from, '⚠ No eligible members to forward to.');
        break;
    }

    // Safety constants
    const batchSize = 60;
    const msgDelay = () => 1200 + Math.random() * 1300;
    const batchDelay = 10 * 60 * 1000; // 10 min

    // Build batches
    const batches = [];
    for (let i = 0; i < allJIDs.length; i += batchSize) batches.push(allJIDs.slice(i, i + batchSize));

    await safeSend(message.from, `📤 *Forward-One Started*  
Group: *${chat.name}*  
Members: *${allJIDs.length}*  
Batches: *${batches.length}*  
Forwarding now (private forwards).`);

    // send batches sequentially
    async function sendBatch(batchIndex) {
        if (batchIndex >= batches.length) {
            await safeSend(message.from, `✅ *Forward-One Completed for ${chat.name}*`);
            return;
        }

        const batch = batches[batchIndex];
        let sent = 0;

        for (const jid of batch) {
            try {
                // forward quoted message to private chat jid
                await client.forwardMessages(jid, [quoted], true).catch(async () => {
                    // some clients expect message id; fallback: try forward by id if exists
                    try {
                        const mid = quoted.id?._serialized || quoted._data?.id?._serialized;
                        if (mid) await client.forwardMessages(jid, [mid], true);
                    } catch {}
                });
                sent++;
            } catch (e) {
                // ignore errors for single recipients
            }
            await new Promise(r => setTimeout(r, msgDelay()));
        }

        await safeSend(message.from, `📦 Batch ${batchIndex + 1}/${batches.length} completed — Sent: ${sent}/${batch.length}\nNext batch in 10 minutes...`);
        setTimeout(() => sendBatch(batchIndex + 1), batchDelay);
    }

    // start
    sendBatch(0);
    break;
}

case 'forwardmulti': {
    if (!isSelfChat) return;

    // must reply to a message
    const quoted = await (async () => {
        try { return await message.getQuotedMessage(); } catch { return null; }
    })();

    if (!quoted) {
        await safeSend(message.from, '❗ Usage (reply to a message):\nReply to the message you want to forward, then type:\n!forwardmulti 1,2 | <optional>');
        break;
    }

    // parse indexes
    const pipeIndex = message.body.indexOf('|');
    const beforePipe = pipeIndex === -1 ? message.body.trim() : message.body.substring(0, pipeIndex).trim();
    const parts = beforePipe.split(/\s+/);
    const raw = parts[1];
    if (!raw) {
        await safeSend(message.from, '❗ Provide group indexes. Example: !forwardmulti 1,2,5');
        break;
    }

    const groupIndexes = raw.split(',').map(x => parseInt(x.trim())).filter(n => !isNaN(n) && n > 0);
    if (!groupIndexes.length) {
        await safeSend(message.from, '❗ Invalid group indexes. Use comma-separated numbers.');
        break;
    }

    // load all groups (cache or rebuild)
    let allGroups = [];
    try {
        const cached = await SavedGroupList.findOne({ sessionId: sessionId + "_all" }).lean().catch(()=>null);
        if (cached && Array.isArray(cached.groups)) allGroups = cached.groups;
        if (!allGroups.length) {
            const chats = await client.getChats();
            allGroups = chats.filter(c => c.isGroup).map(c => ({ name: c.name || "Unnamed Group", groupId: c.id._serialized }));
            await SavedGroupList.findOneAndUpdate({ sessionId: sessionId + "_all" }, { groups: allGroups, updatedAt: new Date() }, { upsert: true }).catch(()=>null);
        }
    } catch {}

    const selectedGroups = groupIndexes.map(i => allGroups[i - 1]).filter(Boolean);
    if (!selectedGroups.length) {
        await safeSend(message.from, '❌ None of the requested groups were found. Use !listall to see indexes.');
        break;
    }

    // safety constants
    const batchSize = 60;
    const msgDelay = () => 1200 + Math.random() * 1300;
    const batchDelay = 10 * 60 * 1000;
    const groupDelay = 10 * 60 * 1000;

    await safeSend(message.from, `📤 *Forward-Multi Started* Groups: ${groupIndexes.join(', ')} — will process sequentially.`);

    // process one group (all its batches)
    async function processGroup(groupObj, idx, total) {
        const chat = await client.getChatById(groupObj.groupId).catch(()=>null);
        if (!chat) {
            await safeSend(message.from, `❌ Skipping group #${groupIndexes[idx - 1]} — cannot load chat.`);
            return;
        }

        // refresh members
        let participants = [];
        try {
            const fetched = await chat.getParticipants().catch(()=>[]);
            if (fetched.length) {
                participants = fetched;
                await setMembersForGroup(sessionId, groupObj.groupId, fetched.map(p => p.id._serialized)).catch(()=>null);
            }
        } catch {}

        if (!participants.length) {
            await safeSend(message.from, `⚠ Skipping ${chat.name} — cannot fetch members.`);
            return;
        }

        const allJIDs = participants.map(p => p.id._serialized).filter(j => j !== mySelf);
        if (!allJIDs.length) {
            await safeSend(message.from, `⚠ Skipping ${chat.name} — no eligible members.`);
            return;
        }

        const batches = [];
        for (let i = 0; i < allJIDs.length; i += batchSize) batches.push(allJIDs.slice(i, i + batchSize));

        await safeSend(message.from, `📦 Starting ${idx}/${total}: ${chat.name} — members: ${allJIDs.length}, batches: ${batches.length}`);

        async function sendBatch(bi) {
            if (bi >= batches.length) {
                await safeSend(message.from, `✔ Completed ${chat.name} — waiting 10 mins before next group...`);
                return;
            }

            const batch = batches[bi];
            let sent = 0;
            for (const jid of batch) {
                try {
                    await client.forwardMessages(jid, [quoted], true).catch(async () => {
                        try {
                            const mid = quoted.id?._serialized || quoted._data?.id?._serialized;
                            if (mid) await client.forwardMessages(jid, [mid], true);
                        } catch {}
                    });
                    sent++;
                } catch {}
                await new Promise(r => setTimeout(r, msgDelay()));
            }

            await safeSend(message.from, `📨 Batch ${bi + 1}/${batches.length} for ${chat.name} completed — Sent: ${sent}/${batch.length}\nNext batch in 10 mins...`);
            setTimeout(() => sendBatch(bi + 1), batchDelay);
        }

        sendBatch(0);
    }

    // process groups sequentially
    async function doGroups(i) {
        if (i >= selectedGroups.length) {
            await safeSend(message.from, '🎉 *Forward-Multi Completed for all requested groups!*');
            return;
        }

        const groupObj = selectedGroups[i];
        await processGroup(groupObj, i + 1, selectedGroups.length);

        // wait groupDelay then continue with next group
        setTimeout(() => doGroups(i + 1), groupDelay);
    }

    doGroups(0);
    break;
}

case 'forwardall': {
    if (!isSelfChat) return;

    // must reply to a message
    const quoted = await (async () => {
        try { return await message.getQuotedMessage(); } catch { return null; }
    })();

    if (!quoted) {
        await safeSend(message.from, '❗ Usage (reply): Reply to the message you want to forward, then type:\n!forwardall');
        break;
    }

    // load all groups (admin+member)
    let allGroups = [];
    try {
        const chats = await client.getChats();
        allGroups = chats.filter(c => c.isGroup).map(c => ({ name: c.name || "Unnamed Group", groupId: c.id._serialized }));
        // update cache
        await SavedGroupList.findOneAndUpdate({ sessionId: sessionId + "_all" }, { groups: allGroups, updatedAt: new Date() }, { upsert: true }).catch(()=>null);
    } catch {}

    if (!allGroups.length) {
        await safeSend(message.from, '❌ No groups found for this session.');
        break;
    }

    // safety
    const batchSize = 60;
    const msgDelay = () => 1200 + Math.random() * 1300;
    const batchDelay = 10 * 60 * 1000;
    const groupDelay = 10 * 60 * 1000;

    await safeSend(message.from, `📤 *Forward-All Started* — Processing ${allGroups.length} groups sequentially.`);

    // process single group (same as forwardmulti)
    async function processGroup(groupObj, idx, total) {
        const chat = await client.getChatById(groupObj.groupId).catch(()=>null);
        if (!chat) {
            await safeSend(message.from, `❌ Skipping group #${idx} — cannot load chat.`);
            return;
        }

        let participants = [];
        try {
            const fetched = await chat.getParticipants().catch(()=>[]);
            if (fetched.length) {
                participants = fetched;
                await setMembersForGroup(sessionId, groupObj.groupId, fetched.map(p => p.id._serialized)).catch(()=>null);
            }
        } catch {}

        if (!participants.length) {
            await safeSend(message.from, `⚠ Skipping ${chat.name} — cannot fetch members.`);
            return;
        }

        const allJIDs = participants.map(p => p.id._serialized).filter(j => j !== mySelf);
        if (!allJIDs.length) {
            await safeSend(message.from, `⚠ Skipping ${chat.name} — no eligible members.`);
            return;
        }

        const batches = [];
        for (let i = 0; i < allJIDs.length; i += batchSize) batches.push(allJIDs.slice(i, i + batchSize));

        await safeSend(message.from, `📦 Group ${idx}/${total}: ${chat.name} — Members: ${allJIDs.length}, Batches: ${batches.length}`);

        async function sendBatch(bi) {
            if (bi >= batches.length) {
                await safeSend(message.from, `✔ Finished ${chat.name} — waiting 10 mins before next group...`);
                return;
            }

            const batch = batches[bi];
            let sent = 0;
            for (const jid of batch) {
                try {
                    await client.forwardMessages(jid, [quoted], true).catch(async () => {
                        try {
                            const mid = quoted.id?._serialized || quoted._data?.id?._serialized;
                            if (mid) await client.forwardMessages(jid, [mid], true);
                        } catch {}
                    });
                    sent++;
                } catch {}
                await new Promise(r => setTimeout(r, msgDelay()));
            }

            await safeSend(message.from, `📨 Batch ${bi + 1}/${batches.length} for ${chat.name} completed — Sent: ${sent}/${batch.length}\nNext batch in 10 mins...`);
            setTimeout(() => sendBatch(bi + 1), batchDelay);
        }

        sendBatch(0);
    }

    async function doAllGroups(i) {
        if (i >= allGroups.length) {
            await safeSend(message.from, '🎉 *Forward-All Completed for ALL groups!*');
            return;
        }

        const groupObj = allGroups[i];
        await processGroup(groupObj, i + 1, allGroups.length);

        setTimeout(() => doAllGroups(i + 1), groupDelay);
    }

    doAllGroups(0);
    break;
}

/* ---------- OWNER-ONLY: Keyword management and !find deep search ---------- */
// Add this inside your switch(cmd) { ... } block.

case 'keyword': {
  // OWNER ONLY
  if (sender !== mySelf || !isSelfChat) return;
  const sub = (args[0] || '').toLowerCase();

  if (sub === 'add') {
    // Format: !keyword add <term> | <mapping>
    const full = args.slice(1).join(' ');
    const pipe = full.indexOf('|');
    if (pipe === -1) {
      await safeSend(message.from, 'Usage: !keyword add <term> | <mapping>\nExample: !keyword add ana | yesterday\nMapping can be a time (yesterday|last week|today) or media (image|document|audio) or both separated by space.');
      break;
    }
    const term = full.slice(0, pipe).trim();
    const mapping = full.slice(pipe+1).trim().toLowerCase();
    if (!term || !mapping) { await safeSend(message.from, 'Invalid term or mapping.'); break; }

    // Decide mapsToTime and/or mapsToMedia
    let mapsToTime = null, mapsToMedia = null;
    const mapTokens = mapping.split(/\s+/);
    for (const mt of mapTokens) {
      if (['today','yesterday','lastweek','last_week','last week','last-week','thisweek','lastmonth','last month','3','2'].includes(mt) || mt.match(/days?/)) {
        mapsToTime = mt;
      }
      if (['picture','image','photo','video','audio','document','file','pdf','sticker'].includes(mt)) {
        // normalize
        if (['picture','image','photo','pic','pics'].includes(mt)) mapsToMedia = 'image';
        else if (['video','vid'].includes(mt)) mapsToMedia = 'video';
        else if (['audio','voice','vn','ptt'].includes(mt)) mapsToMedia = 'audio';
        else if (['document','doc','pdf','file'].includes(mt)) mapsToMedia = 'document';
        else mapsToMedia = mt;
      }
    }

    // Save into AutoReply.recallKeywords
    let doc = await AutoReply.findOne({ sessionId }).catch(()=>null);
    if (!doc) doc = await AutoReply.create({ sessionId, rules: [], mediaRules: [], recallKeywords: [] });

    const exists = (doc.recallKeywords || []).find(r => r.term.toLowerCase() === term.toLowerCase());
    if (exists) {
      // update
      exists.mapsToTime = mapsToTime || exists.mapsToTime;
      exists.mapsToMedia = mapsToMedia || exists.mapsToMedia;
    } else {
      doc.recallKeywords = doc.recallKeywords || [];
      doc.recallKeywords.push({ term, mapsToTime, mapsToMedia });
    }
    await doc.save();
    await safeSend(message.from, `✅ Keyword added/updated: ${term} -> ${mapsToTime || ''} ${mapsToMedia || ''}`);
    break;
  }

  if (sub === 'remove') {
    // !keyword remove <term>
    const term = args.slice(1).join(' ').trim();
    if (!term) { await safeSend(message.from, 'Usage: !keyword remove <term>'); break; }
    let doc = await AutoReply.findOne({ sessionId }).catch(()=>null);
    if (!doc || !doc.recallKeywords || !doc.recallKeywords.length) { await safeSend(message.from, 'No keywords saved.'); break; }
    doc.recallKeywords = doc.recallKeywords.filter(r => r.term.toLowerCase() !== term.toLowerCase());
    await doc.save();
    await safeSend(message.from, `🗑 Removed keyword: ${term}`);
    break;
  }

  if (sub === 'list') {
    let doc = await AutoReply.findOne({ sessionId }).lean().catch(()=>null);
    const kws = (doc && Array.isArray(doc.recallKeywords)) ? doc.recallKeywords : [];
    if (!kws.length) { await safeSend(message.from, 'No recall keywords configured.'); break; }
    let out = '*📄 Recall Keywords:*\n\n';
    kws.forEach((k,i) => {
      out += `${i+1}. ${k.term} -> time: ${k.mapsToTime || '-'} media: ${k.mapsToMedia || '-'}\n`;
    });
    await safeSend(message.from, out);
    break;
  }

  await safeSend(message.from, 'Usage:\n!keyword add <term> | <mapping>\n!keyword remove <term>\n!keyword list');
  break;
}

// Owner-only deep hybrid search: !find <keyword>
case 'find': {
  // only owner
  if (sender !== mySelf || !isSelfChat) return;
  const keyword = args.join(' ').trim().toLowerCase();
  if (!keyword) { await safeSend(message.from, 'Usage: !find <keyword>'); break; }

  const SEARCHING_MSG = `I couldn’t find that picture in this group, searching other groups…`;
  const SCAN_LIMIT = 500;

  // 1) Search current chat
  const originChat = await message.getChat().catch(()=>null);
  let foundMessage = null;
  if (originChat) {
    try {
      const msgs = await originChat.fetchMessages({ limit: SCAN_LIMIT }).catch(()=>[]);
      for (const m of msgs) {
        const hasMedia = (typeof m.hasMedia === 'function') ? await m.hasMedia() : m.hasMedia;
        if (!hasMedia) continue;
        const caption = (m.body || '').toLowerCase();
        let filename = (m._data?.media?.filename || '').toLowerCase();
        if (caption.includes(keyword) || filename.includes(keyword)) { foundMessage = m; break; }
      }
    } catch (e) {}
  }

  if (foundMessage) {
    try { await foundMessage.forward(message.from); } catch (e) {
      try {
        const media = await foundMessage.downloadMedia();
        await safeSend(message.from, new MessageMedia(media.mimetype, media.data, media.filename), { caption: foundMessage.body || '' });
      } catch (e2) { await safeSend(message.from, 'Found media but failed to forward/send it.'); }
    }
    break;
  }

  // Not found in current chat -> notify and search admin groups then all groups
  await safeSend(message.from, SEARCHING_MSG);

  // get admin groups from saved cache
  let adminGroupIds = [];
  try {
    const cached = await SavedGroupList.findOne({ sessionId }).lean().catch(()=>null);
    adminGroupIds = (cached && Array.isArray(cached.groups)) ? cached.groups.map(g=>g.groupId) : [];
    if (!adminGroupIds.length) {
      // rebuild quick admin list
      const chats = await client.getChats().catch(()=>[]);
      for (const c of chats) {
        if (!c.isGroup) continue;
        const parts = Array.isArray(c.participants) ? c.participants : (typeof c.getParticipants === 'function' ? await c.getParticipants().catch(()=>[]) : []);
        const amIAdmin = parts.some(p => p.id?._serialized === mySelf && (p.isAdmin || p.isSuperAdmin));
        if (amIAdmin) adminGroupIds.push(c.id._serialized);
      }
    }
  } catch (e) { adminGroupIds = []; }

  // Build all groups list, ensuring admin groups are searched first
  const allChats = await client.getChats().catch(()=>[]);
  const allGroupIds = allChats.filter(c=>c.isGroup).map(c=>c.id._serialized);
  const remaining = allGroupIds.filter(id => !adminGroupIds.includes(id));
  const searchOrder = [...adminGroupIds, ...remaining];

  for (const gid of searchOrder) {
    try {
      const chat = await client.getChatById(gid).catch(()=>null);
      if (!chat) continue;
      const msgs = await chat.fetchMessages({ limit: SCAN_LIMIT }).catch(()=>[]);
      for (const m of msgs) {
        const hasMedia = (typeof m.hasMedia === 'function') ? await m.hasMedia() : m.hasMedia;
        if (!hasMedia) continue;
        const caption = (m.body || '').toLowerCase();
        let filename = (m._data?.media?.filename || '').toLowerCase();
        if (caption.includes(keyword) || filename.includes(keyword)) {
          foundMessage = m;
          // forward to origin
          try { await foundMessage.forward(message.from); } catch (err) {
            try {
              const media = await foundMessage.downloadMedia();
              await safeSend(message.from, new MessageMedia(media.mimetype, media.data, media.filename), { caption: foundMessage.body || '' });
            } catch (e2) { await safeSend(message.from, 'Found media but failed to forward/send it.'); }
          }
          const srcName = chat.name || gid;
          await safeSend(message.from, `Found in "${srcName}".`);
          break;
        }
      }
      if (foundMessage) break;
    } catch (e) { continue; }
  }

  if (!foundMessage) {
    await safeSend(message.from, `Sorry — I couldn't find a matching image in any of the groups I checked.`);
  }
  break;
}



      /* ---------- PER-GROUP ALLOW / DENY ---------- */
      case 'allow':
      case 'whitelistadd': {
        // usage: !allow <groupIndex> <234801234567>
        if (!args[0] || !args[1]) { await safeSend(message.from, 'Usage: !allow <groupIndex> <number>'); break; }
        const idx = parseInt(args[0]);
        if (isNaN(idx)) { await safeSend(message.from, 'Invalid group index.'); break; }
        const group = await getGroupFromIndex(sessionId, idx);
        if (!group) { await safeSend(message.from, 'Group not found. Run !list.'); break; }
        const jid = formatJid(args[1]);
        if (!jid) { await safeSend(message.from, 'Invalid number'); break; }
        await GroupPermission.updateOne(
          { botUserId: sessionId, groupId: group.groupId },
          { $addToSet: { allowed: jid }, $pull: { blocked: jid } },
          { upsert: true }
        );
        await safeSend(message.from, `✅ ${jid} added to whitelist for ${group.name}.`);
        break;
      }

      case 'unallow': {
        // usage: !unallow <groupIndex> <number>
        if (!args[0] || !args[1]) { await safeSend(message.from,'Usage: !unallow <groupIndex> <number>'); break; }
        const idx = parseInt(args[0]);
        const group = await getGroupFromIndex(sessionId, idx);
        if (!group) { await safeSend(message.from,'Group not found'); break; }
        const jid = formatJid(args[1]);
        await GroupPermission.updateOne(
          { botUserId: sessionId, groupId: group.groupId },
          { $pull: { allowed: jid } },
          { upsert: true }
        );
        await safeSend(message.from, `✅ ${jid} removed from whitelist for ${group.name}.`);
        break;
      }

      case 'deny':
      case 'block': {
        // usage: !deny <groupIndex> <number>
        if (!args[0] || !args[1]) { await safeSend(message.from,'Usage: !deny <groupIndex> <number>'); break; }
        const idx = parseInt(args[0]);
        const group = await getGroupFromIndex(sessionId, idx);
        if (!group) { await safeSend(message.from,'Group not found'); break; }
        const jid = formatJid(args[1]);
        await GroupPermission.updateOne(
          { botUserId: sessionId, groupId: group.groupId },
          { $addToSet: { blocked: jid }, $pull: { allowed: jid } },
          { upsert: true }
        );
        await safeSend(message.from, `⛔ ${jid} added to blocklist for ${group.name}.`);
        break;
      }

      case 'unblock': {
        if (!args[0] || !args[1]) { await safeSend(message.from,'Usage: !unblock <groupIndex> <number>'); break; }
        const idx = parseInt(args[0]);
        const group = await getGroupFromIndex(sessionId, idx);
        if (!group) { await safeSend(message.from,'Group not found'); break; }
        const jid = formatJid(args[1]);
        await GroupPermission.updateOne(
          { botUserId: sessionId, groupId: group.groupId },
          { $pull: { blocked: jid } },
          { upsert: true }
        );
        await safeSend(message.from, `✅ ${jid} removed from blocklist for ${group.name}.`);
        break;
      }

      case 'whitelist': {
        if (!args[0]) { await safeSend(message.from,'Usage: !whitelist <groupIndex>'); break; }
        const idx = parseInt(args[0]);
        const group = await getGroupFromIndex(sessionId, idx);
        if (!group) { await safeSend(message.from,'Group not found'); break; }
        const doc = await GroupPermission.findOne({ botUserId: sessionId, groupId: group.groupId }).lean().catch(()=>null);
        const list = (doc && Array.isArray(doc.allowed)) ? doc.allowed : [];
        await safeSend(message.from, `📜 Whitelist for ${group.name}:\n\n${list.join('\n') || 'No entries'}`);
        break;
      }

      case 'blocklist': {
        if (!args[0]) { await safeSend(message.from,'Usage: !blocklist <groupIndex>'); break; }
        const idx = parseInt(args[0]);
        const group = await getGroupFromIndex(sessionId, idx);
        if (!group) { await safeSend(message.from,'Group not found'); break; }
        const doc = await GroupPermission.findOne({ botUserId: sessionId, groupId: group.groupId }).lean().catch(()=>null);
        const list = (doc && Array.isArray(doc.blocked)) ? doc.blocked : [];
        await safeSend(message.from, `📵 Blocklist for ${group.name}:\n\n${list.join('\n') || 'No entries'}`);
        break;
      }

      /* ---------- SCHEDULER (same but uses group index) ---------- */
      case 'schedule': {
        // syntax: !schedule <groupIndex> HH:MM <group|dm> <once|daily|weekly> | <message>
        // example: !schedule 2 10:00 group daily | Good morning!
        const rest = full.slice(cmd.length).trim();
        const pipeIndex = rest.indexOf('|');
        if (pipeIndex === -1) {
          await safeSend(message.from, 'Usage: !schedule <groupIndex> HH:MM <group|dm> <once|daily|weekly> | <message>');
          break;
        }
        const left = rest.slice(0, pipeIndex).trim();
        const msgText = rest.slice(pipeIndex+1).trim();
        const leftParts = left.split(/\s+/);

        const idx = leftParts[0] && !isNaN(leftParts[0]) ? parseInt(leftParts[0]) : null;
        if (!idx) { await safeSend(message.from, 'You must supply a group index as the first argument'); break; }
        const time = leftParts[1];
        const mode = leftParts[2] || 'group';
        const repeat = leftParts[3] || 'once';

        if (!/^\d{1,2}:\d{2}$/.test(time)) { await safeSend(message.from, 'Invalid time. Use HH:MM'); break; }

        const group = await getGroupFromIndex(sessionId, idx);
        if (!group) { await safeSend(message.from, 'Group not found. Run !list.'); break; }

        const nextRun = hhmmToNextDate(time);
        const doc = new Schedule({
          userId: sessionId,
          chatId: group.groupId,
          creator: message.author || message.from,
          mode,
          targets: [],
          message: msgText,
          timeHHMM: time,
          nextRun,
          repeat,
          active: true
        });
        await doc.save();
        await safeSend(message.from, `✅ Schedule created for ${group.name}. Next run: ${doc.nextRun.toLocaleString()}. ID: ${doc._id}`);
        break;
      }

      case 'listschedules': {
        const docs = await Schedule.find({ userId: sessionId, active: true }).sort({ nextRun: 1 }).limit(100).lean();
        if (!docs.length) { await safeSend(message.from, 'No active schedules found.'); break; }
        let out = '*📅 Schedules:*\n\n';
        docs.forEach(d => out += `ID: ${d._id}\nNext: ${new Date(d.nextRun).toLocaleString()}\nMode: ${d.mode}\nRepeat: ${d.repeat}\nMessage: ${d.message}\n\n`);
        await safeSend(message.from, out);
        break;
      }

      case 'cancelschedule': {
        if (!args[0]) { await safeSend(message.from, 'Usage: !cancelschedule <id>'); break; }
        const id = args[0];
        const doc = await Schedule.findOne({ _id: id, userId: sessionId });
        if (!doc) { await safeSend(message.from, 'Schedule not found'); break; }
        doc.active = false;
        await doc.save();
        await safeSend(message.from, `✅ Schedule ${id} cancelled`);
        break;
      }

      default:
        await safeSend(message.from, 'Unknown command. Try !help');
    }

  } catch (e) {
    logger.error(`[${sessionName}] message handler error`, e);
  }
});

  // error handler
  client.on('error', (err) => {
    logger.error(`[${sessionName}] client error`, err);
  });
}

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// 🔄 AUTO-REFRESH ADMIN GROUP CACHE (every 12 hours)
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

function startAutoAdminGroupRefresh(client, sessionId, mySelf) {
    const REFRESH_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours

    async function refreshAdminGroups() {
        try {
            console.log(`♻️ [${sessionId}] Auto-refreshing admin groups...`);

            const chats = await client.getChats();
            const adminGroups = [];

            for (const c of chats) {
                if (!c.isGroup) continue;

                let participants = [];
                try {
                    if (Array.isArray(c.participants) && c.participants.length) {
                        participants = c.participants;
                    } else if (typeof c.getParticipants === "function") {
                        participants = await c.getParticipants();
                    }
                } catch {
                    participants = [];
                }

                const amIAdmin = participants.some(
                    p => p.id._serialized === mySelf && (p.isAdmin || p.isSuperAdmin)
                );

                if (amIAdmin) {
                    adminGroups.push({
                        name: c.name || 'Unnamed group',
                        groupId: c.id._serialized
                    });
                }
            }

            if (adminGroups.length) {
                await SavedGroupList.findOneAndUpdate(
                    { sessionId },
                    {
                        groups: adminGroups,
                        updatedAt: new Date()
                    },
                    { upsert: true }
                );

                console.log(`✅ [${sessionId}] Auto-refresh complete. Groups updated in cache.`);
            } else {
                console.log(`⚠️ [${sessionId}] No admin groups found during auto-refresh.`);
            }
        } catch (err) {
            console.error(`❌ Auto-refresh failed for ${sessionId}:`, err.message || err);
        }
    }

    // First run at startup (delay 30 seconds)
    setTimeout(refreshAdminGroups, 30 * 1000);

    // Schedule recurring refresh
    setInterval(refreshAdminGroups, REFRESH_INTERVAL);
}


// ---------------- Scheduler runner (per-session) ----------------
async function runSchedulerForSession(sessionId, client) {
  try {
    const now = new Date();
    const due = await Schedule.find({ userId: sessionId, active: true, nextRun: { $lte: now } }).limit(50);
    for (const job of due) {
      try {
        if (job.mode === 'group') {
          await client.sendMessage(job.chatId, job.message);
        } else if (job.mode === 'dm') {
          let targets = job.targets || [];
          if (!targets.length && job.chatId) {
            const chat = await client.getChatById(job.chatId).catch(()=>null);
            if (chat) {
              // const parts = chat.participants?.length ? chat.participants : await chat.fetchParticipants().catch(()=>[]);
              let parts = [];
try {
    if (Array.isArray(chat.participants) && chat.participants.length) {
        parts = chat.participants;
    } else if (typeof chat.getParticipants === "function") {
        parts = await chat.getParticipants();
    } else {
        parts = [];
    }
} catch {
    parts = [];
}

              targets = parts.map(p => p.id._serialized).filter(x => x !== client.info?.wid?._serialized);
            }
          }
          for (const t of targets) {
            try { await client.sendMessage(t, job.message); await new Promise(r=>setTimeout(r,200)); } catch(e){ logger.error('scheduler DM send error', e); }
          }
        }
        
        // update nextRun
        if (job.repeat === 'once') {
          job.active = false;
        } else if (job.repeat === 'daily') {
          const next = new Date(job.nextRun); next.setDate(next.getDate() + 1); job.nextRun = next;
        } else if (job.repeat === 'weekly') {
          const next = new Date(job.nextRun); next.setDate(next.getDate() + 7); job.nextRun = next;
        } else {
          job.active = false;
        }
        await job.save();
      } catch (e) {
        logger.error('Error executing scheduled job', e);
      }
    }
  } catch (e) {
    logger.error('Scheduler runner error', e);
  }
}

function createClient(sessionId) {
  // MongoStore handles auth restoration automatically
  const opts = createClientOptions(sessionId);
  const client = new Client(opts);
  setupClientEvents(client, sessionId, global.io || null);
  return client;
}

function createSession(sessionId) {
  if (clients.has(sessionId)) {
    logger.info(`Session ${sessionId} already exists`);
    return clients.get(sessionId);
  }
  const client = createClient(sessionId);
  clients.set(sessionId, client);
  client.initialize().catch(err => {
    logger.error(`Failed to initialize client ${sessionId}`, err);
    clients.delete(sessionId);
  });
  return client;
}

// createBotSession exposed for dashboard integration
async function createBotSession(userId, sessionId, workerIO) {
  try {
    // Store workerIO globally so createClient can access it
    if (workerIO && !global.io) {
      global.io = workerIO;
    }

    // ensure sessionId unique
    const created = createSession(sessionId);
    logger.info(`createBotSession: created session ${sessionId} for user ${userId}`);
    return created;
  } catch (e) {
    logger.error('createBotSession error', e);
    throw e;
  }
}


// =========================================
// RESTORE ALL SESSIONS ON SERVER STARTUP
// =========================================

/**
 * Configuration for session restoration
 */
const RESTORE_CONFIG = config.restoration;

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}


/**
 * Restore sessions in batches with prioritization
 */
async function restoreAllSessions(io) {
    try {
        if (mongoose.connection.readyState !== 1) {
            logger.info("⛔ Mongoose not connected - skipping session restore");
            return;
        }

        logger.info("♻ Starting intelligent WhatsApp session restoration...");

        // Get total session count first
        const totalCount = await Session.countDocuments({
            status: { $nin: ["disconnected", "failed", "auth_failed", "error"] }
        });

        if (totalCount === 0) {
            logger.info("📭 No sessions found to restore.");
            return;
        }

        // Start monitoring
        restorationMonitor.start(totalCount);

        // Restore in priority order
        await restoreSessionsByPriority(io, totalCount);

        // Complete monitoring
        restorationMonitor.complete();

        logger.info("🎉 Session restoration completed!");

        // Return stats for worker to emit
        return restorationMonitor.getStats();

    } catch (err) {
        logger.error("❌ restoreAllSessions error:", err);
        restorationMonitor.complete();
        throw err;
    }
}

/**
 * Restore sessions by priority (recently active first)
 */
async function restoreSessionsByPriority(io, totalCount) {
    const priorities = [
        {
            name: 'Recently Active',
            query: {
                status: 'connected',
                lastActive: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Last 24 hours
            }
        },
        {
            name: 'Connected',
            query: {
                status: 'connected',
                lastActive: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) }
            }
        },
        {
            name: 'Waiting QR',
            query: {
                status: 'waiting_qr'
            }
        },
        {
            name: 'Other Active',
            query: {
                status: { $nin: ["disconnected", "failed", "auth_failed", "error", "connected", "waiting_qr"] }
            }
        }
    ];

    let totalRestored = 0;
    let totalFailed = 0;
    let totalSkipped = 0;

    for (const priority of priorities) {
        const result = await restoreSessionBatch(io, priority);
        totalRestored += result.restored;
        totalFailed += result.failed;
        totalSkipped += result.skipped;
    }

    logger.info(`📊 Restoration Summary: ${totalRestored} restored, ${totalFailed} failed, ${totalSkipped} skipped`);
}

/**
 * Restore a batch of sessions matching a priority query
 */
async function restoreSessionBatch(io, priority) {
    let restored = 0;
    let failed = 0;
    let skipped = 0;
    let skip = 0;

    logger.info(`🔄 Restoring ${priority.name} sessions...`);

    while (true) {
        // Fetch batch
        const sessions = await Session.find(priority.query)
            .sort({ lastActive: -1 }) // Most recently active first
            .skip(skip)
            .limit(RESTORE_CONFIG.BATCH_SIZE)
            .lean();

        if (sessions.length === 0) {
            break; // No more sessions in this priority
        }

        logger.info(`📦 Processing batch: ${skip + 1}-${skip + sessions.length} (${priority.name})`);

        // Process batch with concurrency control
        const results = await processBatchConcurrently(sessions, io);
        
        restored += results.restored;
        failed += results.failed;
        skipped += results.skipped;

        skip += RESTORE_CONFIG.BATCH_SIZE;

        // Delay between batches to prevent overwhelming the system
        if (sessions.length === RESTORE_CONFIG.BATCH_SIZE) {
            logger.info(`⏸️ Pausing ${RESTORE_CONFIG.BATCH_DELAY_MS}ms before next batch...`);
            await new Promise(resolve => setTimeout(resolve, RESTORE_CONFIG.BATCH_DELAY_MS));
        }
    }

    logger.info(`✅ ${priority.name}: ${restored} restored, ${failed} failed, ${skipped} skipped`);
    
    return { restored, failed, skipped };
}

/**
 * Process a batch of sessions with concurrency control
 */
async function processBatchConcurrently(sessions, io) {
    const results = { restored: 0, failed: 0, skipped: 0 };
    
    // Process sessions in chunks to limit concurrent initializations
    for (let i = 0; i < sessions.length; i += RESTORE_CONFIG.MAX_CONCURRENT_RESTORES) {
        const chunk = sessions.slice(i, i + RESTORE_CONFIG.MAX_CONCURRENT_RESTORES);
        
        const promises = chunk.map(async (session, index) => {
            // Stagger session initialization
            await new Promise(resolve => 
                setTimeout(resolve, index * RESTORE_CONFIG.SESSION_INIT_DELAY_MS)
            );
            
            return restoreSingleSession(session, io);
        });

        const chunkResults = await Promise.allSettled(promises);
        
        chunkResults.forEach(result => {
            if (result.status === 'fulfilled') {
                if (result.value === 'restored') results.restored++;
                else if (result.value === 'skipped') results.skipped++;
                else results.failed++;
            } else {
                results.failed++;
            }
        });
    }

    return results;
}

/**
 * Restore a single session with timeout
 */
async function restoreSingleSession(session, io) {
    const sessionId = session.sessionId;
    const userId = session.userId;

    try {
        // Check if already restored
        if (clients.has(sessionId)) {
            logger.info(`⏭️ Session ${sessionId} already active, skipping`);
            return 'skipped';
        }

        // Check if auth data exists in MongoDB
        const authData = await SessionAuth.findOne({ sessionId });

        if (!authData) {
            logger.info(`⚠️ No auth data for ${sessionId}. Marking as disconnected.`);
            
            await Session.findOneAndUpdate(
                { sessionId },
                { 
                    status: 'disconnected',
                    errorMessage: 'Session data lost. Please reconnect.',
                    disconnectedAt: new Date()
                }
            );
            
            return 'skipped';
        }

        logger.info(`♻️ Restoring session: ${sessionId} (User: ${userId})`);

        // Restore with timeout
        const timeout = session.status === 'connected' 
            ? RESTORE_CONFIG.PRIORITY_RESTORE_TIMEOUT_MS 
            : RESTORE_CONFIG.REGULAR_RESTORE_TIMEOUT_MS;

        await Promise.race([
            createBotSession(userId, sessionId, io),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Session restore timeout')), timeout)
            )
        ]);

        logger.info(`✅ Restored: ${sessionId}`);
        return 'restored';

    } catch (err) {
        logger.error(`❌ Failed to restore ${sessionId}: ${err.message}`);
        
        // Update session status
        try {
            await Session.findOneAndUpdate(
                { sessionId },
                { 
                    status: 'error',
                    errorMessage: `Restore failed: ${err.message}`,
                    updatedAt: new Date()
                }
            );
        } catch (updateErr) {
            logger.error(`Failed to update session status for ${sessionId}:`, updateErr);
        }
        
        return 'failed';
    }
}

/**
 * Resume a specific user session (called from payment webhook)
 */
async function resumeUserSession(userId, sessionId, io) {
    try {
        logger.info(`🔄 Resuming session ${sessionId} for user ${userId}`);

        // Check if session already exists
        if (clients.has(sessionId)) {
            logger.info(`✅ Session ${sessionId} already active`);
            return;
        }

        // Verify session exists in database
        const session = await Session.findOne({ sessionId, userId });
        if (!session) {
            throw new Error(`Session ${sessionId} not found for user ${userId}`);
        }

        // Check auth data
        const authData = await SessionAuth.findOne({ sessionId });
        if (!authData) {
            throw new Error(`No auth data found for session ${sessionId}`);
        }

        // Update session status
        await Session.findOneAndUpdate(
            { sessionId },
            { 
                status: 'connecting',
                errorMessage: null,
                updatedAt: new Date()
            }
        );

        // Create bot session
        await createBotSession(userId, sessionId, io);

        logger.info(`✅ Successfully resumed session ${sessionId}`);

    } catch (err) {
        logger.error(`❌ Failed to resume session ${sessionId}:`, err.message);
        
        // Mark as failed
        await Session.findOneAndUpdate(
            { sessionId },
            { 
                status: 'failed',
                errorMessage: `Resume failed: ${err.message}`,
                updatedAt: new Date()
            }
        );
        
        throw err;
    }
}

/**
 * Lazy restore: restore a session on-demand when needed
 */
async function lazyRestoreSession(sessionId, io) {
    try {
        // Check if already active
        if (clients.has(sessionId)) {
            logger.info(`Session ${sessionId} already active`);
            return clients.get(sessionId);
        }

        logger.info(`🔄 Lazy restoring session: ${sessionId}`);

        // Get session from database
        const session = await Session.findOne({ sessionId });
        if (!session) {
            throw new Error(`Session ${sessionId} not found`);
        }

        // Check auth data
        const authData = await SessionAuth.findOne({ sessionId });
        if (!authData) {
            throw new Error(`No auth data for session ${sessionId}`);
        }

        // Restore the session
        await createBotSession(session.userId, sessionId, io);
        
        logger.info(`✅ Lazy restore successful: ${sessionId}`);
        return clients.get(sessionId);

    } catch (err) {
        logger.error(`❌ Lazy restore failed for ${sessionId}:`, err.message);
        throw err;
    }
}


// tiny start helper for local dev
function start(count = 1) {
  for (let i = 0; i < count; i++) {
    const sid = `session-${Date.now()}-${i}`;
    createSession(sid);
  }
}

// Add this near the top with other helper functions
async function canUseCommand(userId, commandName, userSubscription) {
    try {
        const User = require('./models/User');
        const CommandGrant = require('../models/CommandGrant');
        const { subscriptionPlans } = require('../server/server');
        
        const user = await User.findById(userId);
        if (!user) return false;
        
        // ✅ 1. Exemptions (always work)
        if (user.isExemptFromPayment && user.isExemptFromPayment()) return true;
        if (user.isBotOwner && user.isBotOwner()) return true;
        if (user.isSystemAdmin && typeof user.isSystemAdmin === 'function' && user.isSystemAdmin()) return true;
        
        // ✅ 2. Check if subscription is active
        const now = new Date();
        const isSubscriptionActive = user.subscriptionExpiry && new Date(user.subscriptionExpiry) > now;
        const isPaymentValid = user.paymentStatus === 'paid' || user.paymentStatus === 'trial';
        
        // If subscription expired, only allow basic commands
        if (!isSubscriptionActive && !isPaymentValid) {
            return ['ping', 'help', 'status'].includes(commandName);
        }
        
        // ✅ 3. Plan commands
        const plan = subscriptionPlans[userSubscription] || subscriptionPlans.free;
        if (plan.allowedCommands === 'all') return true;
        if (Array.isArray(plan.allowedCommands) && plan.allowedCommands.includes(commandName)) return true;
        
        // ✅ 4. User.customCommands (only if subscription active)
        if (Array.isArray(user.customCommands) && user.customCommands.includes(commandName)) return true;
        
        // ✅ 5. CommandGrant (only for CURRENT plan)
        const customGrant = await CommandGrant.findOne({
            $and: [
                {
                    $or: [
                        { userId: userId, commandName: commandName },
                        { planType: userSubscription, commandName: commandName } // CURRENT plan only
                    ]
                },
                { isActive: true },
                {
                    $or: [
                        { expiresAt: null },
                        { expiresAt: { $gt: now } }
                    ]
                }
            ]
        });
        
        return !!customGrant;
        
    } catch (error) {
        console.error('Error checking command permission:', error);
        return false;
    }
}

// Find where commands are processed and add this check:
async function handleCommand(message, sessionId, userId, userSubscription) {
    const text = message.body.trim();
    if (!text.startsWith(COMMAND_PREFIX)) return;
    
    const parts = text.slice(COMMAND_PREFIX.length).split(' ');
    const command = parts[0].toLowerCase();
    
    // Check permission
    const hasPermission = await canUseCommand(userId, command, userSubscription);
    
    if (!hasPermission) {
        await message.reply(`❌ You don't have access to the "${command}" command.\n\n` +
            `This command is not included in your current plan.\n` +
            `Upgrade your subscription or contact admin for access.`);
        return;
    }
    
    // Process command...
    switch(command) {
        case 'tag':
            await handleTagCommand(message, sessionId);
            break;
        case 'tagexcept':
            await handleTagExceptCommand(message, sessionId);
            break;
        // ... other commands
    }
}

// graceful shutdown
async function gracefulShutdown() {
  logger.info('Graceful shutdown: destroying clients');
  for (const [sid, client] of clients.entries()) {
    try { await client.destroy(); } catch (e) { logger.error(`destroy ${sid} failed`, e); }
  }
  process.exit(0);
}
process.once('SIGINT', gracefulShutdown);
process.once('SIGTERM', gracefulShutdown);


// Export the new function
module.exports = {
    createBotSession,
    restoreAllSessions,
    resumeUserSession,
    lazyRestoreSession,
    start,
    clients,
    restorationMonitor
};

// if run directly, start one session (dev)
if (require.main === module) {
  start(1);
}
