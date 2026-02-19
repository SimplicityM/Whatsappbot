/**
 * =====================================================
 *               WORKER.JS (BOT ENGINE - BAILEYS)
 * =====================================================
 * Responsible ONLY for:
 *  - Creating WhatsApp sessions
 *  - Restoring sessions
 *  - Resuming suspended sessions
 *  - Emitting QR / Ready / Failure events
 * =====================================================
 */

process.removeAllListeners('SIGINT');
process.removeAllListeners('SIGTERM');

require("dotenv").config();
const http = require("http");
const socketIo = require("socket.io");
const mongoose = require("mongoose");

const Session = require("./models/Session");
const User = require("./models/User");
const config = require('./config');

const {
    createBaileysSession,
    resumeUserSession,
    sessions
} = require("./baileys.js");

// ================= GLOBAL ERROR HANDLING =================

process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('🚨 Uncaught Exception:', error);
    console.error('❗ Non-fatal error caught, process will continue.');
});

// ================= CONFIG =================

const PORT = process.env.PORT || 3000;
const MAX_SESSIONS = config?.client?.MAX_SESSIONS || 100;

// ================= HTTP + SOCKET.IO SERVER =================

const server = http.createServer((req, res) => {

    if (req.url.startsWith('/socket.io/')) {
        res.writeHead(200);
        return res.end("OK");
    }

    if (req.url === "/" || req.url === "/ping") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end("OK");
    }

    res.writeHead(404);
    res.end("Not Found");
});

const io = socketIo(server, {
    cors: { origin: "*" }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🔥 WhatsApp Worker running on port ${PORT}`);
});

// ================= MONGODB CONNECTION =================

(async () => {
    try {
        if (!process.env.MONGODB_URI) {
            console.error("❌ MONGODB_URI missing");
            process.exit(1);
        }

        await mongoose.connect(process.env.MONGODB_URI, {
            serverSelectionTimeoutMS: 10000
        });

        console.log("📦 Worker connected to MongoDB");
        console.log("🧹 Baileys system ready");

    } catch (error) {
        console.error("❌ Mongo connection failed:", error);
        process.exit(1);
    }
})();

// ================= SOCKET HANDLERS =================

io.on("connection", (socket) => {

    console.log("🔌 Worker connected:", socket.id);

    // ================= HEALTH CHECK =================

    socket.on("worker:ping", (data, callback) => {
        callback?.(null, {
            status: "healthy",
            activeSessions: sessions.size,
            timestamp: Date.now()
        });
    });

    // ================= CREATE SESSION =================

    socket.on("worker:create_session", async ({ userId, sessionId }, callback) => {

        console.log("🟢 Create session:", sessionId);

        try {

            if (sessions.size >= MAX_SESSIONS) {
                return callback?.("Maximum session limit reached");
            }

            if (sessions.has(sessionId)) {
                return callback?.(null, { success: true, message: "Already running" });
            }

            await createBaileysSession(sessionId, io);

            await Session.findOneAndUpdate(
                { sessionId },
                { status: "waiting_qr", updatedAt: new Date() }
            );

            console.log(`✅ Session ${sessionId} created`);

            callback?.(null, { success: true, sessionId });

        } catch (err) {
            console.error("❌ Create session error:", err);
            callback?.(err.message || "Failed to create session");
        }
    });

    // ================= RESUME SESSION =================

    socket.on("worker:resume_session", async ({ userId, sessionId }) => {

        console.log("🟡 Resume session:", sessionId);

        try {
            if (!sessions.has(sessionId)) {
                await resumeUserSession(userId, sessionId, io);
            }

            console.log(`✅ Session resumed: ${sessionId}`);

        } catch (err) {
            console.error("❌ Resume failed:", err);
        }
    });

    // ================= STOP SESSION =================

    socket.on("worker:stop_session", async ({ sessionId }, callback) => {

        console.log("🔴 Stop session:", sessionId);

        try {
            const sock = sessions.get(sessionId);

            if (!sock) {
                return callback?.("Session not found");
            }

            await sock.logout();
            sessions.delete(sessionId);

            await Session.findOneAndUpdate(
                { sessionId },
                { status: "disconnected", updatedAt: new Date() }
            );

            console.log(`🛑 Session stopped: ${sessionId}`);

            callback?.(null, { success: true });

        } catch (err) {
            console.error("❌ Stop error:", err);
            callback?.(err.message);
        }
    });

    // ================= DELETE SESSION =================

    socket.on("worker:delete_session", async ({ sessionId }, callback) => {

        console.log("🗑 Delete session:", sessionId);

        try {
            const sock = sessions.get(sessionId);

            if (sock) {
                await sock.logout();
                sessions.delete(sessionId);
            }

            await Session.deleteOne({ sessionId });

            console.log(`🗑 Session deleted: ${sessionId}`);

            callback?.(null, { success: true });

        } catch (err) {
            console.error("❌ Delete error:", err);
            callback?.(err.message);
        }
    });

    // ================= SEND MESSAGE (NEW API) =================

    socket.on("worker:send_message", async ({ sessionId, to, message }, callback) => {

        try {
            const sock = sessions.get(sessionId);

            if (!sock) {
                return callback?.("Session not connected");
            }

            const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;

            await sock.sendMessage(jid, { text: message });

            console.log(`📨 Message sent from ${sessionId} to ${jid}`);

            callback?.(null, { success: true });

        } catch (err) {
            console.error("❌ Send message error:", err);
            callback?.(err.message);
        }
    });

    // ================= BROADCAST =================

    socket.on("worker:send_broadcast", async ({ sessionId, message }, callback) => {

        try {
            const sock = sessions.get(sessionId);

            if (!sock) {
                return callback?.("Session not connected");
            }

            const jid = sock.user?.id?.split(':')[0] + "@s.whatsapp.net";

            await sock.sendMessage(jid, { text: message });

            console.log(`📢 Broadcast sent from ${sessionId}`);

            callback?.(null, { success: true });

        } catch (err) {
            console.error("❌ Broadcast error:", err);
            callback?.(err.message);
        }
    });

    // ================= CONTACT SYNC =================

    socket.on("worker:sync_contacts", async ({ sessionId }, callback) => {

        try {
            const sock = sessions.get(sessionId);

            if (!sock) {
                return callback?.("Session not connected");
            }

            const contacts = Object.values(sock.store?.contacts || {});
            const filtered = contacts.filter(c =>
                c.id && c.id.endsWith("@s.whatsapp.net")
            );

            callback?.(null, {
                success: true,
                total: filtered.length,
                timestamp: new Date()
            });

        } catch (err) {
            console.error("❌ Contact sync error:", err);
            callback?.(err.message);
        }
    });

});