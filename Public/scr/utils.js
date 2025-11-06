// src/utils.js
function normalizeJid(jid) {
  if (!jid) return jid;
  if (jid.includes('@')) return jid;
  if (jid.endsWith('-g')) return `${jid}@g.us`;
  return `${jid}@s.whatsapp.net`;
}

module.exports = { normalizeJid };