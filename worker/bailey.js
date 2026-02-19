/**
 * =====================================================
 *                BAILEYS SESSION ENGINE
 * =====================================================
 * Handles:
 *  - Multi-session management
 *  - QR generation
 *  - Reconnect logic
 *  - Status updates
 *  - Safe logout
 * =====================================================
 */

const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    makeInMemoryStore
} = require("@whiskeysockets/baileys");

const P = require("pino");
const fs = require("fs");
const path = require("path");

const sessions = new Map(); // Active session map

// Ensure sessions directory exists
const SESSIONS_DIR = path.join(__dirname, "sessions");
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR);
}

// =====================================================
// CREATE NEW SESSION
// =====================================================

async function createBaileysSession(sessionId, io) {

    if (sessions.has(sessionId)) {
        console.log("⚠ Session already exists:", sessionId);
        return sessions.get(sessionId);
    }

    console.log("🚀 Starting Baileys session:", sessionId);

    const sessionPath = path.join(SESSIONS_DIR, sessionId);

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: P({ level: "silent" }),
        auth: state,
        printQRInTerminal: false,
        browser: ['SaaS Engine', 'Chrome', '1.0.0'],
        markOnlineOnConnect: false,
        syncFullHistory: false
    });

    const store = makeInMemoryStore({});
    store.bind(sock.ev);
    sock.store = store;

    sessions.set(sessionId, sock);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("📱 QR generated for:", sessionId);
            io.emit("session:qr", { sessionId, qr });
        }

        if (connection === "open") {
            console.log("✅ Session connected:", sessionId);
            io.emit("session:ready", { sessionId });
        }

        if (connection === "close") {
            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

            console.log("❌ Session closed:", sessionId);

            sessions.delete(sessionId);

            if (shouldReconnect) {
                console.log("🔄 Reconnecting:", sessionId);
                setTimeout(() => {
                    createBaileysSession(sessionId, io);
                }, 3000);
            } else {
                console.log("🚪 Logged out:", sessionId);
                io.emit("session:logged_out", { sessionId });
            }
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        io.emit("session:message", {
            sessionId,
            message: msg
        });
    });

    return sock;
}

// =====================================================
// RESUME EXISTING SESSION
// =====================================================

async function resumeUserSession(userId, sessionId, io) {

    if (sessions.has(sessionId)) {
        console.log("⚠ Session already running:", sessionId);
        return;
    }

    console.log("♻ Restoring session:", sessionId);

    await createBaileysSession(sessionId, io);
}

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
    createBaileysSession,
    resumeUserSession,
    sessions
};