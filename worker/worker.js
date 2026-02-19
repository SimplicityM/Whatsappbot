/**
 * =====================================================
 *        TAGTHEMALL WORKER (FULL ENTERPRISE VERSION)
 * =====================================================
 */

require("dotenv").config();
const http = require("http");
const socketIo = require("socket.io");
const mongoose = require("mongoose");
const Redis = require("ioredis");
const { createLogger, format, transports } = require("winston");
const client = require("prom-client");

const Session = require("./models/Session");
const User = require("./models/User");
const config = require("./config");

const {
    createBaileysSession,
    resumeUserSession,
    sessions
} = require("./baileys.js");

/* =====================================================
   CONFIG
===================================================== */

const PORT = process.env.PORT || 3000;
const MAX_SESSIONS = config?.client?.MAX_SESSIONS || 100;

const MIN_DELAY_MS = 1500;
const MAX_PER_MINUTE = 20;
const MAX_PER_HOUR = 200;
const localRateState = new Map();

/* =====================================================
   LOGGER
===================================================== */

const logger = createLogger({
    format: format.combine(
        format.timestamp(),
        format.errors({ stack: true }),
        format.json()
    ),
    transports: [
        new transports.Console(),
        new transports.File({ filename: "logs/error.log", level: "error" }),
        new transports.File({ filename: "logs/combined.log" })
    ]
});

/* =====================================================
   REDIS
===================================================== */

const redisEnabled = config?.redis?.ENABLED !== false;
const redisUrl = config?.redis?.URL || process.env.REDIS_URL || "redis://127.0.0.1:6379";
const redis = redisEnabled
    ? new Redis(redisUrl, {
        lazyConnect: true,
        connectTimeout: config?.redis?.CONNECT_TIMEOUT_MS || 10000,
        maxRetriesPerRequest: 1,
        retryStrategy: times => Math.min(times * 2000, 15000)
    })
    : null;
let redisReady = false;

if (redis) {
    redis.on("connect", () => {
        redisReady = true;
        logger.info("Redis connected", { redisUrl });
    });
    redis.on("error", err => logger.error("Redis error", { err, redisUrl }));
    redis.on("close", () => {
        redisReady = false;
        logger.warn("Redis connection closed; using local rate-limit fallback");
    });
    redis.on("end", () => {
        redisReady = false;
    });

    redis.connect().catch(err => {
        redisReady = false;
        logger.warn("Redis initial connect failed; using local rate-limit fallback", { err: err?.message || err });
    });
} else {
    logger.warn("Redis disabled via REDIS_ENABLED=false; using local rate-limit fallback only");
}

/* =====================================================
   PROMETHEUS METRICS
===================================================== */

client.collectDefaultMetrics();

const messagesSentCounter = new client.Counter({
    name: "tagthemall_messages_sent_total",
    help: "Total messages sent"
});

const activeSessionsGauge = new client.Gauge({
    name: "tagthemall_active_sessions",
    help: "Number of active sessions"
});

/* =====================================================
   GRACEFUL SHUTDOWN
===================================================== */

async function gracefulShutdown() {
    logger.info("Graceful shutdown started");

    for (const [sessionId, sock] of sessions.entries()) {
        try {
            await sock.logout();
        } catch (err) {
            logger.error("Logout error", { sessionId, err });
        }
    }

    await mongoose.connection.close();
    if (redis) {
        try {
            await redis.quit();
        } catch {}
    }

    process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

/* =====================================================
   HTTP SERVER
===================================================== */

const server = http.createServer(async (req, res) => {

    if (req.url === "/metrics") {
        res.setHeader("Content-Type", client.register.contentType);
        return res.end(await client.register.metrics());
    }

    if (req.url === "/health") {
        return res.end(JSON.stringify({
            status: "healthy",
            sessions: sessions.size,
            uptime: process.uptime(),
            timestamp: Date.now()
        }));
    }

    if (req.url === "/" || req.url === "/ping") {
        return res.end("OK");
    }

    res.writeHead(404);
    res.end();
});

const io = socketIo(server, { cors: { origin: "*" } });

server.listen(PORT, "0.0.0.0", () => {
    logger.info(`Worker running on port ${PORT}`);
});

/* =====================================================
   MONGODB
===================================================== */

(async () => {
    if (!process.env.MONGODB_URI) {
        logger.error("Missing MONGODB_URI");
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 10000
    });

    logger.info("MongoDB connected");
})();

/* =====================================================
   REDIS DISTRIBUTED RATE LIMIT
===================================================== */

async function checkRateLimit(sessionId) {
    if (!redisReady) {
        const now = Date.now();
        const key = String(sessionId);
        const entry = localRateState.get(key) || {
            minuteStart: now,
            hourStart: now,
            minuteCount: 0,
            hourCount: 0
        };

        if (now - entry.minuteStart >= 60000) {
            entry.minuteStart = now;
            entry.minuteCount = 0;
        }
        if (now - entry.hourStart >= 3600000) {
            entry.hourStart = now;
            entry.hourCount = 0;
        }

        entry.minuteCount += 1;
        entry.hourCount += 1;
        localRateState.set(key, entry);

        if (entry.minuteCount > MAX_PER_MINUTE)
            return "Rate limit exceeded (minute)";

        if (entry.hourCount > MAX_PER_HOUR)
            return "Rate limit exceeded (hour)";

        return null;
    }

    const minuteKey = `rate:${sessionId}:minute`;
    const hourKey = `rate:${sessionId}:hour`;

    let minuteCount;
    let hourCount;
    try {
        minuteCount = await redis.incr(minuteKey);
        if (minuteCount === 1) await redis.expire(minuteKey, 60);

        hourCount = await redis.incr(hourKey);
        if (hourCount === 1) await redis.expire(hourKey, 3600);
    } catch {
        redisReady = false;
        return checkRateLimit(sessionId);
    }

    if (minuteCount > MAX_PER_MINUTE)
        return "Rate limit exceeded (minute)";

    if (hourCount > MAX_PER_HOUR)
        return "Rate limit exceeded (hour)";

    return null;
}

/* =====================================================
   MESSAGE QUEUE (SAFE CHAIN)
===================================================== */

const messageQueues = new Map();

function enqueueMessage(sessionId, task) {
    if (!messageQueues.has(sessionId))
        messageQueues.set(sessionId, Promise.resolve());

    const queue = messageQueues.get(sessionId);

    messageQueues.set(
        sessionId,
        queue
            .then(task)
            .catch(err => {
                logger.error("Queue error", { err });
                return Promise.resolve();
            })
    );
}

/* =====================================================
   SOCKET EVENTS
===================================================== */

io.on("connection", (socket) => {

    logger.info("Socket connected", { socketId: socket.id });

    /* ===== HEALTH CHECK ===== */

    socket.on("worker:ping", (data, callback) => {
        callback?.(null, {
            status: "healthy",
            activeSessions: sessions.size,
            timestamp: Date.now()
        });
    });

    /* ===== CREATE SESSION ===== */

    socket.on("worker:create_session", async ({ userId, sessionId }, callback) => {
        try {

            if (sessions.size >= MAX_SESSIONS)
                return callback?.("Maximum session limit reached");

            if (!sessions.has(sessionId))
                await createBaileysSession(sessionId, io);

            activeSessionsGauge.set(sessions.size);

            await Session.findOneAndUpdate(
                { sessionId },
                { status: "waiting_qr", updatedAt: new Date() }
            );

            callback?.(null, { success: true });

        } catch (err) {
            logger.error("Create session error", { err });
            callback?.(err.message);
        }
    });

    /* ===== RESUME SESSION ===== */

    socket.on("worker:resume_session", async ({ userId, sessionId }) => {
        try {
            if (!sessions.has(sessionId))
                await resumeUserSession(userId, sessionId, io);
        } catch (err) {
            logger.error("Resume error", { err });
        }
    });

    /* ===== STOP SESSION ===== */

    socket.on("worker:stop_session", async ({ sessionId }, callback) => {
        try {

            const sock = sessions.get(sessionId);
            if (!sock) return callback?.("Session not found");

            await sock.logout();
            sessions.delete(sessionId);
            messageQueues.delete(sessionId);

            await Session.findOneAndUpdate(
                { sessionId },
                { status: "disconnected", updatedAt: new Date() }
            );

            activeSessionsGauge.set(sessions.size);

            callback?.(null, { success: true });

        } catch (err) {
            logger.error("Stop session error", { err });
            callback?.(err.message);
        }
    });

    /* ===== DELETE SESSION ===== */

    socket.on("worker:delete_session", async ({ sessionId }, callback) => {
        try {

            const sock = sessions.get(sessionId);
            if (sock) await sock.logout();

            sessions.delete(sessionId);
            messageQueues.delete(sessionId);

            await Session.deleteOne({ sessionId });

            callback?.(null, { success: true });

        } catch (err) {
            logger.error("Delete session error", { err });
            callback?.(err.message);
        }
    });

    /* ===== SEND MESSAGE ===== */

    socket.on("worker:send_message", async (data, callback) => {

        try {
            const { sessionId, to, type = "text", message, mediaUrl, fileName } = data;

            const sock = sessions.get(sessionId);
            if (!sock) return callback?.("Session not connected");

            const rateError = await checkRateLimit(sessionId);
            if (rateError) return callback?.(rateError);

            const sessionRecord = await Session.findOne({ sessionId }).populate("userId");
            if (!sessionRecord || !sessionRecord.userId)
                return callback?.("User not found");

            const user = sessionRecord.userId;

            if (!(await user.canSendMessage())) {
                if (!user.isSubscriptionActive())
                    return callback?.("Subscription expired");
                return callback?.("Monthly quota exceeded");
            }

            const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;

            enqueueMessage(sessionId, async () => {

                let payload = {};

                switch (type) {
                    case "text":
                        payload = { text: message };
                        break;
                    case "image":
                        payload = { image: { url: mediaUrl }, caption: message || "" };
                        break;
                    case "video":
                        payload = { video: { url: mediaUrl }, caption: message || "" };
                        break;
                    case "audio":
                        payload = { audio: { url: mediaUrl }, mimetype: "audio/mp4" };
                        break;
                    case "voice":
                        payload = { audio: { url: mediaUrl }, mimetype: "audio/mp4", ptt: true };
                        break;
                    case "document":
                        payload = {
                            document: { url: mediaUrl },
                            fileName: fileName || "file",
                            mimetype: "application/pdf"
                        };
                        break;
                    default:
                        throw new Error("Unsupported message type");
                }

                await sock.sendMessage(jid, payload);
                await user.incrementMessageUsage();
                messagesSentCounter.inc();

                logger.info("Message sent", { sessionId, type });

                await new Promise(res => setTimeout(res, MIN_DELAY_MS));
            });

            callback?.(null, { success: true });

        } catch (err) {
            logger.error("Send message error", { err });
            callback?.(err.message);
        }
    });

    /* ===== BROADCAST ===== */

    socket.on("worker:send_broadcast", async ({ sessionId, message }, callback) => {
        try {
            const sock = sessions.get(sessionId);
            if (!sock) return callback?.("Session not connected");

            const jid = sock.user?.id?.split(":")[0] + "@s.whatsapp.net";

            await sock.sendMessage(jid, { text: message });

            callback?.(null, { success: true });

        } catch (err) {
            logger.error("Broadcast error", { err });
            callback?.(err.message);
        }
    });

});
