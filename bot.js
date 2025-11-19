const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const mongoose = require('mongoose');
const Contact = require('./models/Contact');
const User = require('./models/User');
const PhoneRecord = require('./models/PhoneRecord');
const Session = require('./models/Session');
const TagUsage = require('./models/TagUsage');

// bot.js (multi-session, isolated per-client implementation)
// - Exports createBotSession, restoreAllSessions, start (dev helper) and clients map
// - Requires separate Mongoose models (listed after this file)
// - Uses LocalAuth with clientId=sessionId so sessions persist and DO NOT log out on server restart


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
  error: (m, e) => console.error(`[${new Date().toISOString()}] ERROR: ${m}`, e || '')
};

// ---------------- Helper: client options ----------------
function createClientOptions(sessionId) {
  return {
    authStrategy: new LocalAuth({ clientId: sessionId }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ],
      defaultViewport: null
    },
    takeoverOnConflict: true,
    restartOnAuthFail: true,
  };
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
function setupClientEvents(client, sessionId, io) {
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

  // QR
  client.on('qr', (qr) => {
    logger.info(`[${sessionName}] QR generated`);
    qrcode.generate(qr, { small: true });

    if (io) {
      // attempt to find userId portion from sessionId if following format session-<userId>-<ts>
      const userMatch = sessionId.match(/^session-([^-]+)-/);
      const userId = userMatch ? userMatch[1] : null;
      if (userId) {
        io.to(`user-${userId}`).emit('qrCode', { sessionId, qr });
      }
      // global broadcast
      io.emit('qrCode', { sessionId, qr });
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
      // wait until client.info available
      let attempts = 0;
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

      // wait until connected state
      attempts = 0;
      let state = null;
      while (attempts < 50) {
        try { state = await client.getState(); } catch {}
        if (state === 'CONNECTED' || state === 'OPEN') break;
        await new Promise(r => setTimeout(r, 100));
        attempts++;
      }
      logger.info(`[${sessionName}] final state=${state}`);

      // small wait to let chats sync begin
      await new Promise(r => setTimeout(r, 2500));

      // deliver welcome-to-self
      await safeSend(selfId, `🤖 *BOT CONNECTED*\nSession: ${sessionId}`);
      await new Promise(r => setTimeout(r, 400));
      await safeSend(selfId, `👋 Your bot is now active!\n\n*Commands:*\n${COMMAND_PREFIX}help`);

      // start keepalive and scheduler
      keepAliveInterval = setInterval(async () => {
        try { await client.getState(); logger.info(`[${sessionName}] keepalive OK`); } catch (e) { logger.error(`[${sessionName}] keepalive failed`, e.message || e); }
      }, 300000);

      // start scheduler runner for this session
      schedulerInterval = setInterval(() => runSchedulerForSession(sessionId, client), SCHEDULER_POLL_MS);
      // immediate run once
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
      const chatId = notification.id?._serialized || notification.chatId || notification.from;
      if (!chatId) return;
      // normalize action & participants
      const action = notification.action || notification.type || null; // depends on wwebjs version
      const participants = notification.participants || notification.who || notification.participantsChanged || [];

      // if participants is string array of jids, use as-is
      const added = participants; // elements might be jids or objects

      // send welcome when bot is added or when member added
      for (const p of added) {
        const pid = (typeof p === 'string') ? p : (p?._serialized || p.id?._serialized || p);
        if (!pid) continue;
        // if bot added
        if (pid === client.info?.wid?._serialized) {
          // one-time group welcome
          const meta = await WelcomeMeta.findOne({ sessionId, groupId: chatId }).lean().catch(()=>null);
          if (!meta || !meta.welcomeSent) {
            await safeSend(chatId, `Thank you for having me here. I introduce to you all TagThemAll Bot.\nClick here to learn more: https://example.com`);
            await WelcomeMeta.updateOne({ sessionId, groupId: chatId }, { $set: { welcomeSent: true } }, { upsert: true }).catch(()=>null);
          }
        } else {
          // for real new members: mention & welcome (one-time welcome per member not needed; group welcome is per-group)
          // but also enforce blocklist if bot is admin
          try {
            // fetch participants list to determine bot admin status
            const chat = await client.getChatById(chatId).catch(()=>null);
            if (!chat) continue;
            const participantsList = chat.participants?.length ? chat.participants : await chat.fetchParticipants();
            const botAdmin = participantsList.some(pobj => pobj.id._serialized === client.info?.wid?._serialized && (pobj.isAdmin || pobj.isSuperAdmin));
            // check group permission document
            const perm = await GroupPermission.findOne({ botUserId: sessionId, groupId: chatId }).lean().catch(()=>null);
            const whitelist = (perm && Array.isArray(perm.allowed)) ? perm.allowed : [];
            const blocklist = (perm && Array.isArray(perm.blocked)) ? perm.blocked : [];

            // if blocked and bot is admin, remove
            if (blocklist.includes(pid) && botAdmin) {
              // remove participant
              await safeSend(chatId, `⛔ ${pid} is on the blocklist and has been removed.`);
              try { await chat.removeParticipants([pid]); } catch (e) { logger.error(`[${sessionName}] failed to remove ${pid}`, e.message || e); }
            } else {
              // send a welcome mention to the added participant (best-effort)
              try {
                const num = pid.split('@')[0];
                const contact = await client.getContactById(pid).catch(()=>null);
                const mentionOpts = contact ? { mentions: [contact] } : {};
                const welcome = contact ? `Welcome @${num}! Thank you for having me here. I introduce to you all TagThemAll Bot.\nClick here to learn more: https://example.com` :
                  `Welcome! Thank you for having me here. I introduce to you all TagThemAll Bot.\nClick here to learn more: https://example.com`;
                await safeSend(chatId, welcome, mentionOpts);
              } catch (e) { /* ignore */ }
            }
          } catch (e) { /* ignore */ }
        }
      }
    } catch (e) { logger.error(`[${sessionName}] group_participants_changed error`, e); }
  });

  // generic message handler (per-client)
  client.on('message_create', async (message) => {
    try {
      // only process commands (ignore status & empty)
      if (!message.body || message.from === 'status@broadcast') return;

      // ensure selfId is set
      if (!client.info || !client.info.wid) {
        // fallback attempt
        if (message.fromMe) client.info = client.info || {}; client.info.wid = client.info.wid || { _serialized: message.from };
      }
      const mySelf = client.info?.wid?._serialized;

      // determine sender: message.fromMe -> bot itself
      const sender = message.fromMe ? mySelf : message.from;
      const isSelfChat = sender === mySelf;

      // react to group messages optionally (non-blocking)
      if (!message.fromMe) {
        try {
          const chat = await message.getChat();
          if (chat && chat.isGroup) {
            // only react if bot is participant
            if ((chat.participants || []).some(p => p.id._serialized === mySelf)) {
              try { await message.react('🚗'); } catch {}
            }
          }
        } catch {}
      }

      if (!message.body.startsWith(COMMAND_PREFIX)) return;

      // admin check (owner + optional secondary admins - you may implement per-session admin storage later)
      // For now, allow self-chat and owner running via owner number stored in an env or CONFIG if you have it.
      // We'll assume that the QR-scan user controls their own bot; commands from other numbers require them to be in a configured authorized list (not implemented global here).
      // Determine command
      const full = message.body.slice(COMMAND_PREFIX.length).trim();
      const [cmdRaw, ...args] = full.split(/\s+/);
      const cmd = (cmdRaw || '').toLowerCase();

      // important: call handlers with try/catch
      switch (cmd) {
        case 'help':
          await safeSend(message.from, `*Available Commands*\n!ping\n!help\n!list\n!listall\n!tag\n!tagexcept\n!members\n!admins\n!mygroups\n!forwardall (reply)\n!forward (reply + targets)\n!allow\n!deny\n!whitelist\n!blocklist\n!schedule\n!listschedules\n!cancelschedule`);
          break;

        case 'ping':
          await safeSend(message.from, '🏓 Pong!');
          break;

        /* ---------- GROUP / ADMIN UTILITIES ---------- */

        case 'listall': {
          // list all groups the account is in
          let chats = await client.getChats();
          if (chats.length < CHAT_SYNC_THRESHOLD) {
            // wait for chat sync
            for (let i=0;i<CHAT_SYNC_WAIT_ITER;i++){
              if (chats.length > CHAT_SYNC_THRESHOLD) break;
              await new Promise(r => setTimeout(r, 500));
              chats = await client.getChats();
            }
          }
          const groups = chats.filter(c => c.isGroup);
          if (groups.length === 0) { await safeSend(message.from, '❌ You are not in any group.'); break; }
          let out = '*📋 All Groups You Belong To:*\n\n';
          groups.forEach((g,i) => out += `${i+1}. *${g.name || 'Unnamed group'}*\n   ID: ${g.id?._serialized || g.id}\n\n`);
          await safeSend(message.from, out);
          break;
        }

        case 'list': {
          // groups where this account is admin/superadmin
          let chats = await client.getChats();
          if (chats.length < CHAT_SYNC_THRESHOLD) {
            for (let i=0;i<CHAT_SYNC_WAIT_ITER;i++){
              if (chats.length > CHAT_SYNC_THRESHOLD) break;
              await new Promise(r => setTimeout(r, 500));
              chats = await client.getChats();
            }
          }
          const adminGroups = [];
          for (const chat of chats) {
            if (!chat.isGroup) continue;
            // ensure participants loaded
            const participants = chat.participants?.length ? chat.participants : await chat.fetchParticipants().catch(()=>[]);
            const amIAdmin = participants.some(p => p.id._serialized === mySelf && (p.isAdmin || p.isSuperAdmin));
            if (amIAdmin) adminGroups.push({ name: chat.name, id: chat.id._serialized });
          }
          if (adminGroups.length === 0) {
            await safeSend(message.from, '❌ No admin groups detected yet. Try again after a few seconds.');
            break;
          }
          let out = '*📋 Groups Where You Are Admin:*\n\n';
          adminGroups.forEach((g,i)=> out += `${i+1}. *${g.name}*\n   ID: ${g.id}\n\n`);
          await safeSend(message.from, out);
          break;
        }

        case 'members': {
          const chat = await client.getChatById(message.from);
          if (!chat || !chat.isGroup) { await safeSend(message.from, '❌ This command only works in a group.'); break; }
          const parts = chat.participants?.length ? chat.participants : await chat.fetchParticipants().catch(()=>[]);
          let out = `*👥 Members of ${chat.name || 'Group'}:*\n\n`;
          let n = 1;
          for (const p of parts) {
            const jid = p.id._serialized;
            const contact = await client.getContactById(jid).catch(()=>null);
            const name = contact?.pushname || contact?.name || jid.split('@')[0];
            out += `${n}. *${name}*\n   ${jid}\n\n`;
            n++;
          }
          await safeSend(message.from, out);
          break;
        }

        case 'admins': {
          const chat = await client.getChatById(message.from);
          if (!chat || !chat.isGroup) { await safeSend(message.from, '❌ This command only works in a group.'); break; }
          const parts = chat.participants?.length ? chat.participants : await chat.fetchParticipants().catch(()=>[]);
          const admins = parts.filter(p => p.isAdmin || p.isSuperAdmin);
          if (admins.length === 0) { await safeSend(message.from, '❌ No admins detected.'); break; }
          let out = `*🛡 Admins of ${chat.name || 'Group'}:*\n\n`;
          let n = 1;
          for (const a of admins) {
            const jid = a.id._serialized;
            const contact = await client.getContactById(jid).catch(()=>null);
            const name = contact?.pushname || contact?.name || jid.split('@')[0];
            out += `${n}. *${name}*\n   ${jid}\n\n`;
            n++;
          }
          await safeSend(message.from, out);
          break;
        }

        case 'mygroups': {
          // groups where account is super admin (creator)
          let chats = await client.getChats();
          if (chats.length < CHAT_SYNC_THRESHOLD) {
            for (let i=0;i<CHAT_SYNC_WAIT_ITER;i++){
              if (chats.length > CHAT_SYNC_THRESHOLD) break;
              await new Promise(r => setTimeout(r, 500));
              chats = await client.getChats();
            }
          }
          const owned = [];
          for (const chat of chats) {
            if (!chat.isGroup) continue;
            const participants = chat.participants?.length ? chat.participants : await chat.fetchParticipants().catch(()=>[]);
            const isOwner = participants.some(p => p.id._serialized === mySelf && p.isSuperAdmin);
            if (isOwner) owned.push({ name: chat.name, id: chat.id._serialized });
          }
          if (owned.length === 0) { await safeSend(message.from, '❌ You did not create any groups.'); break; }
          let out = '*👑 Groups Created By You:*\n\n';
          owned.forEach((g,i)=> out += `${i+1}. *${g.name}*\n   ${g.id}\n\n`);
          await safeSend(message.from, out);
          break;
        }

        case 'tag': {
          // tag everyone in the current group (safe in self-chat or group)
          const chat = await client.getChatById(message.from);
          if (!chat || !chat.isGroup) { await safeSend(message.from, '❌ This command only works in a group.'); break; }
          const participants = chat.participants?.length ? chat.participants : await chat.fetchParticipants().catch(()=>[]);
          const mentions = [];
          let text = '*Group Mentions:*\n\n';
          for (const p of participants) {
            mentions.push(await client.getContactById(p.id._serialized).catch(()=>null));
            text += `mention (${p.id._serialized.split('@')[0]})\n`;
          }
          await chat.sendMessage(text, { mentions: mentions.filter(Boolean) });
          break;
        }

        case 'tagexcept': {
          const chat = await client.getChatById(message.from);
          if (!chat || !chat.isGroup) { await safeSend(message.from, '❌ This command only works in a group.'); break; }
          if (args.length < 1) { await safeSend(message.from, 'Usage: !tagexcept 1,2,3 @234...'); break; }
          const idxList = args[0].split(',').map(x => parseInt(x.trim())).filter(n => !isNaN(n));
          const excludedRaw = args.slice(1).join(' ');
          const excluded = excludedRaw.split('@').filter(x=>x.trim()).map(x => (x.replace(/[^0-9]/g,'')+'@c.us'));
          const participants = chat.participants?.length ? chat.participants : await chat.fetchParticipants().catch(()=>[]);
          const allMembers = participants.map(p=>p.id._serialized);
          const mentions = [];
          let text = '*Filtered Mentions:*\n\n';
          for (const idx of idxList) {
            const memberJid = allMembers[idx-1];
            if (!memberJid) continue;
            if (excluded.includes(memberJid)) continue;
            mentions.push(await client.getContactById(memberJid).catch(()=>null));
            text += `mention (${memberJid.split('@')[0]})\n`;
          }
          await chat.sendMessage(text, { mentions: mentions.filter(Boolean) });
          break;
        }

        /* ---------- PER-GROUP ALLOW / BLOCK (Option A) ---------- */
        case 'allow':
        case 'whitelistadd': {
          // args[0] is number
          if (!args[0]) { await safeSend(message.from, 'Usage: !allow 234801234567'); break; }
          const jid = formatJid(args[0]);
          if (!jid) { await safeSend(message.from, 'Invalid number'); break; }
          // upsert permission doc for this group
          const chatId = message.from;
          await GroupPermission.updateOne(
            { botUserId: sessionId, groupId: chatId },
            { $addToSet: { allowed: jid }, $pull: { blocked: jid } },
            { upsert: true }
          );
          await safeSend(message.from, `✅ ${jid} added to whitelist for this group.`);
          break;
        }

        case 'unallow': {
          if (!args[0]) { await safeSend(message.from, 'Usage: !unallow 234801234567'); break; }
          const jid = formatJid(args[0]);
          if (!jid) { await safeSend(message.from, 'Invalid number'); break; }
          const chatId = message.from;
          await GroupPermission.updateOne(
            { botUserId: sessionId, groupId: chatId },
            { $pull: { allowed: jid } },
            { upsert: true }
          );
          await safeSend(message.from, `✅ ${jid} removed from whitelist.`);
          break;
        }

        case 'deny':
        case 'block': {
          if (!args[0]) { await safeSend(message.from, 'Usage: !deny 234801234567'); break; }
          const jid = formatJid(args[0]);
          if (!jid) { await safeSend(message.from, 'Invalid number'); break; }
          const chatId = message.from;
          await GroupPermission.updateOne(
            { botUserId: sessionId, groupId: chatId },
            { $addToSet: { blocked: jid }, $pull: { allowed: jid } },
            { upsert: true }
          );
          await safeSend(message.from, `⛔ ${jid} added to blocklist for this group.`);
          break;
        }

        case 'unblock': {
          if (!args[0]) { await safeSend(message.from, 'Usage: !unblock 234801234567'); break; }
          const jid = formatJid(args[0]);
          if (!jid) { await safeSend(message.from, 'Invalid number'); break; }
          const chatId = message.from;
          await GroupPermission.updateOne(
            { botUserId: sessionId, groupId: chatId },
            { $pull: { blocked: jid } },
            { upsert: true }
          );
          await safeSend(message.from, `✅ ${jid} removed from blocklist.`);
          break;
        }

        case 'whitelist': {
          const chatId = message.from;
          const doc = await GroupPermission.findOne({ botUserId: sessionId, groupId: chatId }).lean().catch(()=>null);
          const list = (doc && Array.isArray(doc.allowed)) ? doc.allowed : [];
          await safeSend(message.from, `📜 Whitelist:\n\n${list.join('\n') || 'No entries'}`);
          break;
        }

        case 'blocklist': {
          const chatId = message.from;
          const doc = await GroupPermission.findOne({ botUserId: sessionId, groupId: chatId }).lean().catch(()=>null);
          const list = (doc && Array.isArray(doc.blocked)) ? doc.blocked : [];
          await safeSend(message.from, `📵 Blocklist:\n\n${list.join('\n') || 'No entries'}`);
          break;
        }

        /* ---------- FORWARDING ---------- */

        case 'forwardall': {
          // must be reply to a message
          if (!message.hasQuotedMsg) { await safeSend(message.from, '❗ Reply to the message you want to forward and run `!forwardall`.'); break; }
          const quoted = await message.getQuotedMessage();
          const chat = await client.getChatById(message.from);
          if (!chat || !chat.isGroup) { await safeSend(message.from, '❌ This command must be run inside a group.'); break; }
          const participants = chat.participants?.length ? chat.participants : await chat.fetchParticipants().catch(()=>[]);
          const targets = participants.map(p => p.id._serialized).filter(j => j !== mySelf);
          await safeSend(message.from, `🔁 Forwarding to ${targets.length} members. This may take some time.`);
          for (const t of targets) {
            try {
              if (quoted.hasMedia) {
                const media = await quoted.downloadMedia();
                await client.sendMessage(t, media, { caption: quoted.body || '' });
              } else {
                await client.sendMessage(t, quoted.body || '');
              }
              // small throttle
              await new Promise(r => setTimeout(r, 200));
            } catch (e) {
              logger.error(`[${sessionName}] forwardall -> ${t}`, e.message || e);
            }
          }
          await safeSend(message.from, '✅ Forwarding complete.');
          break;
        }

        case 'forward': {
          if (!message.hasQuotedMsg) { await safeSend(message.from, '❗ Reply to the message to forward and provide targets.'); break; }
          const quoted = await message.getQuotedMessage();
          const chat = await client.getChatById(message.from);
          if (!chat || !chat.isGroup) { await safeSend(message.from, '❌ This command must be run inside a group.'); break; }

          // parse args as targets: @numbers, indexes 1,3,5 or raw numbers
          const raw = args.join(' ');
          let targets = [];
          const atMatches = raw.match(/@?(\d{6,20})/g);
          if (atMatches && atMatches.length) {
            targets = atMatches.map(m => `${m.replace(/[^0-9]/g,'')}@c.us`);
          } else if (/^[0-9,\s]+$/.test(raw) && raw.trim().length) {
            const idxs = raw.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
            const parts = chat.participants?.length ? chat.participants : await chat.fetchParticipants().catch(()=>[]);
            targets = idxs.map(i => parts[i-1] && parts[i-1].id._serialized).filter(Boolean);
          } else {
            const nums = raw.split(',').map(s => s.replace(/[^0-9]/g,'')).filter(s => s.length>5);
            if (nums.length) targets = nums.map(n => `${n}@c.us`);
          }

          if (!targets.length) { await safeSend(message.from, '❗ Could not parse targets.'); break; }
          await safeSend(message.from, `🔁 Forwarding to ${targets.length} recipients...`);
          for (const t of targets) {
            try {
              if (quoted.hasMedia) {
                const media = await quoted.downloadMedia();
                await client.sendMessage(t, media, { caption: quoted.body || '' });
              } else {
                await client.sendMessage(t, quoted.body || '');
              }
              await new Promise(r => setTimeout(r, 200));
            } catch (e) {
              logger.error(`[${sessionName}] forward -> ${t}`, e.message || e);
            }
          }
          await safeSend(message.from, '✅ Forwarding complete.');
          break;
        }

        /* ---------- SCHEDULER (MongoDB-based) ---------- */

        case 'schedule': {
          // syntax: !schedule HH:MM <group|dm> <once|daily|weekly> | <message>
          // example: !schedule 10:00 group daily | Good morning!
          const rest = full.slice(cmd.length).trim();
          const pipeIndex = rest.indexOf('|');
          if (pipeIndex === -1) {
            await safeSend(message.from, 'Usage: !schedule HH:MM <group|dm> <once|daily|weekly> | <message>');
            break;
          }
          const left = rest.slice(0, pipeIndex).trim();
          const msgText = rest.slice(pipeIndex+1).trim();
          const leftParts = left.split(/\s+/);
          const time = leftParts[0];
          const mode = leftParts[1] || 'group';
          const repeat = leftParts[2] || 'once';
          if (!/^\d{1,2}:\d{2}$/.test(time)) { await safeSend(message.from, 'Invalid time. Use HH:MM'); break; }
          const nextRun = hhmmToNextDate(time);
          const doc = new Schedule({
            userId: sessionId,
            chatId: message.from,
            creator: message.author || message.from, // may be different shapes
            mode,
            targets: [],
            message: msgText,
            timeHHMM: time,
            nextRun,
            repeat,
            active: true
          });
          await doc.save();
          await safeSend(message.from, `✅ Schedule created. Next run: ${doc.nextRun.toLocaleString()}. ID: ${doc._id}`);
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
              const parts = chat.participants?.length ? chat.participants : await chat.fetchParticipants().catch(()=>[]);
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
async function createBotSession(userId, sessionId, io) {
  try {
    // allow passing io (socket server) so we can emit QR updates to dashboard
    if (io && !global.io) global.io = io;

    // ensure sessionId unique
    const created = createSession(sessionId);
    logger.info(`createBotSession: created session ${sessionId} for user ${userId}`);
    return created;
  } catch (e) {
    logger.error('createBotSession error', e);
    throw e;
  }
}

// // restore sessions from DB - if you store them in Session collection
// async function restoreAllSessions(io) {
//   // expects you to have a Session model saved elsewhere (not included here)
//   // We'll attempt to read sessions from a Sessions collection if present
//   try {
//     if (!mongoose.connection.readyState) logger.info('Mongoose not connected - restoreAllSessions skipped');
//     // If you maintain a Session model, load and call createBotSession for each connected session
//     // Example: const sessions = await Session.find({ status: 'connected' });
//     logger.info('restoreAllSessions: implement caller to pass sessions or call createBotSession manually');
//   } catch (e) {
//     logger.error('restoreAllSessions error', e);
//   }
// }

// =========================================
// RESTORE ALL SESSIONS ON SERVER STARTUP
// =========================================
// async function restoreAllSessions(io) {
//     try {
//         if (mongoose.connection.readyState !== 1) {
//             logger.warn("⛔ Mongoose not connected - skipping session restore");
//             return;
//         }

//         logger.info("♻ Starting WhatsApp session restoration...");

//         // Get all saved sessions that SHOULD reconnect
//         const sessions = await Session.find({
//             status: { $in: ["connected", "authenticated", "ready"] }
//         });

//         if (!sessions.length) {
//             logger.info("📭 No sessions found to restore.");
//             return;
//         }

//         logger.info(`🔁 Found ${sessions.length} sessions to restore.`);

//         for (const s of sessions) {
//             const sessionId = s.sessionId;
//             const userId = s.userId;

//             // Verify LocalAuth folder exists
//             const fs = require("fs");
//             const authFolderPath = `./sessions/${sessionId}`;

//             if (!fs.existsSync(authFolderPath)) {
//                 logger.warn(`⚠ LocalAuth missing for ${sessionId}. Cannot restore this session.`);
//                 continue;
//             }

//             logger.info(`♻ Restoring WhatsApp session: ${sessionId} for user ${userId}`);

//             try {
//                 await createBotSession(userId, sessionId, io);
//                 logger.info(`✅ Successfully restored session: ${sessionId}`);
//             } catch (err) {
//                 logger.error(`❌ Failed to restore session ${sessionId}: ${err.message}`);
//             }
//         }

//         logger.info("🎉 Session restoration completed!");
//     } catch (err) {
//         logger.error("❌ restoreAllSessions error:", err);
//     }
// }

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

        const sessions = await Session.find({
            status: { $in: ["connected", "authenticated", "ready"] }
        });

        if (!sessions.length) {
            logger.info("📭 No sessions found to restore.");
            return;
        }

        logger.info(`🔁 Found ${sessions.length} sessions to restore.`);

        const fs = require("fs");

        for (const s of sessions) {
            const sessionId = s.sessionId;
            const userId = s.userId;

            const authFolderPath = `./sessions/${sessionId}`;

            // Check if LocalAuth folder exists
            if (!fs.existsSync(authFolderPath)) {
                logger.info(`⚠ LocalAuth missing for ${sessionId}. Skipping restore.`);
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
