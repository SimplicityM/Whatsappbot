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
const SavedGroupList = require('./models/SavedGroupList');
const ActiveGroup = require('./models/ActiveGroup');
const GroupMembers = require('./models/GroupMembers');

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

  // Normalize jid helper (re-usable)
function normalizeJid(jid) {
  if (!jid) return null;
  if (jid.includes('@')) return jid;
  return jid.replace(/[^0-9]/g, '') + '@c.us';
}

// retrieve members list from DB
async function getMembersFromDB(sessionId, groupId) {
  try {
    const doc = await GroupMembers.findOne({ sessionId, groupId }).lean();
    return (doc && Array.isArray(doc.members)) ? doc.members : [];
  } catch (e) {
    return [];
  }
}

// upsert full list into DB (replace)
async function setMembersForGroup(sessionId, groupId, membersArray) {
  try {
    const m = membersArray.map(m => (typeof m === 'string' ? m : m.id?._serialized || m.id)).filter(Boolean);
    await GroupMembers.findOneAndUpdate(
      { sessionId, groupId },
      { sessionId, groupId, members: [...new Set(m)], updatedAt: new Date() },
      { upsert: true }
    );
  } catch (e) {
    logger.error(`[${sessionId}] setMembersForGroup error`, e);
  }
}

// add a single member to DB list
async function addMemberToGroup(sessionId, groupId, memberJid) {
  try {
    const jid = normalizeJid(memberJid);
    if (!jid) return;
    await GroupMembers.updateOne(
      { sessionId, groupId },
      { $addToSet: { members: jid }, $set: { updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (e) {
    logger.error(`[${sessionId}] addMemberToGroup error`, e);
  }
}

// remove a single member
async function removeMemberFromGroup(sessionId, groupId, memberJid) {
  try {
    const jid = normalizeJid(memberJid);
    if (!jid) return;
    await GroupMembers.updateOne(
      { sessionId, groupId },
      { $pull: { members: jid }, $set: { updatedAt: new Date() } }
    );
  } catch (e) {
    logger.error(`[${sessionId}] removeMemberFromGroup error`, e);
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
//   client.on('group_participants_changed', async (notification) => {
//     try {
//       const chatId = notification.id?._serialized || notification.chatId || notification.from;
//       if (!chatId) return;
//       // normalize action & participants
//       const action = notification.action || notification.type || null; // depends on wwebjs version
//       const participants = notification.participants || notification.who || notification.participantsChanged || [];

//       // if participants is string array of jids, use as-is
//       const added = participants; // elements might be jids or objects

//       // send welcome when bot is added or when member added
//       for (const p of added) {
//         const pid = (typeof p === 'string') ? p : (p?._serialized || p.id?._serialized || p);
//         if (!pid) continue;
//         // if bot added
//         if (pid === client.info?.wid?._serialized) {
//           // one-time group welcome
//           const meta = await WelcomeMeta.findOne({ sessionId, groupId: chatId }).lean().catch(()=>null);
//           if (!meta || !meta.welcomeSent) {
//             await safeSend(chatId, `Thank you for having me here. I introduce to you all TagThemAll Bot.\nClick here to learn more: https://example.com`);
//             await WelcomeMeta.updateOne({ sessionId, groupId: chatId }, { $set: { welcomeSent: true } }, { upsert: true }).catch(()=>null);
//           }
//         } else {
//           // for real new members: mention & welcome (one-time welcome per member not needed; group welcome is per-group)
//           // but also enforce blocklist if bot is admin
//           try {
//             // fetch participants list to determine bot admin status
//             const chat = await client.getChatById(chatId).catch(()=>null);
//             if (!chat) continue;
//             // const participantsList = chat.participants?.length ? chat.participants : await chat.fetchParticipants();
//             let participantsList = [];
// try {
//     if (Array.isArray(chat.participants) && chat.participants.length) {
//         participantsList = chat.participants;
//     } else if (typeof chat.getParticipants === "function") {
//         participantsList = await chat.getParticipants();
//     } else {
//         participantsList = [];
//     }
// } catch {
//     participantsList = [];
// }

//             const botAdmin = participantsList.some(pobj => pobj.id._serialized === client.info?.wid?._serialized && (pobj.isAdmin || pobj.isSuperAdmin));
//             // check group permission document
//             const perm = await GroupPermission.findOne({ botUserId: sessionId, groupId: chatId }).lean().catch(()=>null);
//             const whitelist = (perm && Array.isArray(perm.allowed)) ? perm.allowed : [];
//             const blocklist = (perm && Array.isArray(perm.blocked)) ? perm.blocked : [];

//             // if blocked and bot is admin, remove
//             if (blocklist.includes(pid) && botAdmin) {
//               // remove participant
//               await safeSend(chatId, `⛔ ${pid} is on the blocklist and has been removed.`);
//               try { await chat.removeParticipants([pid]); } catch (e) { logger.error(`[${sessionName}] failed to remove ${pid}`, e.message || e); }
//             } else {
//               // send a welcome mention to the added participant (best-effort)
//               try {
//                 const num = pid.split('@')[0];
//                 const contact = await client.getContactById(pid).catch(()=>null);
//                 const mentionOpts = contact ? { mentions: [contact] } : {};
//                 const welcome = contact ? `Welcome @${num}! Thank you for having me here. I introduce to you all TagThemAll Bot.\nClick here to learn more: https://example.com` :
//                   `Welcome! Thank you for having me here. I introduce to you all TagThemAll Bot.\nClick here to learn more: https://example.com`;
//                 await safeSend(chatId, welcome, mentionOpts);
//               } catch (e) { /* ignore */ }
//             }
//           } catch (e) { /* ignore */ }
//         }
//       }
//     } catch (e) { logger.error(`[${sessionName}] group_participants_changed error`, e); }
//   });

client.on('group_participants_changed', async (notification) => {
    try {
        const chatId = notification.id?._serialized || notification.chatId || notification.from;
        if (!chatId) return;

        // normalize action & participants list
        const action = (notification.action || notification.type || '').toLowerCase();
        const participants = notification.participants || notification.who || notification.participantsChanged || [];
        const added = Array.isArray(participants) ? participants : [participants];

        for (const p of added) {
            const pid = (typeof p === 'string')
                ? p
                : (p?._serialized || p.id?._serialized || p);

            if (!pid) continue;

            // 1) BOT ITSELF ADDED
            if (pid === client.info?.wid?._serialized) {
                const meta = await WelcomeMeta.findOne({ sessionId, groupId: chatId })
                    .lean()
                    .catch(() => null);

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

                // Ensure DB has this group with bot stored as known member
                await addMemberToGroup(sessionId, chatId, pid);
                continue;
            }

            // 2) NORMAL USER JOIN / LEAVE UPDATE DB
            try {
                if (action.includes('add') || action.includes('invite') || action.includes('promote')) {
                    await addMemberToGroup(sessionId, chatId, pid);
                } else if (action.includes('remove') || action.includes('leave')) {
                    await removeMemberFromGroup(sessionId, chatId, pid);
                } else {
                    // unknown action? still attempt to add
                    await addMemberToGroup(sessionId, chatId, pid);
                }
            } catch (e) {
                logger.error('DB update error (join/leave):', e);
            }

            // 3) WELCOME + BLOCKLIST HANDLING
            try {
                const chat = await client.getChatById(chatId).catch(() => null);
                if (!chat) continue;

                // ---- SAFE PARTICIPANT FETCH (NO fetchParticipants) ----
                let participantsList = [];
                try {
                    if (Array.isArray(chat.participants) && chat.participants.length) {
                        participantsList = chat.participants;
                    } else if (typeof chat.getParticipants === 'function') {
                        participantsList = await chat.getParticipants();
                    } else {
                        participantsList = [];
                    }
                } catch {
                    participantsList = [];
                }

                const botAdmin = participantsList.some(obj =>
                    obj.id._serialized === client.info?.wid?._serialized &&
                    (obj.isAdmin || obj.isSuperAdmin)
                );

                const perm = await GroupPermission.findOne({
                    botUserId: sessionId,
                    groupId: chatId
                })
                    .lean()
                    .catch(() => null);

                const whitelist = (perm && Array.isArray(perm.allowed)) ? perm.allowed : [];
                const blocklist = (perm && Array.isArray(perm.blocked)) ? perm.blocked : [];

                // ---- BLOCKLIST ENFORCEMENT ----
                if (blocklist.includes(pid) && botAdmin) {
                    await safeSend(chatId, `⛔ ${pid} is on the blocklist and has been removed.`);
                    try {
                        await chat.removeParticipants([pid]);
                    } catch (e) {
                        logger.error(`[${sessionName}] failed to remove ${pid}`, e.message || e);
                    }
                    continue;
                }

                // ---- SEND WELCOME MESSAGE ----
                try {
                    const num = pid.split('@')[0];
                    const contact = await client.getContactById(pid).catch(() => null);

                    const mentionOpts = contact ? { mentions: [contact] } : {};
                    const welcome = contact
                        ? `Welcome @${num}! Thank you for having me here. I introduce to you all TagThemAll Bot.\nClick here to learn more: https://example.com`
                        : `Welcome! Thank you for having me here. I introduce to you all TagThemAll Bot.\nClick here to learn more: https://example.com`;

                    await safeSend(chatId, welcome, mentionOpts);
                } catch (e) {
                    /* ignore welcome error */
                }
            } catch (e) {
                /* ignore failures in welcome & blocklist logic */
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



// Normalize jid helper (re-usable)
function normalizeJid(jid) {
  if (!jid) return null;
  if (jid.includes('@')) return jid;
  return jid.replace(/[^0-9]/g, '') + '@c.us';
}

// retrieve members list from DB
async function getMembersFromDB(sessionId, groupId) {
  try {
    const doc = await GroupMembers.findOne({ sessionId, groupId }).lean();
    return (doc && Array.isArray(doc.members)) ? doc.members : [];
  } catch (e) {
    return [];
  }
}

// upsert full list into DB (replace)
async function setMembersForGroup(sessionId, groupId, membersArray) {
  try {
    const m = membersArray.map(m => (typeof m === 'string' ? m : m.id?._serialized || m.id)).filter(Boolean);
    await GroupMembers.findOneAndUpdate(
      { sessionId, groupId },
      { sessionId, groupId, members: [...new Set(m)], updatedAt: new Date() },
      { upsert: true }
    );
  } catch (e) {
    logger.error(`[${sessionId}] setMembersForGroup error`, e);
  }
}

// add a single member to DB list
async function addMemberToGroup(sessionId, groupId, memberJid) {
  try {
    const jid = normalizeJid(memberJid);
    if (!jid) return;
    await GroupMembers.updateOne(
      { sessionId, groupId },
      { $addToSet: { members: jid }, $set: { updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (e) {
    logger.error(`[${sessionId}] addMemberToGroup error`, e);
  }
}

// remove a single member
async function removeMemberFromGroup(sessionId, groupId, memberJid) {
  try {
    const jid = normalizeJid(memberJid);
    if (!jid) return;
    await GroupMembers.updateOne(
      { sessionId, groupId },
      { $pull: { members: jid }, $set: { updatedAt: new Date() } }
    );
  } catch (e) {
    logger.error(`[${sessionId}] removeMemberFromGroup error`, e);
  }
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
//  client.on('message_create', async (message) => {
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

//     // determine sender: message.fromMe -> bot itself
//     const sender = message.fromMe ? mySelf : message.from;
//     const isSelfChat = sender === mySelf;

//     // react to group messages optionally (non-blocking)
//     // if (!message.fromMe) {
//     //   try {
//     //     const chatCheck = await message.getChat().catch(()=>null);
//     //     if (chatCheck && chatCheck.isGroup) {
//     //       if ((chatCheck.participants || []).some(p => p.id._serialized === mySelf)) {
//     //         try { await message.react('🚗'); } catch {}
//     //       }
//     //     }
//     //   } catch {}
//     // }

//     // Only handle commands sent in self-chat (DM to the bot)
//     // If someone types commands in group, ignore them.

//     // if (!isSelfChat) {
//     //   // allow owners (if message.fromMe) or you can check allowed users here
//     //   // For now only allow self-chat commands, reply if someone tries in group:
//     //   // (If you want to allow owners to run commands from other numbers, modify this logic)
//     //   await safeSend(message.from, '❗ Please send commands to this bot in a private chat (your own chat with the bot).');
//     //   return;
//     // }

// // Only process commands inside self-chat.
// // Ignore ALL commands coming from groups or other users.
// // if (message.body.startsWith(COMMAND_PREFIX)) {

// //     // BONUS: Ensure ONLY the owner of this bot session can run commands
// //     // (sender must match mySelf)
// //     if (sender !== mySelf) {
// //         return; // silently ignore others
// //     }

// //     // If message is not from self-chat, silently ignore
// //     if (!isSelfChat) {
// //         return; // do NOT reply anything in groups
// //     }
// // }

// if (message.body.startsWith(COMMAND_PREFIX)) {

//     // Only the bot owner can run commands
//     if (sender !== mySelf) {
//         return; // ignore other users silently
//     }

//     // Only allow commands in self-chat (your DM with the bot)
//     if (!isSelfChat) {
//         return; // ignore in groups silently
//     }

//     // React with a ✔️ to acknowledge the command
//     try {
//         await message.react('✔️');
//     } catch (e) { /* ignore reaction errors */ }
// }



//     if (!message.body.startsWith(COMMAND_PREFIX)) return;

//     // Parse command
//     const full = message.body.slice(COMMAND_PREFIX.length).trim();
//     const [cmdRaw, ...args] = full.split(/\s+/);
//     const cmd = (cmdRaw || '').toLowerCase();

//     // helper: fetch admin groups and save to DB
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
//         // const participants = c.participants?.length ? c.participants : await c.fetchParticipants().catch(()=>[]);
//         let participants = [];

// try {
//     if (Array.isArray(c.participants) && c.participants.length) {
//         participants = c.participants;
//     } else if (typeof c.getParticipants === 'function') {
//         participants = await c.getParticipants();
//     } else {
//         // fallback (older wwebjs)
//         participants = [];
//     }
// } catch {
//     participants = [];
// }

//         const amIAdmin = participants.some(p => p.id._serialized === mySelf && (p.isAdmin || p.isSuperAdmin));
//         if (amIAdmin) adminGroups.push({ name: c.name || 'Unnamed group', groupId: c.id._serialized });
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

//     // helper: resolve target group (index or default)
//     async function resolveTargetGroupArg(argIndex) {
//       // if caller provided an index (argIndex), use it
//       if (argIndex && !isNaN(argIndex)) {
//         const idx = parseInt(argIndex);
//         const group = await getGroupFromIndex(sessionId, idx);
//         return { index: idx, group };
//       }
//       // else use active default
//       const active = await getActiveGroup(sessionId);
//       if (active) {
//         return { index: active.index, group: { name: active.name, groupId: active.groupId } };
//       }
//       return { index: null, group: null };
//     }

client.on('message_create', async (message) => {
  try {
    // only process commands (ignore status & empty)
    if (!message.body || message.from === 'status@broadcast') return;

    // ensure selfId is set
    if (!client.info || !client.info.wid) {
      if (message.fromMe) {
        client.info = client.info || {};
        client.info.wid = client.info.wid || { _serialized: message.from };
      }
    }

    const mySelf = client.info?.wid?._serialized;

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

    // If no command prefix, stop here
    if (!message.body.startsWith(COMMAND_PREFIX)) return;

    // --------------------------------------------------
    // 🟢 COMMAND PARSER
    // --------------------------------------------------
    const full = message.body.slice(COMMAND_PREFIX.length).trim();
    const [cmdRaw, ...args] = full.split(/\s+/);
    const cmd = (cmdRaw || '').toLowerCase();

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
      if (argIndex && !isNaN(argIndex)) {
        const idx = parseInt(argIndex);
        const group = await getGroupFromIndex(sessionId, idx);
        return { index: idx, group };
      }

      const active = await getActiveGroup(sessionId);
      if (active) {
        return {
          index: active.index,
          group: {
            name: active.name,
            groupId: active.groupId
          }
        };
      }

      return { index: null, group: null };
    }

    // ------------ COMMANDS ------------
    switch (cmd) {
case 'help': {
    if (!isSelfChat) return;

    const text = `
🌟 *WHATSAPP BOT COMMANDS* 🌟

📋 *Group Management*
• !list — groups where you’re admin
• !listall — all groups you belong to
• !members <groupIndex>
• !admins <groupIndex>
• !mygroups — groups you created

👥 *Tagging*
• !tag <groupIndex>
• !tagexcept <groupIndex> <excluded>
   Examples:
   - !tagexcept 2 @mary @john Meeting starts soon
   - !tagexcept 3 08123456789
   - !tagexcept 1 1,3,5

🔁 *Forwarding*
• !forwardall (reply)
• !forward <targets>

🔐 *Permissions*
• !allow <number>
• !deny <number>
• !whitelist
• !blocklist
• !unallow <number>
• !unblock <number>

⏰ *Scheduler*
• !schedule HH:MM mode repeat | message
• !listschedules
• !cancelschedule <id>

⚙ *System*
• !ping
• !help
`;

    await safeSend(message.from, text);
    break;
}

      case 'ping':
        await safeSend(message.from, '🏓 Pong!');
        break;

      /* ---------- SAVE ADMIN GROUPS: !list ---------- */
      case 'list': {
        const adminGroups = await fetchAndSaveAdminGroups();
        if (!adminGroups.length) {
          await safeSend(message.from, '❌ You are not an admin in any group.');
          break;
        }
        let out = '*📋 Groups Where You Are Admin:*\n\n';
        adminGroups.forEach((g,i)=> out += `${i+1}. *${g.name}*\n   ID: ${g.groupId}\n\n`);
        out += '\nSet a default active group: `!use <index>`';
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
// case 'dmall': {
//     if (!isSelfChat) return;

//     // usage: !dmall <groupIndex> | <message>
//     const full = args.join(' ');
//     const pipeIndex = full.indexOf('|');
//     if (pipeIndex === -1) {
//         await safeSend(message.from,
//             'Usage:\n!dmall <groupIndex> | <message>\nExample:\n!dmall 2 | Hello everyone'
//         );
//         break;
//     }

//     const groupIndex = parseInt(full.slice(0, pipeIndex).trim());
//     const msgText = full.slice(pipeIndex + 1).trim();

//     if (!groupIndex || !msgText) {
//         await safeSend(message.from, '❗ Missing group index or message.');
//         break;
//     }

//     const resolved = await resolveTargetGroupArg(groupIndex);
//     if (!resolved.group) {
//         await safeSend(message.from, '❌ Invalid group.');
//         break;
//     }

//     // Fetch group members
//     const chat = await client.getChatById(resolved.group.groupId).catch(() => null);
//     // const parts = chat.participants?.length ? chat.participants : await chat.fetchParticipants();
//     let parts = [];
// try {
//     if (Array.isArray(chat.participants) && chat.participants.length) {
//         parts = chat.participants;
//     } else if (typeof chat.getParticipants === "function") {
//         parts = await chat.getParticipants();
//     } else {
//         parts = [];
//     }
// } catch {
//     parts = [];
// }

//     const allJids = parts.map(p => p.id._serialized);

//     let delivered = 0;

//     for (const jid of allJids) {
//         if (jid === mySelf) continue;
//         try {
//             await client.sendMessage(jid, msgText);
//             delivered++;
//         } catch {}
//         await new Promise(r => setTimeout(r, 300)); // throttle
//     }

//     await safeSend(
//         message.from,
//         `📩 *DM-all complete!*  
// Message delivered individually to **${delivered}** members of *${resolved.group.name}*.`
//     );

//     break;
// }

case 'dmall': {
    if (!isSelfChat) return;

    // Usage: !dmall <groupIndex> | <message>
    const full = args.join(' ');
    const pipeIndex = full.indexOf('|');

    if (pipeIndex === -1) {
        await safeSend(message.from,
            'Usage:\n!dmall <groupIndex> | <message>\nExample:\n!dmall 2 | Hello everyone');
        break;
    }

    const groupIndex = parseInt(full.slice(0, pipeIndex).trim());
    const msgText = full.slice(pipeIndex + 1).trim();

    if (!groupIndex || !msgText) {
        await safeSend(message.from, '❗ Missing group index or message.');
        break;
    }

    const resolved = await resolveTargetGroupArg(groupIndex);
    if (!resolved.group) {
        await safeSend(message.from, '❌ Invalid group.');
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
            `Group may be a Community subgroup.\n` +
            `Promote bot to admin and run !syncmembers.`
        );
        break;
    }

    const allJids = participants
        .map(p => p.id._serialized)
        .filter(j => j !== mySelf);

    if (!allJids.length) {
        await safeSend(message.from, '❗ No valid members found.');
        break;
    }

    // ------------------------------------------------------------
    // 🟢 CONFIRMATION
    // ------------------------------------------------------------
    await safeSend(
        message.from,
        `📨 Sending DM to **${allJids.length}** members of *${resolved.group.name}*...`
    );

    // ------------------------------------------------------------
    // 🟢 SEND DM TO EACH MEMBER (Throttled)
    // ------------------------------------------------------------
    let delivered = 0;

    for (const jid of allJids) {
        try {
            await client.sendMessage(jid, msgText);
            delivered++;
        } catch (e) {
            logger.error(`[${sessionName}] dmall -> ${jid}`, e.message || e);
        }

        await new Promise(r => setTimeout(r, 300)); // throttle to avoid ban
    }

    // ------------------------------------------------------------
    // 🟢 DONE
    // ------------------------------------------------------------
    await safeSend(
        message.from,
        `📩 *DM-all complete!*  
Message delivered to **${delivered}** members of *${resolved.group.name}*.`
    );

    break;
}


/* ---------- DMSELECTED ---------- */
// case 'dmselected': {
//     if (!isSelfChat) return;

//     // Usage:
//     // !dmselected <groupIndex> <targets> | <message>
//     // Examples:
//     // !dmselected 2 @john @mary | Private notice
//     // !dmselected 1 08123456789 3 | Meeting now
//     // !dmselected 3 1,3,5 2348011223344 | Confidential

//     if (!args.length) {
//         await safeSend(message.from,
// `Usage:
// !dmselected <groupIndex> <targets> | <message>

// Examples:
// !dmselected 2 @john @mary | Private meeting
// !dmselected 1 08123456789 3 | Hello
// !dmselected 3 1,3,5 | Important update`);
//         break;
//     }

//     // 1️⃣ Group index
//     const groupIndex = parseInt(args[0]);
//     if (isNaN(groupIndex)) {
//         await safeSend(message.from, '❗ First argument must be group index.\nExample: !dmselected 2 @john | hello');
//         break;
//     }

//     // 2️⃣ Resolve group
//     const resolved = await resolveTargetGroupArg(groupIndex);
//     if (!resolved.group) {
//         await safeSend(message.from, '❌ Invalid group index. Run !list');
//         break;
//     }

//     // 3️⃣ Parse rest of command
//     const full = args.slice(1).join(' ');
//     const pipeIndex = full.indexOf('|');
//     if (pipeIndex === -1) {
//         await safeSend(message.from, '❗ Missing message. Use: | <message>');
//         break;
//     }

//     const targetPart = full.slice(0, pipeIndex).trim();
//     const msgText = full.slice(pipeIndex + 1).trim();

//     if (!msgText) {
//         await safeSend(message.from, '❗ The message after "|" cannot be empty.');
//         break;
//     }

//     // 4️⃣ Fetch group participants
//     const chat = await client.getChatById(resolved.group.groupId).catch(() => null);
//     if (!chat) {
//         await safeSend(message.from, '❌ Could not fetch group.');
//         break;
//     }

//     // const parts = chat.participants?.length ? chat.participants : await chat.fetchParticipants();
//     let parts = [];
// try {
//     if (Array.isArray(chat.participants) && chat.participants.length) {
//         parts = chat.participants;
//     } else if (typeof chat.getParticipants === "function") {
//         parts = await chat.getParticipants();
//     } else {
//         parts = [];
//     }
// } catch {
//     parts = [];
// }

//     const allJids = parts.map(p => p.id._serialized);

//     // 5️⃣ Parse targets (mentions, numbers, indexes)
//     const targetSet = new Set();

//     const tokens = targetPart.split(/\s+/);

//     for (const token of tokens) {

//         // A: Mentions (@username)
//         if (token.includes('@')) {
//             const num = token.replace(/[^0-9]/g, '');
//             if (num.length > 5) targetSet.add(num + '@c.us');
//         }

//         // B: Phone numbers
//         else if (/^\d+$/.test(token) && token.length >= 7) {
//             const formatted = token.startsWith('234') ? token : '234' + token;
//             targetSet.add(formatted + '@c.us');
//         }

//         // C: Index list (1,3,5)
//         else if (/^\d+(,\d+)*$/.test(token)) {
//             token.split(',').map(n => parseInt(n)).forEach(i => {
//                 const jid = allJids[i - 1];
//                 if (jid) targetSet.add(jid);
//             });
//         }
//     }

//     if (!targetSet.size) {
//         await safeSend(message.from, '❗ No valid targets detected.');
//         break;
//     }

//     // 6️⃣ Send private messages
//     let delivered = 0;

//     for (const jid of targetSet) {
//         if (jid === mySelf) continue;

//         try {
//             await client.sendMessage(jid, msgText);
//             delivered++;
//         } catch {}

//         await new Promise(r => setTimeout(r, 300)); // anti-spam throttle
//     }

//     // 7️⃣ Confirm to sender
//     await safeSend(
//         message.from,
//         `📨 *DM-Selected Completed*  
// Sent to **${delivered}** members in *${resolved.group.name}*.`
//     );

//     break;
// }

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
//       case 'members': {
//         // parse index or use active
//         const providedIdx = args[0] && !isNaN(args[0]) ? parseInt(args[0]) : null;
//         const resolved = await resolveTargetGroupArg(providedIdx);
//         if (!resolved.group) { await safeSend(message.from, 'No target group found. Run !list or set a default with !use'); break; }

//         const chat = await client.getChatById(resolved.group.groupId).catch(()=>null);
//         if (!chat) { await safeSend(message.from, 'Could not fetch group chat.'); break; }
//         // const parts = chat.participants?.length ? chat.participants : await chat.fetchParticipants().catch(()=>[]);
//         let parts = [];
// try {
//     if (Array.isArray(chat.participants) && chat.participants.length) {
//         parts = chat.participants;
//     } else if (typeof chat.getParticipants === "function") {
//         parts = await chat.getParticipants();
//     } else {
//         parts = [];
//     }
// } catch {
//     parts = [];
// }

//         let out = `*👥 Members of ${resolved.group.name}:*\n\n`;
//         parts.forEach((p,i)=> out += `${i+1}. ${p.id._serialized.split('@')[0]}\n`);
//         await safeSend(message.from, out);
//         break;
//       }

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
//       case 'admins': {
//         const providedIdx = args[0] && !isNaN(args[0]) ? parseInt(args[0]) : null;
//         const resolved = await resolveTargetGroupArg(providedIdx);
//         if (!resolved.group) { await safeSend(message.from, 'No target group found. Run !list or set a default with !use'); break; }

//         const chat = await client.getChatById(resolved.group.groupId).catch(()=>null);
//         if (!chat) { await safeSend(message.from, 'Could not fetch group chat.'); break; }
//         // const parts = chat.participants?.length ? chat.participants : await chat.fetchParticipants().catch(()=>[]);
//         let parts = [];
// try {
//     if (Array.isArray(chat.participants) && chat.participants.length) {
//         parts = chat.participants;
//     } else if (typeof chat.getParticipants === "function") {
//         parts = await chat.getParticipants();
//     } else {
//         parts = [];
//     }
// } catch {
//     parts = [];
// }

//         const admins = parts.filter(p => p.isAdmin || p.isSuperAdmin);
//         if (!admins.length) { await safeSend(message.from, 'No admins detected.'); break; }
//         let out = `*🛡 Admins of ${resolved.group.name}:*\n\n`;
//         admins.forEach((a,i)=> out += `${i+1}. ${a.id._serialized.split('@')[0]}\n`);
//         await safeSend(message.from, out);
//         break;
//       }

case 'admins': {
    // 1️⃣ Parse group index (or use active)
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
            participants = dbList.map(j => ({ id: { _serialized: j }, isAdmin: false, isSuperAdmin: false }));
        }

        // 2) Official API (best when permitted)
        else if (typeof chat.getParticipants === "function") {
            const fetched = await chat.getParticipants().catch(() => []);
            if (Array.isArray(fetched) && fetched.length) {
                participants = fetched;

                // update DB
                const jids = fetched.map(p => p.id?._serialized || p);
                await setMembersForGroup(sessionId, resolved.group.groupId, jids);
            }
        }

        // 3) Fallback (older API)
        else if (Array.isArray(chat.participants) && chat.participants.length) {
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

    // ------------------------------------------------------------
    // 🟡 NO PARTICIPANTS AVAILABLE
    // ------------------------------------------------------------
    if (!participants.length) {
        await safeSend(
            message.from,
            `⚠ Cannot list admins for *${resolved.group.name}*.\n` +
            `This may be a WhatsApp Community subgroup.\n` +
            `Try: !syncmembers after promoting bot to admin.`
        );
        break;
    }

    // ------------------------------------------------------------
    // 🟢 FILTER ADMINS
    // ------------------------------------------------------------
    const admins = participants.filter(
        p => p.isAdmin || p.isSuperAdmin
    );

    if (!admins.length) {
        await safeSend(message.from, `⚠ No admins detected in *${resolved.group.name}*.`);
        break;
    }

    // ------------------------------------------------------------
    // 🟢 BUILD OUTPUT
    // ------------------------------------------------------------
    let out = `*🛡 Admins of ${resolved.group.name}:*\n\n`;

    admins.forEach((admin, i) => {
        const jid = admin.id?._serialized || '';
        const num = jid.split('@')[0];
        out += `${i + 1}. ${num}\n`;
    });

    await safeSend(message.from, out);
    break;
}


      // /* ---------- TAG ---------- */
      // case 'tag': {
      //   // usage: !tag <index> OR !tag (use default)
      //   const providedIdx = args[0] && !isNaN(args[0]) ? parseInt(args[0]) : null;
      //   const resolved = await resolveTargetGroupArg(providedIdx);
      //   if (!resolved.group) { await safeSend(message.from, 'No target group found. Run !list or set a default with !use'); break; }

      //   const chat = await client.getChatById(resolved.group.groupId).catch(()=>null);
      //   if (!chat) { await safeSend(message.from, 'Could not fetch group chat.'); break; }

      //   const participants = chat.participants?.length ? chat.participants : await chat.fetchParticipants().catch(()=>[]);
      //   const mentions = [];
      //   // prepare mention Contact objects (these will be shown as mentions)
      //   for (const p of participants) {
      //     const contact = await client.getContactById(p.id._serialized).catch(()=>null);
      //     if (contact) mentions.push(contact);
      //   }

      //   // optional custom message after index, e.g. "!tag 2 Meeting now"
      //   const msgAfterIndex = (providedIdx ? args.slice(1) : args).join(' ').trim();
      //   const text = msgAfterIndex || '*🔔 Attention everyone!*';

      //   // send inside the group using mentions (WhatsApp will notify without showing raw numbers)
      //   await client.sendMessage(resolved.group.groupId, text, { mentions });
      //   await safeSend(message.from, `✅ Tag executed in *${resolved.group.name}* (index ${resolved.index}).`);
      //   break;
      // }

      // /* ---------- TAGEXCEPT ---------- */
      // case 'tagexcept': {
      //   // usage: !tagexcept <index> <1,2,3> [optional message]
      //   const providedIdx = args[0] && !isNaN(args[0]) ? parseInt(args[0]) : null;
      //   if (!providedIdx) { await safeSend(message.from, 'Usage: !tagexcept <groupIndex> <comma-separated member indexes> [message]'); break; }
      //   const membersArg = args[1] ? args[1] : '';
      //   const excludeIdxs = membersArg.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
      //   const resolved = await resolveTargetGroupArg(providedIdx);
      //   if (!resolved.group) { await safeSend(message.from, 'No target group found. Run !list or set a default with !use'); break; }

      //   const chat = await client.getChatById(resolved.group.groupId).catch(()=>null);
      //   if (!chat) { await safeSend(message.from, 'Could not fetch group chat.'); break; }
      //   const parts = chat.participants?.length ? chat.participants : await chat.fetchParticipants().catch(()=>[]);
      //   const allMembers = parts.map(p => p.id._serialized);

      //   const mentions = [];
      //   for (let i = 0; i < allMembers.length; i++) {
      //     if (excludeIdxs.includes(i+1)) continue; // indexes are 1-based
      //     const contact = await client.getContactById(allMembers[i]).catch(()=>null);
      //     if (contact) mentions.push(contact);
      //   }

      //   const extraMessage = args.slice(2).join(' ').trim() || '*🔔 Attention (filtered)*';
      //   await client.sendMessage(resolved.group.groupId, extraMessage, { mentions });
      //   await safeSend(message.from, `✅ Filtered tag executed in *${resolved.group.name}*.`);
      //   break;
      // }
/* ---------- TAG ---------- */
// case 'tag': {
//     if (!isSelfChat) return;

//     // usage: !tag <index> OR !tag (use default)
//     const providedIdx = args[0] && !isNaN(args[0]) ? parseInt(args[0]) : null;
//     const resolved = await resolveTargetGroupArg(providedIdx);

//     if (!resolved.group) {
//         await safeSend(message.from, '❌ No target group found. Run !list or set a default with !use');
//         break;
//     }

//     const chat = await client.getChatById(resolved.group.groupId).catch(() => null);
//     if (!chat) {
//         await safeSend(message.from, '❌ Could not fetch group chat.');
//         break;
//     }

//     const participants = chat.participants?.length
//         ? chat.participants
//         : await chat.fetchParticipants().catch(() => []);

//     const mentions = [];
//     for (const p of participants) {
//         const contact = await client.getContactById(p.id._serialized).catch(() => null);
//         if (contact) mentions.push(contact);
//     }

//     const msgAfterIndex = (providedIdx ? args.slice(1) : args).join(' ').trim();
//     const text = msgAfterIndex || '*🔔 Attention everyone!*';

//     await client.sendMessage(resolved.group.groupId, text, { mentions });

//     await safeSend(
//         message.from,
//         `✅ Tag executed in *${resolved.group.name}* (index ${resolved.index}).`
//     );
//     break;
// }

case 'tag': {
  if (!isSelfChat) return;

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

  // participants resolver (DB -> official -> chat.participants)
  let participants = [];
  try {
    const dbList = await getMembersFromDB(sessionId, resolved.group.groupId);
    if (Array.isArray(dbList) && dbList.length) {
      participants = dbList.map(j => ({ id: { _serialized: j } }));
    } else if (typeof chat.getParticipants === 'function') {
      const fetched = await chat.getParticipants().catch(()=>[]);
      if (fetched && fetched.length) {
        participants = fetched;
        await setMembersForGroup(sessionId, resolved.group.groupId, fetched.map(p => p.id?._serialized || p));
      }
    } else if (Array.isArray(chat.participants) && chat.participants.length) {
      participants = chat.participants;
      await setMembersForGroup(sessionId, resolved.group.groupId, participants.map(p => p.id && p.id._serialized ? p.id._serialized : (typeof p === 'string' ? p : null)).filter(Boolean));
    }
  } catch (e) {
    participants = [];
  }

  if (!participants.length) {
    await safeSend(message.from,
      `⚠ Could not determine members for ${resolved.group.name}.\n` +
      `This is likely a Community-subgroup or restricted group. Use !syncmembers after promoting the bot to admin, or ask members to send messages so I can collect them.`);
    break;
  }

  const mentions = [];
  for (const p of participants) {
    const jid = (p && p.id && p.id._serialized) ? p.id._serialized : (typeof p === 'string' ? p : null);
    if (!jid) continue;
    const contact = await client.getContactById(jid).catch(()=>null);
    if (contact) mentions.push(contact);
  }

  const msgAfterIndex = (providedIdx ? args.slice(1) : args).join(' ').trim();
  const text = msgAfterIndex || '*🔔 Attention everyone!*';

  await client.sendMessage(resolved.group.groupId, text, { mentions });
  await safeSend(message.from, `✅ Tag executed in *${resolved.group.name}*.`);
  break;
}


/* ---------- TAGEXCEPT ---------- */
// case 'tagexcept': {
//     if (!isSelfChat) return;

//     // First argument = group index
//     const providedIdx = args[0] && !isNaN(args[0]) ? parseInt(args[0]) : null;
//     if (!providedIdx) {
//         await safeSend(message.from,
//             '❗ Usage: !tagexcept <groupIndex> <excluded> [optional message]\nExamples:\n' +
//             '!tagexcept 2 @john @mary\n!tagexcept 2 08123456789\n!tagexcept 2 1,3,5'
//         );
//         break;
//     }

//     // Resolve target group
//     const resolved = await resolveTargetGroupArg(providedIdx);
//     if (!resolved.group) {
//         await safeSend(message.from, '❌ No target group found. Use !list or !use <index>');
//         break;
//     }

//     const chat = await client.getChatById(resolved.group.groupId).catch(() => null);
//     if (!chat) {
//         await safeSend(message.from, '❌ Could not fetch group chat.');
//         break;
//     }

//     const participants = chat.participants?.length
//         ? chat.participants
//         : await chat.fetchParticipants().catch(() => []);

//     const participantJIDs = participants.map(p => p.id._serialized);

//     // ------------------------------
//     // 1️⃣ Parse exclusion list (mentions, phone numbers, indexes)
//     // ------------------------------
//     const excludedSet = new Set();

//     const exclusionArgs = args.slice(1); // all arguments after group index

//     for (const part of exclusionArgs) {
//         // A: Mentions (@username)
//         if (part.includes('@')) {
//             const num = part.replace(/[^0-9]/g, '');
//             if (num.length > 5) excludedSet.add(`${num}@c.us`);
//         }

//         // B: Phone numbers (081..., 090..., 234...)
//         else if (/^\d+$/.test(part) && part.length >= 7) {
//             const formatted = part.startsWith('234')
//                 ? `${part}@c.us`
//                 : `234${part}@c.us`;
//             excludedSet.add(formatted);
//         }

//         // C: Old index system (1,3,4)
//         else if (/^\d+(,\d+)*$/.test(part)) {
//             const indexes = part.split(',').map(n => parseInt(n.trim()));
//             for (const idx of indexes) {
//                 const jid = participantJIDs[idx - 1];
//                 if (jid) excludedSet.add(jid);
//             }
//         }
//     }

//     // ------------------------------
//     // 2️⃣ Build mention list (everyone except excluded)
//     // ------------------------------
//     const mentions = [];
//     for (const jid of participantJIDs) {
//         if (!excludedSet.has(jid)) {
//             const contact = await client.getContactById(jid).catch(() => null);
//             if (contact) mentions.push(contact);
//         }
//     }

//     // ------------------------------
//     // 3️⃣ Send final message to group
//     // ------------------------------
//     const optionalMessageIndex = 1 + exclusionArgs.length;
//     const customMsg = args.slice(optionalMessageIndex).join(' ').trim()
//         || '*🔔 Attention (filtered)*';

//     await client.sendMessage(resolved.group.groupId, customMsg, { mentions });

//     await safeSend(
//         message.from,
//         `✅ Tag-except executed in *${resolved.group.name}*.\nExcluded: ${[...excludedSet].join(', ') || 'none'}`
//     );
//     break;
// }

case 'tagexcept': {
    if (!isSelfChat) return;

    // First argument = group index
    const providedIdx = args[0] && !isNaN(args[0]) ? parseInt(args[0]) : null;
    if (!providedIdx) {
        await safeSend(message.from,
            '❗ Usage: !tagexcept <groupIndex> <excluded> [optional message]\nExamples:\n' +
            '!tagexcept 2 @john @mary\n!tagexcept 2 08123456789\n!tagexcept 2 1,3,5'
        );
        break;
    }

    // Resolve target group
    const resolved = await resolveTargetGroupArg(providedIdx);
    if (!resolved.group) {
        await safeSend(message.from, '❌ No target group found. Use !list or !use <index>');
        break;
    }

    const chat = await client.getChatById(resolved.group.groupId).catch(() => null);
    if (!chat) {
        await safeSend(message.from, '❌ Could not fetch group chat.');
        break;
    }

    // ------------------------------------------------------------
    // 🟢 Generic Participant Resolver (DB → getParticipants → fallback)
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
                .map(p => p.id && p.id._serialized ? p.id._serialized : null)
                .filter(Boolean);

            if (jids.length) await setMembersForGroup(sessionId, resolved.group.groupId, jids);
        }
    } catch (e) {
        participants = [];
    }

    if (!participants.length) {
        await safeSend(
            message.from,
            `⚠ Cannot determine members for *${resolved.group.name}*.\n` +
            `This group may be a Community subgroup.\n` +
            `Use !syncmembers after making bot admin.`
        );
        break;
    }

    const participantJIDs = participants.map(p => p.id._serialized);

    // ------------------------------------------------------------
    // 🟢 1️⃣ Parse exclusion list
    // ------------------------------------------------------------
    const excludedSet = new Set();
    const exclusionArgs = args.slice(1);

    for (const part of exclusionArgs) {

        // A: Mentions like @john
        if (part.includes('@')) {
            const num = part.replace(/[^0-9]/g, '');
            if (num.length >= 6) excludedSet.add(num + '@c.us');
        }

        // B: Phone numbers
        else if (/^\d+$/.test(part) && part.length >= 7) {
            const formatted = part.startsWith('234') ? part : '234' + part;
            excludedSet.add(formatted + '@c.us');
        }

        // C: Index list like 1,3,5
        else if (/^\d+(,\d+)*$/.test(part)) {
            const indexes = part.split(',').map(n => parseInt(n.trim()));
            for (const i of indexes) {
                const jid = participantJIDs[i - 1];
                if (jid) excludedSet.add(jid);
            }
        }
    }

    // ------------------------------------------------------------
    // 🟢 2️⃣ Build final mention list (everyone except excluded)
    // ------------------------------------------------------------
    const mentions = [];

    for (const jid of participantJIDs) {
        if (!excludedSet.has(jid)) {
            const contact = await client.getContactById(jid).catch(() => null);
            if (contact) mentions.push(contact);
        }
    }

    // ------------------------------------------------------------
    // 🟢 3️⃣ Determine custom message
    // ------------------------------------------------------------
    const optMsgIndex = 1 + exclusionArgs.length;
    const customMsg = args.slice(optMsgIndex).join(' ').trim() ||
        '*🔔 Attention (filtered)*';

    // ------------------------------------------------------------
    // 🟢 4️⃣ SEND MESSAGE — Chunking support for large groups
    // ------------------------------------------------------------
    if (mentions.length > 70) {
        // Use chunk sending (recommended)
        await sendMentionsInChunks(resolved.group.groupId, mentions, customMsg);
    } else {
        await client.sendMessage(resolved.group.groupId, customMsg, { mentions });
    }

    // ------------------------------------------------------------
    // 🟢 Confirmation
    // ------------------------------------------------------------
    await safeSend(
        message.from,
        `✅ Tag-except executed in *${resolved.group.name}*.\nExcluded: ${[...excludedSet].join(', ') || 'none'}.`
    );

    break;
}


      /* ---------- FORWARDALL ---------- */
//       case 'forwardall': {
//         // usage: reply to a message in DM with !forwardall <index>
//         if (!message.hasQuotedMsg) { await safeSend(message.from, '❗ Reply to the message and run: !forwardall <groupIndex>'); break; }
//         const providedIdx = args[0] && !isNaN(args[0]) ? parseInt(args[0]) : null;
//         const resolved = await resolveTargetGroupArg(providedIdx);
//         if (!resolved.group) { await safeSend(message.from, 'No target group found. Run !list or set a default with !use'); break; }

//         const quoted = await message.getQuotedMessage();
//         const chat = await client.getChatById(resolved.group.groupId).catch(()=>null);
//         if (!chat) { await safeSend(message.from, 'Could not fetch group chat.'); break; }
//         // const parts = chat.participants?.length ? chat.participants : await chat.fetchParticipants().catch(()=>[]);
//         let parts = [];
// try {
//     if (Array.isArray(chat.participants) && chat.participants.length) {
//         parts = chat.participants;
//     } else if (typeof chat.getParticipants === "function") {
//         parts = await chat.getParticipants();
//     } else {
//         parts = [];
//     }
// } catch {
//     parts = [];
// }

//         const targets = parts.map(p => p.id._serialized).filter(j => j !== mySelf);

//         await safeSend(message.from, `🔁 Forwarding to ${targets.length} members...`);
//         for (const t of targets) {
//           try {
//             if (quoted.hasMedia) {
//               const media = await quoted.downloadMedia();
//               await client.sendMessage(t, media, { caption: quoted.body || '' });
//             } else {
//               await client.sendMessage(t, quoted.body || '');
//             }
//             await new Promise(r=>setTimeout(r,200));
//           } catch (e) {
//             logger.error(`[${sessionName}] forwardall -> ${t}`, e.message || e);
//           }
//         }
//         await safeSend(message.from, '✅ Forwarding complete.');
//         break;
//       }

case 'forwardall': {
    if (!isSelfChat) return;

    // Must reply to a message
    if (!message.hasQuotedMsg) {
        await safeSend(message.from, '❗ Reply to the message and run:\n!forwardall <groupIndex>');
        break;
    }

    const providedIdx = args[0] && !isNaN(args[0]) ? parseInt(args[0]) : null;
    const resolved = await resolveTargetGroupArg(providedIdx);

    if (!resolved.group) {
        await safeSend(message.from, '❌ No target group found. Run !list or set default with !use.');
        break;
    }

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
            `Bot may not be admin or group is a Community subgroup.\n` +
            `Try !syncmembers after promoting bot to admin.`
        );
        break;
    }

    const targetJIDs = participants
        .map(p => p.id._serialized)
        .filter(j => j !== mySelf); // skip bot itself

    if (!targetJIDs.length) {
        await safeSend(message.from, '❗ No valid members to forward to.');
        break;
    }

    // ------------------------------------------------------------
    // 🟢 CONFIRMATION TO OWNER
    // ------------------------------------------------------------
    await safeSend(
        message.from,
        `🔁 Forwarding to **${targetJIDs.length}** members of *${resolved.group.name}*...`
    );

    // ------------------------------------------------------------
    // 🟢 SEND MEDIA OR TEXT TO EACH MEMBER (throttled)
    // ------------------------------------------------------------
    for (const jid of targetJIDs) {
        try {
            if (quoted.hasMedia) {
                const media = await quoted.downloadMedia();
                await client.sendMessage(jid, media, {
                    caption: quoted.body || ''
                });
            } else {
                await client.sendMessage(jid, quoted.body || '');
            }

            // throttle to avoid spam-ban
            await new Promise(r => setTimeout(r, 300));

        } catch (e) {
            logger.error(`[${sessionName}] forwardall -> ${jid}`, e.message || e);
        }
    }

    // ------------------------------------------------------------
    // 🟢 DONE
    // ------------------------------------------------------------
    await safeSend(message.from, '✅ Forward-all completed successfully.');
    break;
}


      /* ---------- FORWARD ---------- */
//       case 'forward': {
//         // usage: reply to a message then: !forward <groupIndex> <targets>
//         if (!message.hasQuotedMsg) { await safeSend(message.from,'❗ Reply with !forward <groupIndex> <targets>'); break; }
//         const providedIdx = args[0] && !isNaN(args[0]) ? parseInt(args[0]) : null;
//         const rawTargets = args.slice(providedIdx ? 1 : 0).join(' ');
//         const resolved = await resolveTargetGroupArg(providedIdx);
//         if (!resolved.group) { await safeSend(message.from, 'No target group found. Run !list or set a default with !use'); break; }

//         const quoted = await message.getQuotedMessage();
//         const chat = await client.getChatById(resolved.group.groupId).catch(()=>null);
//         if (!chat) { await safeSend(message.from, 'Could not fetch group chat.'); break; }
//         // const parts = chat.participants?.length ? chat.participants : await chat.fetchParticipants().catch(()=>[]);
// let parts = [];
// try {
//     if (Array.isArray(chat.participants) && chat.participants.length) {
//         parts = chat.participants;
//     } else if (typeof chat.getParticipants === "function") {
//         parts = await chat.getParticipants();
//     } else {
//         parts = [];
//     }
// } catch {
//     parts = [];
// }

//         // parse targets: indexes or @numbers
//         let targets = [];
//         const atMatches = rawTargets.match(/@?(\d{6,20})/g);
//         if (atMatches) {
//           targets = atMatches.map(m => `${m.replace(/[^0-9]/g,'')}@c.us`);
//         } else if (/^[0-9,\s]+$/.test(rawTargets) && rawTargets.trim()) {
//           const idxs = rawTargets.split(',').map(s=>parseInt(s.trim())).filter(n=>!isNaN(n));
//           targets = idxs.map(i => parts[i-1] && parts[i-1].id._serialized).filter(Boolean);
//         } else {
//           const nums = rawTargets.split(',').map(s => s.replace(/[^0-9]/g,'')).filter(s => s.length>5);
//           if (nums.length) targets = nums.map(n => `${n}@c.us`);
//         }

//         if (!targets.length) { await safeSend(message.from, '❗ Could not parse targets.'); break; }

//         await safeSend(message.from, `🔁 Forwarding to ${targets.length} recipients...`);
//         for (const t of targets) {
//           try {
//             if (quoted.hasMedia) {
//               const media = await quoted.downloadMedia();
//               await client.sendMessage(t, media, { caption: quoted.body || '' });
//             } else {
//               await client.sendMessage(t, quoted.body || '');
//             }
//             await new Promise(r=>setTimeout(r,200));
//           } catch (e) {
//             logger.error(`[${sessionName}] forward -> ${t}`, e.message || e);
//           }
//         }
//         await safeSend(message.from, '✅ Forwarding complete.');
//         break;
//       }

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
