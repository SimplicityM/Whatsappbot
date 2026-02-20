/**
 * Baileys session engine
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
const Session = require("./models/Session");
const User = require("./models/User");
const BlacklistedNumber = require("./models/BlacklistedNumber");
const botEngine = require("./botEngine");

const sessions = new Map();
const sessionLocks = new Set();
const groupMetadataCache = new Map();
const sessionSchedulers = new Map();
const sessionInitOptions = new Map();

const SESSION_START_DELAY = 1500;
const GROUP_CACHE_TTL = 5 * 60 * 1000;
const SESSIONS_DIR = path.join(__dirname, "sessions");

if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

setInterval(() => {
    const now = Date.now();
    for (const [groupId, data] of groupMetadataCache.entries()) {
        if (now - data.timestamp > GROUP_CACHE_TTL) {
            groupMetadataCache.delete(groupId);
        }
    }
}, 60 * 1000);

async function getGroupAdmins(sock, groupId) {
    const cached = groupMetadataCache.get(groupId);
    if (cached && Date.now() - cached.timestamp < GROUP_CACHE_TTL) {
        return cached.admins;
    }

    const metadata = await sock.groupMetadata(groupId);
    const admins = (metadata.participants || [])
        .filter(p => p.admin !== null)
        .map(p => p.id);

    groupMetadataCache.set(groupId, {
        admins,
        timestamp: Date.now()
    });

    return admins;
}

function startScheduler(sessionId, sock) {
    if (sessionSchedulers.has(sessionId)) {
        return;
    }

    const intervalId = setInterval(async () => {
        try {
            await botEngine.runScheduledJobs({ sock, sessionId });
        } catch {}
    }, 30 * 1000);

    sessionSchedulers.set(sessionId, intervalId);

    setTimeout(async () => {
        try {
            await botEngine.runScheduledJobs({ sock, sessionId });
        } catch {}
    }, 3000);
}

function stopScheduler(sessionId) {
    const intervalId = sessionSchedulers.get(sessionId);
    if (intervalId) {
        clearInterval(intervalId);
        sessionSchedulers.delete(sessionId);
    }
}

function extractUserId(sessionId) {
    const m = String(sessionId || "").match(/^session-([^-]+)/);
    return m ? m[1] : null;
}

function normalizeJid(j) {
    if (!j) return "";
    const [left, right] = String(j).split("@");
    if (!left || !right) return String(j);
    return `${left.split(":")[0]}@${right}`;
}

async function requestPairingCodeWithRetry(sock, sessionId, io, phoneNumber) {
    const digits = String(phoneNumber || "").replace(/[^0-9]/g, "");
    if (!digits || typeof sock.requestPairingCode !== "function") return;

    for (let i = 0; i < 8; i++) {
        try {
            const code = await sock.requestPairingCode(digits);
            if (!code) throw new Error("Empty pairing code");
            const userId = extractUserId(sessionId);
            const payload = { sessionId, code, phoneNumber: digits, userId };
            io.emit("pairingCode", payload);
            io.emit("session:pairing_code", payload);
            return;
        } catch {
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

async function createBaileysSession(sessionId, io, options = null) {
    if (sessions.has(sessionId)) return sessions.get(sessionId);
    if (sessionLocks.has(sessionId)) return;
    if (options) sessionInitOptions.set(sessionId, options);
    const initOptions = options || sessionInitOptions.get(sessionId) || {};

    sessionLocks.add(sessionId);
    console.log("Starting session:", sessionId);

    try {
        const sessionPath = path.join(SESSIONS_DIR, sessionId);
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger: P({ level: "error" }),
            auth: state,
            printQRInTerminal: false,
            browser: ["TagThemAll Engine", "Chrome", "1.0.0"],
            markOnlineOnConnect: false,
            syncFullHistory: true,
            shouldSyncHistoryMessage: () => true,
            generateHighQualityLinkPreview: false,
            defaultQueryTimeoutMs: 60000
        });

        if (typeof makeInMemoryStore === "function") {
            const store = makeInMemoryStore({});
            store.bind(sock.ev);
            sock.store = store;
        } else {
            console.warn("[bailey] makeInMemoryStore not available in this Baileys version; continuing without in-memory store");
        }

        sessions.set(sessionId, sock);
        if (sock?.ev && typeof sock.ev.setMaxListeners === "function") {
            sock.ev.setMaxListeners(0);
        }
        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async update => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                const userId = extractUserId(sessionId);
                const payload = { sessionId, qr, userId };
                io.emit("session:qr", payload);
                io.emit("qrCode", payload);
            }

            if (connection === "open") {
                const userId = extractUserId(sessionId);
                const phone = (sock.user?.id || "").split(":")[0] || null;
                const payload = { sessionId, userId, phone };
                const selfJid = normalizeJid(sock.user?.id);
                const whatsappNumber = (phone || "").replace(/[^0-9]/g, "");

                // Legacy parity: blacklist and duplicate-account checks on connect
                try {
                    if (whatsappNumber) {
                        const blacklisted = await BlacklistedNumber.findOne({ whatsappNumber }).lean().catch(() => null);
                        if (blacklisted && !blacklisted.canReactivate) {
                            if (selfJid) {
                                await sock.sendMessage(selfJid, {
                                    text: `⛔ *ACCESS DENIED*

This WhatsApp number was previously used with: ${blacklisted.originalEmail}
Your trial expired on: ${blacklisted.trialUsedAt ? new Date(blacklisted.trialUsedAt).toLocaleDateString() : "N/A"}

✅ *TO CONTINUE USING OUR SERVICE:*
Option 1: Log in to your original account (${blacklisted.originalEmail})
Option 2: Upgrade to a paid plan at https://tagthemall.com.ng
Option 3: Contact support: support@tagthemall.com`
                                }).catch(() => {});
                            }
                            await Session.findOneAndUpdate(
                                { sessionId },
                                { status: "failed", errorMessage: "WhatsApp number blacklisted", updatedAt: new Date() }
                            ).catch(() => {});
                            try { await sock.logout(); } catch {}
                            return;
                        }

                        const existingUser = await User.findOne({
                            whatsappNumber,
                            status: { $in: ["active", "approved"] }
                        }).lean().catch(() => null);

                        const currentSession = await Session.findOne({ sessionId }).lean().catch(() => null);
                        const currentUserId = currentSession?.userId ? String(currentSession.userId) : null;

                        if (existingUser && String(existingUser._id) !== currentUserId) {
                            if (selfJid) {
                                await sock.sendMessage(selfJid, {
                                    text: `⚠️ *DUPLICATE ACCOUNT DETECTED*

This WhatsApp number is already connected to another account:
Email: ${existingUser.email}
Subscription: ${existingUser.subscription}

Please log in to your original account or disconnect there first.`
                                }).catch(() => {});
                            }
                            await Session.findOneAndUpdate(
                                { sessionId },
                                { status: "failed", errorMessage: "WhatsApp number already in use", updatedAt: new Date() }
                            ).catch(() => {});
                            try { await sock.logout(); } catch {}
                            return;
                        }

                        if (currentUserId) {
                            await User.findByIdAndUpdate(currentUserId, { whatsappNumber }).catch(() => {});
                        }
                    }
                } catch {}

                // Persist connected state so dashboard/API don't revert back to waiting_qr.
                await Session.findOneAndUpdate(
                    { sessionId },
                    {
                        status: "connected",
                        connectedAt: new Date(),
                        updatedAt: new Date(),
                        ...(phone ? { whatsappNumber: phone } : {})
                    }
                ).catch(() => {});

                // Send onboarding message to self-chat on successful link.
                try {
                    if (selfJid) {
                        await sock.sendMessage(selfJid, {
                            text: `🤖 *BOT CONNECTED*\nSession: ${sessionId}`
                        });

                        await new Promise(r => setTimeout(r, 400));

                        await sock.sendMessage(selfJid, {
                            text: `
━━━━━━━━━━━━━━━━━━━━━━━
✨ WELCOME TO TAGTHEMALL BOT ✨
━━━━━━━━━━━━━━━━━━━━━━━

🤖 Your automation assistant is now active!

📌 GROUP TOOLS
• !list — Groups where you're admin
• !members — View group members
• !admins — View group admins

👥 TAGGING
• !tag — Tag all members
• !tagexcept — Tag everyone except selected users

📨 DIRECT MESSAGING
• !dmall — DM all members
• !dmselected — DM selected members only

📋 AUTO-REPLY COMMANDS

Quick Start:
• !autoreply - Reply a certain message
• !autoreply addgroup - Choose group command works on 
• !autoreply status
• !autoreply help

💡 Type *!help* for full command list & *!autoreply* for full autoreply command list.
*For Help Chat: +2347067012884*
                            `
                        });
                    }
                } catch {}

                io.emit("session:ready", payload);
                io.emit("sessionReady", payload);
                startScheduler(sessionId, sock);
            }

            if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                sessions.delete(sessionId);
                stopScheduler(sessionId);

                try {
                    sock.ev.removeAllListeners();
                    sock.ws?.close?.();
                } catch {}

                if (shouldReconnect) {
                    setTimeout(() => {
                        createBaileysSession(sessionId, io, sessionInitOptions.get(sessionId) || null);
                    }, SESSION_START_DELAY);
                } else {
                    io.emit("session:logged_out", { sessionId });
                    sessionInitOptions.delete(sessionId);
                }
            }
        });

        sock.ev.on("messages.update", async updates => {
            for (const update of updates) {
                if (update.update?.message !== null) continue;

                const groupId = update.key.remoteJid;
                if (!groupId?.endsWith("@g.us")) continue;

                const settings = await GroupSettings.findOne({ groupId });
                if (settings?.antiDelete) {
                    await sock.sendMessage(groupId, {
                        text: "A message was deleted."
                    });
                }
            }
        });

        sock.ev.on("group-participants.update", async update => {
            const settings = await GroupSettings.findOne({ groupId: update.id });
            if (!settings?.welcome) return;

            if (update.action === "add") {
                await sock.sendMessage(update.id, { text: "Welcome to the group!" });
            }

            if (update.action === "remove") {
                await sock.sendMessage(update.id, { text: "A member left the group." });
            }
        });

        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            const msg = messages?.[0];
            if (!msg?.message) return;

            try {
                const from = msg.key.remoteJid;
                const sender = msg.key.participant || from;
                const isGroup = !!from && from.endsWith("@g.us");

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
                    from,
                    upsertType: type,
                    isHistorical: type !== "notify"
                });
            } catch (err) {
                console.error("Bot engine error:", err);
            }
        });

        if (initOptions.usePairingCode && initOptions.phoneNumber) {
            requestPairingCodeWithRetry(sock, sessionId, io, initOptions.phoneNumber).catch(() => {});
        }

        return sock;
    } catch (error) {
        console.error("Session creation failed:", sessionId, error);
        sessions.delete(sessionId);
        throw error;
    } finally {
        sessionLocks.delete(sessionId);
    }
}

async function resumeUserSession(userId, sessionId, io) {
    if (sessions.has(sessionId)) return sessions.get(sessionId);
    return createBaileysSession(sessionId, io);
}

module.exports = {
    createBaileysSession,
    resumeUserSession,
    sessions
};
