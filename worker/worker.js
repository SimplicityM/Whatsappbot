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
const User = require("./models/User");
const config = require('./config');
const {
    createBotSession,
    restoreAllSessions,
    resumeUserSession,
    clients
} = require("./bot.js");

// Configuration
const PORT = process.env.PORT || 5001;
const MAX_SESSIONS = config.client.MAX_SESSIONS;

/* =====================================================
   WORKER SOCKET.IO SERVER
   ===================================================== */
const server = http.createServer((req, res) => {
    // Skip Socket.IO requests - let Socket.IO handle them
    if (req.url.startsWith('/socket.io/')) {
        return;
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

        // Add this logging to verify mounted disk
        const fs = require('fs');
        const path = require('path');
        const authPath = path.resolve('/app/.wwebjs_auth');
        
        console.log(`📁 Auth path: ${authPath}`);
        console.log(`📁 Auth path exists: ${fs.existsSync(authPath)}`);
        
        if (fs.existsSync(authPath)) {
            const stats = fs.statSync(authPath);
            console.log(`📁 Auth path is directory: ${stats.isDirectory()}`);
            console.log(`📁 Auth path permissions: ${stats.mode.toString(8)}`);
            
            // List contents to verify it's writable
            try {
                const files = fs.readdirSync(authPath);
                console.log(`📁 Auth path contents (${files.length} items):`, files.slice(0, 5));
            } catch (err) {
                console.error(`❌ Cannot read auth path:`, err.message);
            }
        } else {
            console.log(`⚠️ Auth path does not exist - it will be created on first session`);
        }

        // Restore all sessions and capture stats
        console.log("♻ Restoring existing WhatsApp sessions...");
        const startTime = Date.now();
        
        let restorationStats = null;
        
        try {
            restorationStats = await restoreAllSessions(io);
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            console.log(`✅ Session restoration completed in ${duration}s`);
            
            if (restorationStats) {
                console.log(`📊 Final Stats: ${JSON.stringify(restorationStats.progress)}`);
            }
        } catch (error) {
            console.error("❌ Session restoration failed:", error);
        }

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
            await createBotSession(userId, sessionId, io);

            await Session.findOneAndUpdate(
                { sessionId },
                { status: "waiting_qr", updatedAt: new Date() }
            );

            console.log(`✅ Worker: session ${sessionId} created`);
            
            // Send acknowledgment
            if (typeof callback === 'function') {
                callback(null, { success: true, sessionId });
            }
        } catch (err) {
            console.error("❌ Worker create session error:", err);
            
            // Send error acknowledgment
            if (typeof callback === 'function') {
                callback(err.message, null);
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

    /** =========================================
     *  SEND BROADCAST MESSAGE
     * ========================================= */
    socket.on('worker:send_broadcast', async ({ sessionId, message, userId }, callback) => {
        try {
            console.log(`📢 WORKER: Sending broadcast to session ${sessionId}`);
            
            // Get the client for this session
            const clientData = clients.get(sessionId);
            
            if (!clientData || !clientData.client) {
                return callback('Session not found or not connected');
            }

            const client = clientData.client;
            
            // Get the user's own WhatsApp number to send to themselves
            const info = client.info;
            if (!info || !info.wid) {
                return callback('Could not get user WhatsApp info');
            }

            // Send message to user's own number
            const userJid = info.wid._serialized;
            await client.sendMessage(userJid, message);
            
            console.log(`✅ WORKER: Broadcast sent to ${sessionId}`);
            callback(null, { success: true, sessionId });
            
        } catch (error) {
            console.error(`❌ WORKER: Broadcast error for ${sessionId}:`, error);
            callback(error.message || 'Failed to send broadcast');
        }
    });

    /** =========================================
 *  SYNC CONTACTS MANUALLY
 * ========================================= */
socket.on('worker:sync_contacts', async ({ sessionId, userId }, callback) => {
    console.log(`📇 WORKER: Manual contact sync requested for ${sessionId}`);
    
    try {
        const clientData = clients.get(sessionId);
        
        if (!clientData || !clientData.client) {
            return callback('Session not found or not connected');
        }

        const client = clientData.client;
        
        // Get all contacts
        const contacts = await client.getContacts();
        
        console.log(`✅ WORKER: Retrieved ${contacts.length} contacts for ${sessionId}`);
        
        // You can save to database here if needed
        // await Contact.insertMany(...)
        
        callback(null, {
            success: true,
            total: contacts.length,
            synced: contacts.length,
            timestamp: new Date()
        });
        
        } catch (error) {
        console.error(`❌ WORKER: Contact sync error for ${sessionId}:`, error);
        callback(error.message || 'Failed to sync contacts');
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