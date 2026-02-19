/**
 * =====================================================
 *                BAILEYS SESSION ENGINE (SaaS Ready)
 * =====================================================
 * Handles:
 *  - Multi-session management
 *  - QR generation
 *  - Reconnect logic
 *  - Status updates
 *  - Safe logout
 *  - Duplicate protection
 *  - Scalable architecture (100+ sessions)
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

// ================= SESSION MANAGEMENT =================

const sessions = new Map();        // Active sessions
const sessionLocks = new Set();    // Prevent duplicate creation

const SESSION_START_DELAY = 1500;  // Throttle reconnect/startups

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
        return sessions.get(sessionId);
    }

    if (sessionLocks.has(sessionId)) {
        console.log("⏳ Session creation already in progress:", sessionId);
        return;
    }

    sessionLocks.add(sessionId);

    console.log("🚀 Starting Baileys session:", sessionId);

    try {

        const sessionPath = path.join(SESSIONS_DIR, sessionId);
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger: P({ level: "error" }),
            auth: state,
            printQRInTerminal: false,
            browser: ['SaaS Engine', 'Chrome', '1.0.0'],
            markOnlineOnConnect: false,
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,
            generateHighQualityLinkPreview: false,
            defaultQueryTimeoutMs: 60000
        });

        const store = makeInMemoryStore({});
        store.bind(sock.ev);
        sock.store = store;

        sessions.set(sessionId, sock);
        sock.ev.setMaxListeners(0);

        sock.ev.on("creds.update", saveCreds);

        // ================= CONNECTION HANDLER =================

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

                console.log("❌ Session closed:", sessionId);

                const statusCode =
                    lastDisconnect?.error?.output?.statusCode;

                const shouldReconnect =
                    statusCode !== DisconnectReason.loggedOut;

                // CLEANUP
                sessions.delete(sessionId);

                try {
                    sock.ev.removeAllListeners();
                    sock.ws?.close?.();
                } catch (e) {}

                if (shouldReconnect) {
                    console.log("🔄 Reconnecting:", sessionId);

                    setTimeout(() => {
                        createBaileysSession(sessionId, io);
                    }, SESSION_START_DELAY);

                } else {
                    console.log("🚪 Logged out:", sessionId);
                    io.emit("session:logged_out", { sessionId });
                }
            }
        });

        // ================= MESSAGE HANDLER =================

        sock.ev.on("messages.upsert", async ({ messages, type }) => {

        if (type !== "notify") return;

        const msg = messages?.[0];
        if (!msg?.message) return;

        const remoteJid = msg.key.remoteJid;
        const fromMe = msg.key.fromMe;
        const messageId = msg.key.id;

        let messageText = "";

        if (msg.message.conversation) {
            messageText = msg.message.conversation;
        } else if (msg.message.extendedTextMessage?.text) {
            messageText = msg.message.extendedTextMessage.text;
        }

        const payload = {
            sessionId,
            messageId,
            from: remoteJid,
            fromMe,
            text: messageText,
            timestamp: msg.messageTimestamp,
            pushName: msg.pushName || null
        };

        // Real-time emit (for dashboard)
        io.emit("session:message", payload);

        // Backend webhook event
        io.emit("worker:incoming_message", payload);
    });

        return sock;

    } catch (error) {

        console.error("❌ Session creation failed:", sessionId, error);

        sessions.delete(sessionId);

    } finally {
        sessionLocks.delete(sessionId);
    }
}

// =====================================================
// RESUME EXISTING SESSION
// =====================================================

async function resumeUserSession(userId, sessionId, io) {

    if (sessions.has(sessionId)) {
        return sessions.get(sessionId);
    }

    console.log("♻ Restoring session:", sessionId);

    return createBaileysSession(sessionId, io);
}

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
    createBaileysSession,
    resumeUserSession,
    sessions
};