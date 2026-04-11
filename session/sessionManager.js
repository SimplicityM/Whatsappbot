const makeWASocket = require("@whiskeysockets/baileys").default;
const { useMongoAuthState } = require("./mongoAuth"); // your existing logic

class SessionManager {
  constructor() {
    this.sessions = new Map();
  }

  async createSession(sessionId) {
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId);
    }

    const { state, saveCreds } = await useMongoAuthState(sessionId);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", update => {
      const { connection } = update;

      if (connection === "close") {
        this.sessions.delete(sessionId);
      }
    });

    this.sessions.set(sessionId, sock);
    return sock;
  }

  get(sessionId) {
    return this.sessions.get(sessionId);
  }

  remove(sessionId) {
    const sock = this.sessions.get(sessionId);
    if (sock) {
      sock.logout();
      this.sessions.delete(sessionId);
    }
  }
}

module.exports = new SessionManager();