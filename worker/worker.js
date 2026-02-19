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
process.removeAllListeners('SIGINT');
process.removeAllListeners('SIGTERM');

require("dotenv").config();
const http = require("http");
const socketIo = require("socket.io");
const mongoose = require("mongoose");

const Session = require("./models/Session");
const User = require("./models/User");
const config = require('./config');

const clients = new Map();

const {
    createBaileysSession,
    sendMessage,
    sessions
} = require("./baileys.js");
   const fs = require('fs');
            const path = require('path');
            const SessionAuth = require('./models/SessionAuth');
            

// Add near the top of worker.js, after imports
process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't crash the process for file errors during session restore
  if (reason?.code === 'ENOENT' && reason?.path?.includes('RemoteAuth')) {
    console.error('⚠️ Session restore file error - continuing operation');
  }
});

process.on('uncaughtException', (error) => {
  try {
    console.error('🚨 Uncaught Exception:', error);

    // ✅ Ignore missing RemoteAuth zip file errors
    if (
      error?.code === 'ENOENT' &&
      typeof error?.path === 'string' &&
      error.path.includes('RemoteAuth')
    ) {
      console.warn('⚠️ Missing RemoteAuth zip file - skipping (non-fatal)');
      return;
    }

    // ✅ Ignore Puppeteer protocol timeout errors (very common on VPS)
    if (
      error?.message &&
      error.message.includes('Runtime.callFunctionOn timed out')
    ) {
      console.warn('⚠️ Puppeteer protocol timeout - ignoring');
      return;
    }

    // ✅ Ignore whatsapp-web.js Channel patch errors
    if (
      error?.message &&
      error.message.includes("Cannot read properties of undefined (reading 'description')")
    ) {
      console.warn('⚠️ Channel patch error - ignoring');
      return;
    }

    // ❌ DO NOT exit process in production
    console.error('❗ Non-fatal error caught, process will continue.');

  } catch (handlerError) {
    console.error('🔥 Error inside uncaughtException handler:', handlerError);
  }
});

// Configuration
const PORT = process.env.PORT || 3000;
const MAX_SESSIONS = config.client.MAX_SESSIONS;

/* =====================================================
   WORKER SOCKET.IO SERVER
   ===================================================== */
const server = http.createServer((req, res) => {
    // Skip Socket.IO requests - let Socket.IO handle them
    if (req.url.startsWith('/socket.io/')) {
        res.writeHead(200);
        return res.end("OK");
        }

    
    console.log(`📥 HTTP Request: ${req.method} ${req.url}`);
    
    // Health check endpoint
    if (req.url === "/ping" || req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end("OK");
    }
    
    // Handle other requests
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
});

const io = socketIo(server, {
    cors: {
        origin: "*"
    }
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🔥 WhatsApp Worker running on port ${PORT}`);
});

(async () => {
    try {
        const mongoURI = process.env.MONGODB_URI;

        if (!mongoURI) {
            console.error("❌ MONGODB_URI missing");
            process.exit(1);
        }

        await mongoose.connect(mongoURI, {
            serverSelectionTimeoutMS: 10000
        });

        console.log("📦 Worker connected to MongoDB");
        console.log("🧹 Baileys system ready");

    } catch (error) {
        console.error("❌ Mongo connection failed:", error);
        process.exit(1);
    }
})();

/* =====================================================
   WORKER JOB HANDLERS
   ===================================================== */
io.on("connection", (socket) => {
    console.log("🔌 Worker connected to server:", socket.id);

    // Health check ping handler
    socket.on("worker:ping", (data, callback) => {
        if (typeof callback === 'function') {
            callback(null, { 
                status: 'healthy', 
                activeSessions: clients.size,
                timestamp: Date.now() 
            });
        }
    });

    /** =========================================
     *  CREATE NEW SESSION
     *  From server: io.emit("worker:create_session", {...})
     * ========================================= */

    socket.on("worker:create_session", async ({ userId, sessionId }, callback) => {
    console.log("🟢 Worker: create session request:", sessionId);

    try {
        // Create Baileys session
        await createBaileysSession(sessionId, io);

        // Update database status
        await Session.findOneAndUpdate(
            { sessionId },
            { 
                status: "waiting_qr",
                updatedAt: new Date()
            }
        );

        console.log(`✅ Worker: session ${sessionId} created`);

        if (typeof callback === "function") {
            callback(null, { success: true, sessionId });
        }

    } catch (err) {
        console.error("❌ Worker create session error:", err);

        if (typeof callback === "function") {
            callback(err.message || "Failed to create session", null);
        }
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
        const sock = sessions.get(sessionId);

        if (!sock) {
            console.log("⚠ No active Baileys session for", sessionId);
            return;
        }

        // Close WebSocket connection
        sock.ws.close();

        // Remove from memory
        sessions.delete(sessionId);

        // Update database
        await Session.findOneAndUpdate(
            { sessionId },
            { 
                status: "disconnected",
                updatedAt: new Date()
            }
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
        const sock = sessions.get(sessionId);

        if (sock) {
            sock.ws.close();
            sessions.delete(sessionId);
        }

        await Session.deleteOne({ sessionId });

        console.log(`🗑 Session ${sessionId} removed`);

    } catch (err) {
        console.error("❌ Worker delete error:", err);
    }
    });

    /** =========================================
     *  SEND BROADCAST MESSAGE
     * ========================================= */
    socket.on('worker:send_broadcast', async ({ sessionId, message }, callback) => {
    try {
        console.log(`📢 WORKER: Sending broadcast to ${sessionId}`);

        const sock = sessions.get(sessionId);

        if (!sock) {
            return callback("Session not connected");
        }

        // send to yourself (example)
        const jid = sock.user.id;

        await sock.sendMessage(jid, { text: message });

        console.log(`✅ Broadcast sent for ${sessionId}`);

        callback(null, { success: true });

    } catch (error) {
        console.error("❌ Broadcast error:", error);
        callback(error.message);
    }
    });

    /** =========================================
 *  SYNC CONTACTS MANUALLY
 * ========================================= */
    socket.on('worker:sync_contacts', async ({ sessionId }, callback) => {
    console.log(`📇 WORKER: Contact sync requested for ${sessionId}`);

    try {
        const sock = sessions.get(sessionId);

        if (!sock) {
            return callback("Session not connected");
        }

        const contacts = Object.values(sock.store?.contacts || {});

        console.log(`📦 Found ${contacts.length} contacts`);

        // Example: filter only real users (not groups)
        const filtered = contacts.filter(c => 
            c.id && c.id.endsWith('@s.whatsapp.net')
        );

        console.log(`👤 ${filtered.length} user contacts after filtering`);

        callback(null, {
            success: true,
            total: filtered.length,
            timestamp: new Date()
        });

    } catch (error) {
        console.error("❌ Contact sync error:", error);
        callback(error.message);
    }
    });

})

