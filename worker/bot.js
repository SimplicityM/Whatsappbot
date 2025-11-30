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
const SavedGroupList = require('./models/SavedGroupList');
const ActiveGroup = require('./models/ActiveGroup');
const GroupMembers = require('./models/GroupMembers');
const AutoReply = require('./models/AutoReply');

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


//
// === HIGH-PERF HELPERS: members cache, rate-limiter, chunked sender ===
// Paste this AFTER getMembersFromDB in bot.js
//

// TUNABLES (env-friendly)
const CACHE_TTL_MS = parseInt(process.env.MEMBERS_CACHE_TTL_MS || '300000'); // 5m
const CACHE_REFRESH_AFTER_MS = parseInt(process.env.MEMBERS_CACHE_REFRESH_AFTER_MS || '240000'); // 4m
const CHUNK_SIZE = parseInt(process.env.TAG_CHUNK_SIZE || '100'); // mentions/chunk
const CONCURRENCY = parseInt(process.env.TAG_CONCURRENCY || '3'); // parallel chunk senders
const CHUNK_DELAY_MS = parseInt(process.env.TAG_CHUNK_DELAY_MS || '400'); // polite pause
const MAX_RETRIES = 3;
const RATE_LIMIT_TOKENS = parseInt(process.env.RATE_LIMIT_TOKENS || '2'); // tokens per window
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'); // 1m

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
const COMMAND_PREFIX = '!';
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
      dataPath: './.wwebjs_auth',
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

  client.on('authenticated', () => {
    logger.info(`[${sessionName}] authenticated`);
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
━━━━━━━━━━━━━━━━━━
✨ WELCOME TO TAGTHEMALL BOT ✨
━━━━━━━━━━━━━━━━━━

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


  // generic message handler (per-client)
// client.on('message_create', async (message) => {
//   try {
//     // only process commands (ignore status & empty)
//     if (!message.body || message.from === 'status@broadcast') return;

//     // ensure selfId is set
//     if (!client.info || !client.info.wid) {
//       if (message.fromMe) {
//         client.info = client.info || {};
//         client.info.wid = client.info.wid || { _serialized: message.from };
//       }
//     }

//     const mySelf = client.info?.wid?._serialized;

//     // determine sender
//     const sender = message.fromMe ? mySelf : message.from;
//     const isSelfChat = sender === mySelf;

//     // --------------------------------------------------
//     // 🟢 RECORD GROUP MESSAGE SENDERS INTO DB (NEW)
//     // --------------------------------------------------
//     try {
//       const chat = await message.getChat().catch(() => null);

//       if (chat && chat.isGroup) {
//         const senderJid = message.author || message.from;

//         if (senderJid) {
//           await addMemberToGroup(
//             sessionId,
//             chat.id._serialized || chat.id,
//             senderJid
//           );
//         }
//       }
//     } catch (e) {
//       // ignore db errors
//     }
//     // --------------------------------------------------

//     // --------------------------------------------------
//     // 🟢 SELF-CHAT COMMAND FILTER + ✔️ REACTION
//     // --------------------------------------------------
//     if (message.body.startsWith(COMMAND_PREFIX)) {

//       // Only owner can run commands
//       if (sender !== mySelf) return;

//       // Only self-chat allowed
//       if (!isSelfChat) return;

//       // Reaction to confirm command
//       try {
//         await message.react('✔️');
//       } catch {}
//     }

//     // If no command prefix, stop here
//     if (!message.body.startsWith(COMMAND_PREFIX)) return;

//     // --------------------------------------------------
//     // 🟢 COMMAND PARSER
//     // --------------------------------------------------
//     const full = message.body.slice(COMMAND_PREFIX.length).trim();
//     const [cmdRaw, ...args] = full.split(/\s+/);
//     const cmd = (cmdRaw || '').toLowerCase();

//     // --------------------------------------------------
//     // Your entire command switch block stays exactly as is
//     // --------------------------------------------------

//     async function fetchAndSaveAdminGroups() {
//       let chats = await client.getChats();

//       if (chats.length < CHAT_SYNC_THRESHOLD) {
//         for (let i = 0; i < CHAT_SYNC_WAIT_ITER; i++) {
//           if (chats.length > CHAT_SYNC_THRESHOLD) break;
//           await new Promise(r => setTimeout(r, 500));
//           chats = await client.getChats();
//         }
//       }

//       const adminGroups = [];

//       for (const c of chats) {
//         if (!c.isGroup) continue;

//         let participants = [];
//         try {
//           if (Array.isArray(c.participants) && c.participants.length) {
//             participants = c.participants;
//           } else if (typeof c.getParticipants === "function") {
//             participants = await c.getParticipants();
//           }
//         } catch {
//           participants = [];
//         }

//         const amIAdmin = participants.some(p =>
//           p.id._serialized === mySelf &&
//           (p.isAdmin || p.isSuperAdmin)
//         );

//         if (amIAdmin)
//           adminGroups.push({
//             name: c.name || 'Unnamed group',
//             groupId: c.id._serialized
//           });
//       }

//       if (adminGroups.length) {
//         await SavedGroupList.findOneAndUpdate(
//           { sessionId },
//           { groups: adminGroups, updatedAt: new Date() },
//           { upsert: true }
//         );
//       }

//       return adminGroups;
//     }

    
//   async function resolveTargetGroupArg(argIndex) {
//     try {
//         // 1️⃣ Load cached admin groups for this session
//         let cached = await SavedGroupList.findOne({ sessionId })
//             .lean()
//             .catch(() => null);

//         let adminGroups =
//             cached && Array.isArray(cached.groups) ? cached.groups : [];

//         // If no cache exists → rebuild FAST
//         if (!adminGroups.length) {
//             logger.warn(`[${sessionId}] No cached admin groups — rebuilding list.`);

//             const chats = await client.getChats();
//             adminGroups = [];

//             for (const c of chats) {
//                 if (!c.isGroup) continue;

//                 let parts = [];
//                 try {
//                     if (Array.isArray(c.participants) && c.participants.length) {
//                         parts = c.participants;
//                     } else if (typeof c.getParticipants === "function") {
//                         parts = await c.getParticipants();
//                     }
//                 } catch { parts = []; }

//                 const amIAdmin = parts.some(
//                     p =>
//                         p.id?._serialized === client.info?.wid?._serialized &&
//                         (p.isAdmin || p.isSuperAdmin)
//                 );

//                 if (amIAdmin) {
//                     adminGroups.push({
//                         name: c.name || 'Unnamed Group',
//                         groupId: c.id._serialized,
//                     });
//                 }
//             }

//             // Save rebuilt cache
//             await SavedGroupList.findOneAndUpdate(
//                 { sessionId },
//                 { groups: adminGroups, updatedAt: new Date() },
//                 { upsert: true }
//             ).catch(() => null);
//         }

//         // 2️⃣ If user passed an index → resolve directly
//         if (argIndex && !isNaN(argIndex)) {
//             const idx = parseInt(argIndex);
//             const arrayIndex = idx - 1;

//             if (adminGroups[arrayIndex]) {
//                 return {
//                     index: idx,
//                     group: adminGroups[arrayIndex],
//                 };
//             }

//             return { index: null, group: null };
//         }

//         // 3️⃣ No index → try to load last active group (from !use)
//         const active = await ActiveGroup.findOne({ sessionId })
//             .lean()
//             .catch(() => null);

//         if (active) {
//             // Find this active group in cache
//             const match = adminGroups.find(g => g.groupId === active.groupId);

//             if (match) {
//                 return {
//                     index: adminGroups.indexOf(match) + 1,
//                     group: match
//                 };
//             }
//         }

//         // 4️⃣ Nothing found
//         return { index: null, group: null };

//     } catch (e) {
//         logger.error(`[${sessionId}] resolveTargetGroupArg ERROR`, e);
//         return { index: null, group: null };
//     }
// }


client.on('message_create', async (message) => {
  try {
    // only process commands (ignore status & empty)
    if (!message.body || message.from === 'status@broadcast') return;

    // Track daily usage
const userMatch = sessionId.match(/^session-([^-]+)-/);
const userId = userMatch ? userMatch[1] : null;
if (userId) {
    await trackDailyUsage(userId, 'message');
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
    // 🟢 COMMAND PERMISSION CHECK
    // --------------------------------------------------
    // Get userId from sessionId (format: session-<userId>-<timestamp>)
    const userMatch = sessionId.match(/^session-([^-]+)-/);
    const userId = userMatch ? userMatch[1] : null;

    if (userId) {
        try {
            // Fetch user document from database
            const userDoc = await User.findById(userId).lean();
            
            if (userDoc) {
                // Define subscription plan hierarchy and their allowed commands
               const subscriptionPlans = {
                'free': ['ping', 'help', 'status', 'list', 'tag'], // ✅ Added free plan
                'starter': ['ping', 'help', 'status', 'list', 'tag', 'tagexcept'],
                'professional': ['ping', 'help', 'status', 'list', 'tag', 'tagexcept', 'broadcast', 'auto_reply', 'analytics', 'scheduler'],
                'business': ['ping', 'help', 'status', 'list', 'tag', 'tagexcept', 'broadcast', 'auto_reply', 'analytics', 'scheduler', 'custom_commands', 'export', 'dmall', 'tagfew', 'forward'],
                'enterprise': 'all' // All commands
            };

                const userSubscription = userDoc.subscription || 'starter';
                const allowedCommands = subscriptionPlans[userSubscription] || [];
                
                // Check if command is allowed by subscription
                const hasAccess = allowedCommands === 'all' || allowedCommands.includes(cmd);
                
                // Check if user has custom command access
                const userCustomCommands = userDoc.customCommands || [];
                const hasCustomAccess = userCustomCommands.includes(cmd);

                // Check if subscription is active (not expired)
                const now = new Date();
                const isSubscriptionActive = userDoc.subscriptionExpiry && new Date(userDoc.subscriptionExpiry) > now;
                const isPaymentValid = userDoc.paymentStatus === 'paid' || userDoc.exemptFromPayment;

                // If subscription expired and payment not valid, block all premium commands
                if (!isSubscriptionActive && !isPaymentValid && !['ping', 'help', 'status'].includes(cmd)) {
                    await safeSend(message.from, `❌ Your subscription has expired. Please renew to continue using premium commands.\n\nVisit: https://yourwebsite.com/pricing`);
                    return;
                }

                // If command not allowed by subscription and not in custom commands
                if (!hasAccess && !hasCustomAccess) {
                    const requiredPlan = Object.keys(subscriptionPlans).find(plan => 
                        subscriptionPlans[plan] === 'all' || subscriptionPlans[plan].includes(cmd)
                    ) || 'business';
                    
                    await safeSend(message.from, `❌ Command !${cmd} requires ${requiredPlan} subscription or higher.\n\nYour current plan: ${userSubscription}\n\nUpgrade at: https://yourwebsite.com/pricing`);
                    return;
                }
            }
        } catch (error) {
            logger.error(`[${sessionId}] Permission check error:`, error);
            // Continue anyway if there's an error checking permissions
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

    // ------------ COMMANDS ------------
    switch (cmd) {
case 'help': {
    if (!isSelfChat) return;

    const text = `
━━━━━━━━━━━━━━━━━━━━━━━━━━
✨ *TAGTHEMALL BOT COMMANDS* ✨
━━━━━━━━━━━━━━━━━━━━━━━━━━

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

━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 *TIP:* You can type !tag without index if you used !use before.
━━━━━━━━━━━━━━━━━━━━━━━━━━
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
                out += `${i + 1}. *${g.name}*\n   ID: ${g.groupId}\n\n`;
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

//     // Save cache
//     if (adminGroups.length) {
//         await SavedGroupList.findOneAndUpdate(
//             { sessionId },
//             { groups: adminGroups, updatedAt: new Date() },
//             { upsert: true }
//         );
//     }

//     let out = '*📋 Updated Admin Group List:*\n\n';
//     adminGroups.forEach((g, i) => {
//         out += `${i + 1}. *${g.name}*\n   ID: ${g.groupId}\n\n`;
//     });
//     out += '\n⚡ Next time, just run `!list` (instant)\n🔄 To re-scan again use: `!list refresh`';
//     await safeSend(message.from, out);

//     break;
// }

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
        out += `${i + 1}. *${g.name}*\n   ID: ${g.groupId}\n\n`;
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
                out += `${i + 1}. *${g.name}*\n   ID: ${g.groupId}\n\n`;
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
        out += `${i + 1}. *${g.name}*\n   ID: ${g.groupId}\n\n`;
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

    // usage: !dmall <groupIndex> | <message>
    const full = args.join(' ');
    const pipeIndex = full.indexOf('|');

    if (pipeIndex === -1) {
        await safeSend(message.from,
            '❗ Usage:\n!dmall <groupIndex> | <message>\nExample:\n!dmall 2 | Hello everyone'
        );
        break;
    }

    const groupIndex = parseInt(full.slice(0, pipeIndex).trim());
    const msgText = full.slice(pipeIndex + 1).trim();

    if (!groupIndex || !msgText) {
        await safeSend(message.from, '❗ Missing group index or message.');
        break;
    }

    // resolve group
    const resolved = await resolveTargetGroupArg(groupIndex);
    if (!resolved.group) {
        await safeSend(message.from, '❌ Invalid group index.');
        break;
    }

    // fetch group chat
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

        if (Array.isArray(dbList) && dbList.length) {
            participants = dbList.map(j => ({ id: { _serialized: j } }));
        } 
        else if (typeof chat.getParticipants === "function") {
            const fetched = await chat.getParticipants().catch(() => []);
            if (fetched.length) {
                participants = fetched;

                const jids = fetched.map(p => p.id?._serialized || p);
                await setMembersForGroup(sessionId, resolved.group.groupId, jids);
            }
        } 
        else if (Array.isArray(chat.participants) && chat.participants.length) {
            participants = chat.participants;

            const jids = participants
                .map(p => p.id?._serialized || null)
                .filter(Boolean);

            await setMembersForGroup(sessionId, resolved.group.groupId, jids);
        }
    } catch {
        participants = [];
    }

    if (!participants.length) {
        await safeSend(
            message.from,
            `⚠ Unable to fetch members for *${resolved.group.name}*.\n` +
            `This may happen in Community subgroups.\n` +
            `Try !syncmembers if bot becomes admin.`
        );
        break;
    }

    // convert to JIDs
    const allJids = participants
        .map(p => p.id._serialized)
        .filter(j => j !== mySelf); // skip bot

    // ------------------------------------------------------------
    // 📨 SEND DM TO EACH MEMBER
    // ------------------------------------------------------------
    let delivered = 0;

    await safeSend(
        message.from,
        `📨 *DM-All Started*\nSending message to ${allJids.length} members of *${resolved.group.name}*...`
    );

    for (const jid of allJids) {
        try {
            await client.sendMessage(jid, msgText);
            delivered++;
        } catch (e) {
            logger.error("dmall send error", e);
        }

        // throttle to avoid WhatsApp spam detection
        await new Promise(r => setTimeout(r, 350));
    }

    await safeSend(
        message.from,
        `✅ *DM-All Completed*\nMessage delivered to **${delivered}** members.`
    );

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
!dmselected 3 1,3,5 | Important update`);
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
    // 2️⃣ Resolve Group
    // ------------------------------------------------------------
    const resolved = await resolveTargetGroupArg(groupIndex);
    if (!resolved.group) {
        await safeSend(message.from, '❌ Invalid group index. Run !list');
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
    const resolved = await resolveTargetGroupArg(providedIdx);

    if (!resolved.group) {
        await safeSend(message.from, '❌ No target group found. Run !list or set a default with !use');
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
    const resolved = await resolveTargetGroupArg(providedIdx);

    if (!resolved.group) {
        await safeSend(message.from, '❌ No target group found. Run !list or !use <index>');
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
        out += `${i + 1}. *${g.name}*\n   ID: ${g.groupId}\n\n`;
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
  

case 'forwardall': {
    if (!isSelfChat) return;

    // usage: !forwardall <groupIndex> <message>
    if (args.length < 2) {
        await safeSend(message.from,
            "Usage:\n!forwardall <groupIndex> <message>\nExample:\n!forwardall 20 Hello everyone!");
        break;
    }

    // 1️⃣ Extract group index
    const groupIndex = parseInt(args[0]);
    if (isNaN(groupIndex)) {
        await safeSend(message.from, "❌ First argument must be a group index.");
        break;
    }

    // 2️⃣ Extract message text
    const msgText = args.slice(1).join(" ").trim();
    if (!msgText) {
        await safeSend(message.from, "❌ Message cannot be empty.");
        break;
    }

    // 3️⃣ Resolve group
    const resolved = await resolveTargetGroupArg(groupIndex);
    if (!resolved.group) {
        await safeSend(message.from, "❌ Invalid group index. Run !list first.");
        break;
    }

    const chat = await client.getChatById(resolved.group.groupId).catch(() => null);
    if (!chat) {
        await safeSend(message.from, "❌ Could not fetch group.");
        break;
    }

    // 4️⃣ Safe participant resolver (DB → fetch → fallback)
    let participants = [];
    try {
        const dbList = await getMembersFromDB(sessionId, resolved.group.groupId);

        if (dbList?.length) {
            participants = dbList.map(j => ({ id: { _serialized: j } }));
        } else if (typeof chat.getParticipants === "function") {
            const fetched = await chat.getParticipants().catch(() => []);
            if (fetched.length) {
                participants = fetched;
                const jids = fetched.map(p => p.id._serialized);
                await setMembersForGroup(sessionId, resolved.group.groupId, jids);
            }
        } else if (chat.participants?.length) {
            participants = chat.participants;
            const jids = participants.map(p => p.id._serialized);
            await setMembersForGroup(sessionId, resolved.group.groupId, jids);
        }
    } catch {
        participants = [];
    }

    if (!participants.length) {
        await safeSend(message.from, `⚠ Cannot get members of *${resolved.group.name}*.`);
        break;
    }

    const JIDS = participants.map(p => p.id._serialized);

    // 5️⃣ Send private DMs one by one
    let delivered = 0;
    await safeSend(message.from,
        `📨 Sending your message privately to **${JIDS.length}** members of *${resolved.group.name}*...`
    );

    for (const jid of JIDS) {
        if (jid === mySelf) continue; // skip bot

        try {
            await client.sendMessage(jid, msgText);
            delivered++;
        } catch (e) {
            logger.error("forwardall DM error:", e);
        }

        await new Promise(r => setTimeout(r, 300)); // anti-spam throttle
    }

    await safeSend(message.from,
        `✅ *ForwardAll completed!*\nMessage delivered to **${delivered}** members of *${resolved.group.name}*.`
    );

    break;
}


      /* ---------- FORWARD ---------- */
case 'forward': {
    if (!isSelfChat) return;

    // Must reply to a message
    if (!message.hasQuotedMsg) {
        await safeSend(message.from, '❗ Reply to a message then send:\n!forward <groupIndex> <targets>');
        break;
    }

    // Group index
    const providedIdx = args[0] && !isNaN(args[0]) ? parseInt(args[0]) : null;
    const resolved = await resolveTargetGroupArg(providedIdx);

    if (!resolved.group) {
        await safeSend(message.from, '❌ No target group found. Run !list or set a default with !use');
        break;
    }

    // Raw target input
    const rawTargets = args.slice(providedIdx ? 1 : 0).join(' ');
    const quoted = await message.getQuotedMessage();

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

        if (Array.isArray(dbList) && dbList.length) {
            participants = dbList.map(j => ({ id: { _serialized: j } }));
        } else if (typeof chat.getParticipants === "function") {
            const fetched = await chat.getParticipants().catch(() => []);
            if (Array.isArray(fetched) && fetched.length) {
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

            if (jids.length) await setMembersForGroup(sessionId, resolved.group.groupId, jids);
        }
    } catch {
        participants = [];
    }

    if (!participants.length) {
        await safeSend(
            message.from,
            `⚠ Cannot determine members for *${resolved.group.name}*.\n` +
            `Group may be a Community subgroup.\n` +
            `Try running !syncmembers after making bot admin.`
        );
        break;
    }

    const participantJIDs = participants.map(p => p.id._serialized);

    // ------------------------------------------------------------
    // 🟢 TARGET PARSER (mentions, phone numbers, indexes)
    // ------------------------------------------------------------
    let targets = [];
    
    // A: Mentions like @234801234567
    const matchMentions = rawTargets.match(/@?(\d{6,20})/g);
    if (matchMentions) {
        targets = matchMentions.map(m => `${m.replace(/[^0-9]/g, '')}@c.us`);
    }

    // B: Numeric indexes like 1,3,7
    else if (/^[0-9,\s]+$/.test(rawTargets.trim())) {
        const idxs = rawTargets.split(',')
            .map(s => parseInt(s.trim()))
            .filter(n => !isNaN(n));

        targets = idxs
            .map(i => participantJIDs[i - 1])
            .filter(Boolean);
    }

    // C: Raw numbers like 081..., 090..., 234...
    else {
        const nums = rawTargets
            .split(',')
            .map(s => s.replace(/[^0-9]/g, ''))
            .filter(n => n.length >= 7);

        if (nums.length) {
            targets = nums.map(n =>
                (n.startsWith('234') ? n : '234' + n) + '@c.us'
            );
        }
    }

    // Remove duplicates & invalid JIDs
    targets = [...new Set(targets)].filter(Boolean);

    if (!targets.length) {
        await safeSend(message.from, '❗ Could not parse targets. Use mentions, numbers, or indexes.');
        break;
    }

    // ------------------------------------------------------------
    // 🟢 CONFIRMATION
    // ------------------------------------------------------------
    await safeSend(message.from, `🔁 Forwarding to ${targets.length} members...`);

    // ------------------------------------------------------------
    // 🟢 SEND (supports media or text)
    // ------------------------------------------------------------
    for (const jid of targets) {
        try {
            if (quoted.hasMedia) {
                const media = await quoted.downloadMedia();
                await client.sendMessage(jid, media, {
                    caption: quoted.body || ''
                });
            } else {
                await client.sendMessage(jid, quoted.body || '');
            }

            await new Promise(r => setTimeout(r, 300)); // Throttle
        } catch (e) {
            logger.error(`[${sessionName}] forward -> ${jid}`, e.message || e);
        }
    }

    // ------------------------------------------------------------
    // DONE
    // ------------------------------------------------------------
    await safeSend(message.from, '✅ Forwarding completed.');
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

// ---------------- Session creation / management API ----------------
function createClient(sessionId) {
  const opts = createClientOptions(sessionId);
  const client = new Client(opts);
  // ensure event handlers are unique per client
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
async function restoreAllSessions(io) {
    try {
        if (mongoose.connection.readyState !== 1) {
            logger.info("⛔ Mongoose not connected - skipping session restore");
            return;
        }

        logger.info("♻ Starting WhatsApp session restoration...");

        // const sessions = await Session.find({
        //     status: { $in: ["connected", "authenticated", "ready"] }
        // });

        // Find all active sessions (not disconnected, failed, or errored)
        const sessions = await Session.find({
            status: { $nin: ["disconnected", "failed", "auth_failed", "error"] }
        });
        
        logger.info(`🔍 Found ${sessions.length} sessions in database`);
        
        // Log session statuses for debugging
        if (sessions.length > 0) {
            const statusCounts = sessions.reduce((acc, s) => {
                acc[s.status] = (acc[s.status] || 0) + 1;
                return acc;
            }, {});
            logger.info(`📊 Session statuses: ${JSON.stringify(statusCounts)}`);
        }
        if (!sessions.length) {
            logger.info("📭 No sessions found to restore.");
            return;
        }

        logger.info(`🔁 Found ${sessions.length} sessions to restore.`);

        for (const s of sessions) {
            const sessionId = s.sessionId;
            const userId = s.userId;

            // 🔥 CHANGED: Check MongoDB instead of file system
            const authData = await SessionAuth.findOne({ sessionId });

            if (!authData) {
                logger.info(`⚠ No auth data in MongoDB for ${sessionId}. Skipping restore.`);
                
                // Mark session as disconnected
                await Session.findOneAndUpdate(
                    { sessionId },
                    { 
                        status: 'disconnected',
                        errorMessage: 'Session data lost. Please reconnect.',
                        disconnectedAt: new Date()
                    }
                );
                
                continue;
            }

            logger.info(`♻ Restoring WhatsApp session: ${sessionId} for user ${userId}`);

            try {
                await createBotSession(userId, sessionId, io);
                logger.info(`✅ Successfully restored session: ${sessionId}`);
            } catch (err) {
                logger.error(`❌ Failed to restore session ${sessionId}: ${err.message}`);
            }
        }

        logger.info("🎉 Session restoration completed!");

    } catch (err) {
        logger.error("❌ restoreAllSessions error:", err);
    }
}


// tiny start helper for local dev
function start(count = 1) {
  for (let i = 0; i < count; i++) {
    const sid = `session-${Date.now()}-${i}`;
    createSession(sid);
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

// exports
module.exports = {
  createBotSession,
  restoreAllSessions,
  start,
  clients
};

// if run directly, start one session (dev)
if (require.main === module) {
  start(1);
}
