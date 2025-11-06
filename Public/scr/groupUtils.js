// src/groupUtils.js
const { normalizeJid } = require('./utils');
async function refreshGroupsForSession(sock) {
  try {
    let groups = [];
    if (typeof sock.groupFetchAllParticipating === 'function') {
      const obj = await sock.groupFetchAllParticipating();
      groups = Object.values(obj || {});
    } else {
      const store = sock.store?.chats || {};
      const groupJids = Object.keys(store).filter(j => j.endsWith('@g.us'));
      for (const g of groupJids) {
        try { const meta = await sock.groupMetadata(g); groups.push(meta); } catch(e) {}
      }
    }
    return groups;
  } catch (err) { console.error('refreshGroupsForSession error', err); return []; }
}
async function getGroupsWhereSenderIsAdmin(sock, senderId) {
  try {
    const groups = await refreshGroupsForSession(sock);
    const normalizedSender = normalizeJid(senderId);
    const adminGroups = [];
    for (const g of groups) {
      try {
        const meta = g.id ? g : await sock.groupMetadata(g.id || g.groupId || g);
        const participants = meta.participants || [];
        const found = participants.find(p => {
          const pid = p.id || p.jid || p;
          const cleanPid = pid._serialized || pid;
          const digitsA = normalizedSender.replace(/\D/g,''); const digitsB = (cleanPid || '').replace(/\D/g,'');
          return digitsA && digitsB && (digitsA === digitsB || digitsB.endsWith(digitsA) || digitsA.endsWith(digitsB));
        });
        if (found && (found.admin === 'admin' || found.admin === 'superadmin' || found.isAdmin || found.isSuperAdmin)) adminGroups.push(meta);
      } catch(e){}
    }
    return adminGroups;
  } catch (err) { console.error('getGroupsWhereSenderIsAdmin error', err); return []; }
}
async function executeTagAllInGroup(sock, groupId, text, adminJid) {
  const meta = await sock.groupMetadata(groupId);
  const participants = meta?.participants || [];
  const mentionJids = participants.map(p => (p.id && (p.id._serialized || p.id)) || p);
  const filtered = mentionJids.map(m => (m._serialized || m)).filter(j => j !== adminJid);
  if (!filtered.length) throw new Error('No members to tag');
  let messageText = `${text || '*📢 Tagged by admin*'}

`; for (const m of filtered) messageText += `@${m.split('@')[0]} `;
  await sock.sendMessage(groupId, { text: messageText, mentions: filtered });
  return { success: true, tagged: filtered.length };
}
async function executeTagAllExceptInGroup(sock, groupId, text, adminJid, exceptUsers=[]) {
  const meta = await sock.groupMetadata(groupId);
  const participants = meta?.participants || [];
  const exceptSet = new Set(exceptUsers.map(u => normalizeJid(u)));
  const mentionJids = participants.map(p => (p.id && (p.id._serialized || p.id)) || p).map(m => (m._serialized || m));
  const filtered = mentionJids.filter(j => j !== adminJid && !exceptSet.has(normalizeJid(j)));
  if (!filtered.length) return { success: false, reason: 'No members to tag after excluding' };
  let messageText = `${text || '*📢 Tagged by admin (excluding specified members)*'}

`; for (const m of filtered) messageText += `@${m.split('@')[0]} `;
  await sock.sendMessage(groupId, { text: messageText, mentions: filtered });
  return { success: true, tagged: filtered.length, excluded: exceptSet.size };
}
module.exports = { refreshGroupsForSession, getGroupsWhereSenderIsAdmin, executeTagAllInGroup, executeTagAllExceptInGroup };
