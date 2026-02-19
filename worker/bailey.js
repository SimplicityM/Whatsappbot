/**
 * =====================================================
 *        BAILEYS SESSION ENGINE (FULL ENTERPRISE)
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

const GroupSettings = require("./models/GroupSettings");

// ================= SESSION MANAGEMENT =================

const sessions = new Map();
const sessionLocks = new Set();
const groupMetadataCache = new Map();

const SESSION_START_DELAY = 1500;
const GROUP_CACHE_TTL = 5 * 60 * 1000;

const SESSIONS_DIR = path.join(__dirname, "sessions");
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR);
}

/* =====================================================
   CLEAN GROUP CACHE PERIODICALLY
===================================================== */

setInterval(() => {
    const now = Date.now();
    for (const [groupId, data] of groupMetadataCache.entries()) {
        if (now - data.timestamp > GROUP_CACHE_TTL) {
            groupMetadataCache.delete(groupId);
        }
    }
}, 60 * 1000);

/* =====================================================
   GROUP ADMIN HELPER (CACHED)
===================================================== */

async function getGroupAdmins(sock, groupId) {
    const cached = groupMetadataCache.get(groupId);

    if (cached && Date.now() - cached.timestamp < GROUP_CACHE_TTL) {
        return cached.admins;
    }

    const metadata = await sock.groupMetadata(groupId);

    const admins = metadata.participants
        .filter(p => p.admin !== null)
        .map(p => p.id);

    groupMetadataCache.set(groupId, {
        admins,
        timestamp: Date.now()
    });

    return admins;
}

/* =====================================================
   CREATE SESSION
===================================================== */

async function createBaileysSession(sessionId, io) {

    if (sessions.has(sessionId)) return sessions.get(sessionId);
    if (sessionLocks.has(sessionId)) return;

    sessionLocks.add(sessionId);
    console.log("🚀 Starting session:", sessionId);

    try {

        const sessionPath = path.join(SESSIONS_DIR, sessionId);
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger: P({ level: "error" }),
            auth: state,
            printQRInTerminal: false,
            browser: ['TagThemAll Engine', 'Chrome', '1.0.0'],
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

        /* =====================================================
           CONNECTION HANDLER
        ===================================================== */

        sock.ev.on("connection.update", async (update) => {

            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                io.emit("session:qr", { sessionId, qr });
            }

            if (connection === "open") {
                console.log("✅ Connected:", sessionId);
                io.emit("session:ready", { sessionId });
            }

            if (connection === "close") {

                const statusCode =
                    lastDisconnect?.error?.output?.statusCode;

                const shouldReconnect =
                    statusCode !== DisconnectReason.loggedOut;

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
                    io.emit("session:logged_out", { sessionId });
                }
            }
        });

        /* =====================================================
           CALL HANDLER
        ===================================================== */

        sock.ev.on("call", async () => {
            console.log("📞 Call event:", sessionId);
        });

        /* =====================================================
           ANTI-DELETE HANDLER
        ===================================================== */

        sock.ev.on("messages.update", async updates => {
            for (const update of updates) {
                if (update.update?.message === null) {

                    const groupId = update.key.remoteJid;
                    if (!groupId?.endsWith("@g.us")) continue;

                    const settings =
                        await GroupSettings.findOne({ groupId });

                    if (settings?.antiDelete) {
                        await sock.sendMessage(groupId, {
                            text: "🚨 A message was deleted."
                        });
                    }
                }
            }
        });

        /* =====================================================
           WELCOME / GOODBYE HANDLER
        ===================================================== */

        sock.ev.on("group-participants.update", async update => {

            const settings =
                await GroupSettings.findOne({ groupId: update.id });

            if (!settings?.welcome) return;

            if (update.action === "add") {
                await sock.sendMessage(update.id, {
                    text: "👋 Welcome to the group!"
                });
            }

            if (update.action === "remove") {
                await sock.sendMessage(update.id, {
                    text: "👋 A member left the group."
                });
            }
        });

        /* =====================================================
           MESSAGE HANDLER
        ===================================================== */

        const botEngine = require("./botEngine");

        sock.ev.on("messages.upsert", async ({ messages, type }) => {

            if (type !== "notify") return;

            const msg = messages?.[0];
            if (!msg?.message) return;
            if (msg.key.fromMe) return;

            try {

                const from = msg.key.remoteJid;
                const sender = msg.key.participant || from;
                const isGroup = from.endsWith("@g.us");

                let isAdmin = false;

                if (isGroup) {
                    const admins = await getGroupAdmins(sock, from);
                    isAdmin = admins.includes(sender);
                }

                await botEngine({
                    sock,
                    msg,
                    sessionId,
                    isGroup,
                    isAdmin,
                    sender,
                    from
                });

            } catch (err) {
                console.error("❌ Bot engine error:", err);
            }

        });

        return sock;

    } catch (error) {

        console.error("❌ Session creation failed:", sessionId, error);
        sessions.delete(sessionId);

    } finally {
        sessionLocks.delete(sessionId);
    }
}

/* =====================================================
   RESUME SESSION
===================================================== */

async function resumeUserSession(userId, sessionId, io) {
    if (sessions.has(sessionId))
        return sessions.get(sessionId);

    console.log("♻ Restoring session:", sessionId);
    return createBaileysSession(sessionId, io);
}

/* =====================================================
   EXPORTS
===================================================== */

module.exports = {
    createBaileysSession,
    resumeUserSession,
    sessions
};