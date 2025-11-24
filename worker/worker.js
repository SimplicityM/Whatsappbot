/**
 * =====================================================
 *               WORKER.JS (BOT ENGINE)
 * =====================================================
 * This worker runs independently from server.js.
 * It is responsible ONLY for:
 *  - Creating WhatsApp sessions
 *  - Restoring sessions
 *  - Resuming suspended sessions
 *  - Emitting QR / Ready / Failure events
 *  - Keeping Puppeteer running forever
 * =====================================================
 */

require("dotenv").config();
const http = require("http");
const socketIo = require("socket.io");
const mongoose = require("mongoose");

const Session = require("./models/Session");
const User = require("./models/user");
const {
    createBotSession,
    restoreAllSessions,
    resumeUserSession,
    clients
} = require("./bot.js");

/* =====================================================
   WORKER SOCKET.IO SERVER
   ===================================================== */
const server = http.createServer();
const io = socketIo(server, {
    cors: {
        origin: "*"
    }
});

/* =====================================================
   KEEP-ALIVE / HEALTH CHECK ENDPOINT
   ===================================================== */
server.on("request", (req, res) => {
    if (req.url === "/ping") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end("OK");
    }
});


const PORT = process.env.PORT || 5001;

server.listen(PORT, () => {
    console.log(`🔥 WhatsApp Worker running on port ${PORT}`);
});

/* =====================================================
   CONNECT TO DATABASE
   ===================================================== */
(async () => {
    const mongoURI = process.env.MONGODB_URI;

    if (!mongoURI) {
        console.error("❌ MONGODB_URI missing");
        process.exit(1);
    }

    try {
        await mongoose.connect(mongoURI);
        console.log("📦 Worker connected to MongoDB");

        // Restore all sessions
        console.log("♻ Restoring existing WhatsApp sessions...");
        restoreAllSessions(io);
    } catch (error) {
        console.error("❌ Worker DB connection failed:", error);
        process.exit(1);
    }
})();

/* =====================================================
   WORKER JOB HANDLERS
   ===================================================== */
io.on("connection", (socket) => {
    console.log("🔌 Worker connected to server:", socket.id);

    /** =========================================
     *  CREATE NEW SESSION
     *  From server: io.emit("worker:create_session", {...})
     * ========================================= */
    socket.on("worker:create_session", async ({ userId, sessionId }) => {
        console.log("🟢 Worker: create session request:", sessionId);

        try {
            await createBotSession(userId, sessionId, io);

            await Session.findOneAndUpdate(
                { sessionId },
                { status: "waiting_qr", updatedAt: new Date() }
            );

            console.log(`✅ Worker: session ${sessionId} created`);
        } catch (err) {
            console.error("❌ Worker create session error:", err);
        }
    });

    /** =========================================
     *  RESUME SUSPENDED SESSION
     *  From payment webhook
     * ========================================= */
    socket.on("worker:resume_session", async ({ userId, sessionId }) => {
        console.log("🟡 Worker: resume request for", sessionId);

        try {
            await resumeUserSession(userId, sessionId, io);

            console.log(`✅ Worker: resumed ${sessionId}`);
        } catch (err) {
            console.error("❌ Worker resume failed:", err);
        }
    });

    /** =========================================
     *  STOP A RUNNING SESSION
     * ========================================= */
    socket.on("worker:stop_session", async ({ sessionId }) => {
        console.log("🔴 Worker: stop session:", sessionId);

        try {
            const data = clients.get(sessionId);
            if (!data || !data.client) {
                console.log("⚠ No active client for", sessionId);
                return;
            }

            await data.client.destroy();
            clients.delete(sessionId);

            await Session.findOneAndUpdate(
                { sessionId },
                { status: "disconnected", updatedAt: new Date() }
            );

            console.log(`🛑 Worker stopped session: ${sessionId}`);
        } catch (err) {
            console.error("❌ Worker stop session error:", err);
        }
    });

    /** =========================================
     *  DELETE SESSION COMPLETELY
     * ========================================= */
    socket.on("worker:delete_session", async ({ sessionId }) => {
        console.log("🗑 Worker: delete session:", sessionId);

        try {
            const data = clients.get(sessionId);
            if (data && data.client) {
                await data.client.destroy();
                clients.delete(sessionId);
            }

            await Session.deleteOne({ sessionId });

            console.log(`🗑 Session ${sessionId} removed`);
        } catch (err) {
            console.error("❌ Worker delete error:", err);
        }
    });
});

/* =====================================================
   GRACEFUL SHUTDOWN
   ===================================================== */
process.on("SIGINT", async () => {
    console.log("⚠ Worker shutting down...");

    for (const [sessionId, data] of clients) {
        try {
            await data.client.destroy();
        } catch (err) {
            console.error(`Error destroying ${sessionId}:`, err);
        }
    }

    await mongoose.connection.close();
    process.exit(0);
});
