// src/commandHandler.js
const User = require('./models/User');
const Session = require('./models/Session');
const { getGroupsWhereSenderIsAdmin, executeTagAllInGroup, executeTagAllExceptInGroup } = require('./groupUtils');
const { normalizeJid } = require('./utils');

function extractText(message) {
  if (!message) return null;
  const m = message.message || message;
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage) return m.extendedTextMessage.text;
  if (m.imageMessage && m.imageMessage.caption) return m.imageMessage.caption;
  if (m.videoMessage && m.videoMessage.caption) return m.videoMessage.caption;
  return null;
}

async function sendText(sock, jid, text, mentions = []) {
  const msg = { text };
  if (mentions && mentions.length) msg.mentions = mentions;
  return sock.sendMessage(jid, msg);
}

async function checkSubscription(requesterJid, io, sessionId) {
  const norm = normalizeJid(requesterJid);
  const user = await User.findOne({ whatsappNumber: norm });
  const now = new Date();
  if (!user || !user.subscription || !user.subscription.active) {
    if (io) io.to(`user-${sessionId.split('-')[1]}`).emit('subscriptionRequired', { user: norm });
    return { ok: false, reason: 'No active subscription. Please subscribe to continue.' };
  }
  if (user.subscription.expiresAt && user.subscription.expiresAt < now) {
    // disable usage
    if (user.subscription.autoRenew) {
      // you might kick off payment retry here
    }
    if (io) io.to(`user-${sessionId.split('-')[1]}`).emit('subscriptionExpired', { user: norm });
    return { ok: false, reason: 'Subscription expired. Renew to continue.' };
  }
  return { ok: true, user };
}

async function handleCommand({ sock, message, io, sessionId }) {
  try {
    if (!message || !message.message) return;
    if (message.key && message.key.fromMe) return;
    const from = message.key.remoteJid;
    const isGroup = from && from.endsWith('@g.us');
    const text = extractText(message);
    if (!text || !text.startsWith('!')) return;
    const raw = text.slice(1).trim();
    const [commandRaw, ...args] = raw.split(/\s+/);
    const command = (commandRaw||'').toLowerCase();
    const requester = isGroup ? (message.key.participant || message.key.remoteJid) : message.key.remoteJid;

    // enforce subscription for non-help commands
    if (!['help','ping'].includes(command)) {
      const sub = await checkSubscription(requester, io, sessionId);
      if (!sub.ok) {
        await sendText(sock, from, `🚫 ${sub.reason}`);
        return;
      }
    }

    switch(command) {
      case 'ping':
        await sendText(sock, from, 'Pong! 🏓');
        break;
      case 'help':
        await sendText(sock, from, '*Commands*: !ping, !help, !status, !list, !tagall, !tagallexcept, !sessionid');
        break;
      case 'status':
        await sendText(sock, from, `Session: ${sessionId}`);
        break;
      case 'sessionid':
        await sendText(sock, from, `Your session id: ${sessionId}`);
        break;
      case 'list':
        await sendText(sock, from, 'Fetching your admin groups...');
        {
          const groups = await getGroupsWhereSenderIsAdmin(sock, requester);
          if (!groups.length) { await sendText(sock, from, 'You are not admin in any groups'); return; }
          const payload = { sessionId, userId: requester, groups: groups.map((g,i)=>({ index:i+1, id: g.id || g.groupId || g, name: g.subject || g.name || 'Unnamed', members: (g.participants && g.participants.length) || null })) };
          if (io) io.to(`user-${sessionId.split('-')[1]}`).emit('groupList', payload);
          const listText = payload.groups.map(g=>`${g.index}. ${g.name} (${g.members||'?'})`).join('\n');
          await sendText(sock, from, `Groups Where You Are Admin (${payload.groups.length}):\n${listText}\n\nUse !tagall with the numbers.`);
        }
        break;
      case 'tagall':
        // parse group indices then optional message
        {
          const senderKey = `${requester}_${sessionId}`;
          let groups = await getGroupsWhereSenderIsAdmin(sock, requester);
          if (!groups.length) { await sendText(sock, from, 'You are not admin in any groups'); return; }
          const indices = [];
          let idx = 0;
          while (idx < args.length && !isNaN(args[idx])) { indices.push(parseInt(args[idx])-1); idx++; }
          const msgText = args.slice(idx).join(' ') || '*📢 Tagged by admin*';
          if (!indices.length) { await sendText(sock, from, 'Usage: !tagall [group numbers...] [optional_message]'); return; }
          let success = 0;
          for (const i of indices) {
            if (i>=0 && i<groups.length) {
              const g = groups[i];
              try {
                const res = await executeTagAllInGroup(sock, g.id || g.groupId || g, msgText, normalizeJid(requester));
                if (res.success) success++;
                await sendText(sock, from, `✅ Tagged in "${g.subject||g.name||g.id}"`);
              } catch (err) {
                console.error('tagall error', err);
                await sendText(sock, from, `❌ Failed to tag in "${g.subject||g.name||g.id}"`);
              }
            } else {
              await sendText(sock, from, `❌ Invalid group number: ${i+1}`);
            }
          }
          if (success>0) await sendText(sock, from, `✅ Successfully tagged members in ${success} group(s)`);
        }
        break;
      case 'tagallexcept':
        {
          let groups = await getGroupsWhereSenderIsAdmin(sock, requester);
          if (!groups.length) { await sendText(sock, from, 'You are not admin in any groups'); return; }
          const groupIndices = [];
          const exceptNumbers = [];
          let idx2 = 0;
          while (idx2 < args.length && !isNaN(args[idx2])) { groupIndices.push(parseInt(args[idx2])-1); idx2++; }
          while (idx2 < args.length && /^\d+$/.test(args[idx2])) { let clean = args[idx2].replace(/\D/g,''); if (clean) exceptNumbers.push(`${clean}@s.whatsapp.net`); idx2++; }
          const msgText = args.slice(idx2).join(' ') || '*📢 Tagged by admin (excluding specified members)*';
          if (!groupIndices.length) { await sendText(sock, from, 'Usage: !tagallexcept [group numbers...] [phone numbers...] [optional_message]'); return; }
          if (!exceptNumbers.length) { await sendText(sock, from, '❌ Please specify at least one phone number to exclude'); return; }
          let successCount = 0;
          for (const gi of groupIndices) {
            if (gi>=0 && gi<groups.length) {
              const g = groups[gi];
              try {
                const res = await executeTagAllExceptInGroup(sock, g.id||g.groupId||g, msgText, normalizeJid(requester), exceptNumbers);
                if (res.success) { successCount++; await sendText(sock, from, `✅ Tagged in "${g.subject||g.name||g.id}" excluding ${exceptNumbers.length} users`); }
                else await sendText(sock, from, `⚠️ ${res.reason}`);
              } catch (err) {
                console.error('tagallexcept error', err);
                await sendText(sock, from, `❌ Failed to tag in "${g.subject||g.name||g.id}"`);
              }
            } else {
              await sendText(sock, from, `❌ Invalid group number: ${gi+1}`);
            }
          }
          if (successCount>0) await sendText(sock, from, `✅ Successfully tagged members in ${successCount} group(s)`);
        }
        break;
      default:
        await sendText(sock, from, 'Unknown command. Try !help');
    }
  } catch (err) {
    console.error('handleCommand error', err);
  }
}

module.exports = { handleCommand, checkSubscription };



// src/commandHandler.js
const User = require('./models/User');
const Session = require('./models/Session');
const Contact = require('./models/Contact');
const { getGroupsWhereSenderIsAdmin, executeTagAllInGroup, executeTagAllExceptInGroup } = require('./groupUtils');
const { normalizeJid } = require('./utils');
function extractText(message){ if(!message) return null; const m = message.message||message; if(m.conversation) return m.conversation; if(m.extendedTextMessage) return m.extendedTextMessage.text; if(m.imageMessage && m.imageMessage.caption) return m.imageMessage.caption; if(m.videoMessage && m.videoMessage.caption) return m.videoMessage.caption; return null; }
async function sendText(sock, jid, text, mentions=[]){ const msg={ text }; if(mentions && mentions.length) msg.mentions = mentions; return sock.sendMessage(jid,msg); }
async function checkSubscription(requesterJid, io, sessionId){ const norm = normalizeJid(requesterJid); const user = await User.findOne({ whatsappNumber: norm }); const now = new Date(); if(!user || !user.subscription || !user.subscription.active){ if(io) io.to(`user-${sessionId.split('-')[1]}`).emit('subscriptionRequired',{ user: norm }); return { ok:false, reason:'No active subscription. Please subscribe.' }; } if(user.subscription.expiresAt && user.subscription.expiresAt < now){ if(io) io.to(`user-${sessionId.split('-')[1]}`).emit('subscriptionExpired',{ user: norm }); return { ok:false, reason:'Subscription expired. Renew to continue.' }; } return { ok:true, user }; }
async function ensureContactSaved(ownerUserId, ownerEmail, contactJid, pushName){ try { const norm = normalizeJid(contactJid); const existing = await Contact.findOne({ ownerUserId, contactNumber: norm }); if(existing){ existing.lastContactedAt = new Date(); await existing.save(); return existing; } const c = new Contact({ ownerUserId, ownerEmail, contactNumber: norm, contactName: pushName || null }); await c.save(); return c; } catch(err){ console.error('ensureContactSaved error', err); } }
async function handleCommand({ sock, message, io, sessionId, ownerUserId, ownerEmail }){ try{ if(!message || !message.message) return; if(message.key && message.key.fromMe) return; const from = message.key.remoteJid; const isGroup = from && from.endsWith('@g.us'); const text = extractText(message); if(!text) return; const requester = isGroup ? (message.key.participant || message.key.remoteJid) : message.key.remoteJid; if(!isGroup){ await ensureContactSaved(ownerUserId, ownerEmail, requester, message.pushName || null); if(io) io.to(`user-${ownerUserId}`).emit('newContact', { ownerUserId, ownerEmail, contactNumber: requester, contactName: message.pushName || null }); } else { const participant = message.key.participant; if(participant && participant !== ownerEmail) { await ensureContactSaved(ownerUserId, ownerEmail, participant, message.pushName || null); } } if(!text.startsWith('!')) return; const raw = text.slice(1).trim(); const [commandRaw,...args] = raw.split(/\s+/); const command = (commandRaw||'').toLowerCase(); if(!['help','ping'].includes(command)){ const sub = await checkSubscription(requester, io, sessionId); if(!sub.ok){ await sendText(sock, from, `🚫 ${sub.reason}`); return; } } switch(command){ case 'ping': await sendText(sock, from, 'Pong! 🏓'); break; case 'help': await sendText(sock, from, '*Commands*: !ping, !help, !status, !list, !tagall, !tagallexcept, !sessionid'); break; case 'status': await sendText(sock, from, `Session: ${sessionId}`); break; case 'sessionid': await sendText(sock, from, `Your session id: ${sessionId}`); break; case 'list': await sendText(sock, from, 'Fetching your admin groups...'); { const groups = await getGroupsWhereSenderIsAdmin(sock, requester); if(!groups.length){ await sendText(sock, from, 'You are not admin in any groups'); return; } const payload = { sessionId, userId: requester, groups: groups.map((g,i)=>({ index:i+1, id: g.id||g.groupId||g, name: g.subject||g.name||'Unnamed', members:(g.participants&&g.participants.length)||null })) }; if(io) io.to(`user-${ownerUserId}`).emit('groupList', payload); const listText = payload.groups.map(g=>`${g.index}. ${g.name} (${g.members||'?'})`).join('\n'); await sendText(sock, from, `Groups Where You Are Admin (${payload.groups.length}):\n${listText}\n\nUse !tagall with the numbers.`); } break; case 'tagall': { let groups = await getGroupsWhereSenderIsAdmin(sock, requester); if(!groups.length){ await sendText(sock, from, 'You are not admin in any groups'); return; } const indices=[]; let idx=0; while(idx<args.length && !isNaN(args[idx])){ indices.push(parseInt(args[idx])-1); idx++; } const msgText = args.slice(idx).join(' ')||'*📢 Tagged by admin*'; if(!indices.length){ await sendText(sock, from, 'Usage: !tagall [group numbers...] [optional_message]'); return; } let success=0; for(const i of indices){ if(i>=0&&i<groups.length){ const g=groups[i]; try{ const res=await executeTagAllInGroup(sock, g.id||g.groupId||g, msgText, normalizeJid(requester)); if(res.success) success++; await sendText(sock, from, `✅ Tagged in "${g.subject||g.name||g.id}"`); } catch(err){ console.error('tagall error',err); await sendText(sock, from, `❌ Failed to tag in "${g.subject||g.name||g.id}"`); } } else { await sendText(sock, from, `❌ Invalid group number: ${i+1}`); } } if(success>0) await sendText(sock, from, `✅ Successfully tagged members in ${success} group(s)`); } break; case 'tagallexcept': { let groups = await getGroupsWhereSenderIsAdmin(sock, requester); if(!groups.length){ await sendText(sock, from, 'You are not admin in any groups'); return; } const groupIndices=[]; const exceptNumbers=[]; let idx2=0; while(idx2<args.length && !isNaN(args[idx2])){ groupIndices.push(parseInt(args[idx2])-1); idx2++; } while(idx2<args.length && /^\d+$/.test(args[idx2])){ let clean=args[idx2].replace(/\D/g,''); if(clean) exceptNumbers.push(`${clean}@s.whatsapp.net`); idx2++; } const msgText=args.slice(idx2).join(' ')||'*📢 Tagged by admin (excluding specified members)*'; if(!groupIndices.length){ await sendText(sock, from, 'Usage: !tagallexcept [group numbers...] [phone numbers...] [optional_message]'); return; } if(!exceptNumbers.length){ await sendText(sock, from, '❌ Please specify at least one phone number to exclude'); return; } let successCount=0; for(const gi of groupIndices){ if(gi>=0&&gi<groups.length){ const g=groups[gi]; try{ const res=await executeTagAllExceptInGroup(sock, g.id||g.groupId||g, msgText, normalizeJid(requester), exceptNumbers); if(res.success){ successCount++; await sendText(sock, from, `✅ Tagged in "${g.subject||g.name||g.id}" excluding ${exceptNumbers.length} users`); } else await sendText(sock, from, `⚠️ ${res.reason}`); } catch(err){ console.error('tagallexcept error',err); await sendText(sock, from, `❌ Failed to tag in "${g.subject||g.name||g.id}"`); } } else { await sendText(sock, from, `❌ Invalid group number: ${gi+1}`); } } if(successCount>0) await sendText(sock, from, `✅ Successfully tagged members in ${successCount} group(s)`); } break; default: await sendText(sock, from, 'Unknown command. Try !help'); } }catch(err){ console.error('handleCommand error', err); } }
module.exports = { handleCommand, ensureContactSaved };
