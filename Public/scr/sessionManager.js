// src/sessionManager.js
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { connect } = require('./db');
const Session = require('./models/Session');

const { refreshGroupsForSession } = require('./groupUtils');
const { normalizeJid } = require('./utils');

const SESSION_DIR = path.join(__dirname, '..', 'sessions');
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

const clients = new Map();
const userSessions = new Map();

async function createBotSession(userId, sessionId, io, opts = {}) {
  try {
    // Ensure DB connected if URI provided
    if (process.env.MONGO_URI && !global.__mongoConnected) {
      await connect(process.env.MONGO_URI);
      global.__mongoConnected = true;
    }

    const authFolder = path.join(SESSION_DIR, `baileys-${userId}-${sessionId}`);
    if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

    let waVersion;
    try { waVersion = await fetchLatestBaileysVersion(); } catch (e) { waVersion = undefined; }

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: ['TagThemAll-Baileys', 'Server', '1.0.0'],
      version: waVersion
    });

    clients.set(sessionId, { sock, userId, sessionId });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        if (io) io.to(`user-${userId}`).emit('qrCode', { sessionId, qr, userId });
        else qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        console.log('Session open', sessionId);
        const botJid = sock.user?.id || null;
        if (botJid) userSessions.set(botJid, sessionId);
        // save session record in DB
        try {
          await Session.findOneAndUpdate({ sessionId }, {
            sessionId, userId, phone: botJid, status: 'active', updatedAt: new Date()
          }, { upsert: true, new: true });
        } catch(e){ console.error('Session save error', e); }
        refreshGroupsForSession(sock).catch(()=>{});
        if (io) io.to(`user-${userId}`).emit('sessionReady', { sessionId, phone: sock.user?.id });
      }
      if (connection === 'close') {
        const loggedOut = lastDisconnect?.error && lastDisconnect.error.output?.statusCode === DisconnectReason.loggedOut;
        // update DB
        try {
          await Session.findOneAndUpdate({ sessionId }, { status: loggedOut ? 'logged_out' : 'inactive', updatedAt: new Date() }, { upsert: true });
        } catch(e){ console.error('Session update error', e); }
        if (!loggedOut) {
          setTimeout(()=> createBotSession(userId, sessionId, io).catch(()=>{}), 5000);
        } else {
          if (io) io.to(`user-${userId}`).emit('authFailure', { sessionId, message: 'Logged out' });
        }
      }
    });

    // messages handled by commandHandler elsewhere
    return sock;
  } catch (err) {
    console.error('createBotSession error', err);
    throw err;
  }
}

module.exports = { createBotSession, clients, userSessions };