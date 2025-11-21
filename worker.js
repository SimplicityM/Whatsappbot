// worker.js
console.log("🚀 WhatsApp Bot Worker starting...");

require("dotenv").config();
const http = require("http");

// Create bare HTTP server for socket.io
const server = http.createServer();

// Start socket.io on worker
const io = require("socket.io")(server, {
    cors: { origin: "*" }
});

// Expose io for bot.js to use
global.workerIO = io;

// Start listening on port 5001 (worker socket)
server.listen(5001, () => {
    console.log("🔥 Worker Socket.IO running on port 5001");
});

// Load bot engine
const {
    restoreAllSessions,
    createBotSession
} = require("./bot.js");

// Restore WhatsApp sessions when worker boots
(async () => {
    console.log("♻ Restoring all WhatsApp sessions...");
    await restoreAllSessions(io);
    console.log("✅ Sessions restored. Worker is fully running.");
})();
