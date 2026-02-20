const config = require("./config");
const GroupSettings = require("./models/GroupSettings");
const GroupMembers = require("./models/GroupMembers");
const SavedGroupList = require("./models/SavedGroupList");
const ActiveGroup = require("./models/ActiveGroup");
const AutoReply = require("./models/AutoReply");
const TagUsage = require("./models/TagUsage");
const GroupPermission = require("./models/GroupPermission");
const Schedule = require("./models/Schedule");
const User = require("./models/User");
const { generateForwardMessageContent, generateWAMessageFromContent } = require("@whiskeysockets/baileys");

const subscriptionPlans = require("../config/subscriptionPlans");
const CommandGrant = require("../models/CommandGrant");

const PREFIX = config?.client?.COMMAND_PREFIX || "!";
const SPAM_WINDOW = 10000;
const SPAM_LIMIT = 5;
const TAG_ROTATE_SIZE = 100;
const RECALL_CACHE_LIMIT_PER_CHAT = 800;

const spam = new Map();
const runningSchedule = new Set();
const recallCache = new Map();

function msgText(msg) {
    const m = msg.message || {};
    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        m.documentMessage?.caption ||
        ""
    ).trim();
}

function normalizeJid(j) {
    if (!j) return "";
    const [left, right] = j.split("@");
    if (!left || !right) return j;
    return `${left.split(":")[0]}@${right}`;
}

function digitsToJid(s) {
    const d = String(s || "").replace(/[^0-9]/g, "");
    if (!d) return null;
    return `${d}@s.whatsapp.net`;
}

function mentionToken(j) {
    return `@${normalizeJid(j).split("@")[0]}`;
}

function getSelfJid(sock) {
    return normalizeJid(sock.user?.id);
}

function extractUserId(sessionId) {
    const m = String(sessionId || "").match(/^session-([^-]+)/);
    return m ? m[1] : null;
}

async function sendText(sock, to, text, extra = {}) {
    return sock.sendMessage(to, { text, ...extra });
}

function addDelay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function detectMediaType(message = {}) {
    if (message.imageMessage) return "image";
    if (message.videoMessage) return "video";
    if (message.audioMessage) return "audio";
    if (message.documentMessage) return "document";
    if (message.stickerMessage) return "sticker";
    return "text";
}

function toTimestampMs(value) {
    if (!value) return Date.now();
    if (typeof value === "number") return value * 1000;
    if (typeof value === "object" && typeof value.low === "number") return value.low * 1000;
    return Date.now();
}

function recallMapKey(sessionId, chatId) {
    return `${sessionId}|${chatId}`;
}

function cacheMessageForRecall({ sessionId, chatId, msg }) {
    if (!sessionId || !chatId || !msg?.message) return;

    const key = recallMapKey(sessionId, chatId);
    const list = recallCache.get(key) || [];
    const id = msg.key?.id || "";

    const next = list.filter(x => (x.wamessage?.key?.id || "") !== id);
    next.unshift({
        ts: toTimestampMs(msg.messageTimestamp),
        text: msgText(msg),
        mediaType: detectMediaType(msg.message),
        wamessage: {
            key: msg.key || {},
            message: msg.message,
            messageTimestamp: msg.messageTimestamp
        }
    });

    if (next.length > RECALL_CACHE_LIMIT_PER_CHAT) {
        next.length = RECALL_CACHE_LIMIT_PER_CHAT;
    }

    recallCache.set(key, next);
}

function parseStoreMessages(sock, chatId) {
    const bucket = sock.store?.messages?.[chatId];
    if (!bucket) return [];
    return Object.values(bucket)
        .map(v => (v?.message ? v : v?.array?.[0]))
        .filter(Boolean)
        .map(m => ({
            ts: toTimestampMs(m.messageTimestamp),
            text: msgText(m),
            mediaType: detectMediaType(m.message || {}),
            wamessage: {
                key: m.key || {},
                message: m.message || {},
                messageTimestamp: m.messageTimestamp
            }
        }));
}

function getRecallEntries(sock, sessionId, chatId) {
    const key = recallMapKey(sessionId, chatId);
    const mem = recallCache.get(key) || [];
    if (mem.length) return mem;
    return parseStoreMessages(sock, chatId);
}

async function tryForwardMessage(sock, to, targetMessage, quotedMessage) {
    if (!targetMessage?.message) return false;
    try {
        const content = await generateForwardMessageContent(targetMessage, false);
        const generated = generateWAMessageFromContent(to, content, {
            userJid: sock.user?.id,
            quoted: quotedMessage || undefined
        });
        await sock.relayMessage(to, generated.message, { messageId: generated.key.id });
        return true;
    } catch {
        return false;
    }
}

function parseQuoted(msg, currentChatId) {
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    const quoted = ctx?.quotedMessage;
    if (!quoted) return null;

    const text =
        quoted.conversation ||
        quoted.extendedTextMessage?.text ||
        quoted.imageMessage?.caption ||
        quoted.videoMessage?.caption ||
        quoted.documentMessage?.caption ||
        "";

    return {
        text,
        stanzaId: ctx.stanzaId || null,
        participant: normalizeJid(ctx.participant || ""),
        quotedWAMessage: {
            key: {
                remoteJid: currentChatId,
                fromMe: false,
                id: ctx.stanzaId || undefined,
                participant: ctx.participant || undefined
            },
            message: quoted
        }
    };
}

async function loadAllGroups(sock, adminOnly) {
    const all = await sock.groupFetchAllParticipating();
    const me = getSelfJid(sock);
    const rows = [];

    for (const [groupId, g] of Object.entries(all || {})) {
        const participants = g.participants || [];
        if (adminOnly) {
            const mine = participants.find(p => normalizeJid(p.id) === me);
            if (!mine?.admin) continue;
        }
        rows.push({
            name: g.subject || "Unnamed Group",
            groupId
        });
    }

    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
}

async function getCachedGroups(sock, sessionId, all = false, refresh = false) {
    const key = all ? `${sessionId}_all` : sessionId;
    let cache = null;
    if (!refresh) {
        cache = await SavedGroupList.findOne({ sessionId: key }).lean().catch(() => null);
    }
    let groups = cache?.groups || [];

    if (!groups.length || refresh) {
        groups = await loadAllGroups(sock, !all);
        await SavedGroupList.findOneAndUpdate(
            { sessionId: key },
            { groups, updatedAt: new Date() },
            { upsert: true }
        );
    }

    return groups;
}

async function resolveGroup(sock, sessionId, idx, all = false) {
    const groups = await getCachedGroups(sock, sessionId, all, false);
    if (idx && !Number.isNaN(idx)) return groups[idx - 1] || null;

    const active = await ActiveGroup.findOne({ sessionId }).lean().catch(() => null);
    if (active?.groupId) {
        return groups.find(g => g.groupId === active.groupId) || null;
    }

    return null;
}

async function getGroupMembers(sock, sessionId, groupId, forceRefresh = false) {
    if (!forceRefresh) {
        const c = await GroupMembers.findOne({ sessionId, groupId }).lean().catch(() => null);
        if (c?.members?.length) return c.members;
    }

    const m = await sock.groupMetadata(groupId);
    const members = (m.participants || []).map(p => normalizeJid(p.id));
    await GroupMembers.findOneAndUpdate(
        { sessionId, groupId },
        { members, updatedAt: new Date() },
        { upsert: true }
    );
    return members;
}

function parseTargets(tokens, sourceMembers = []) {
    const out = new Set();

    for (const token of tokens) {
        if (!token) continue;

        if (/^\d+-\d+$/.test(token)) {
            const [a, b] = token.split("-").map(v => parseInt(v, 10));
            const end = Math.min(b, sourceMembers.length);
            for (let i = a; i <= end; i++) {
                if (sourceMembers[i - 1]) out.add(sourceMembers[i - 1]);
            }
            continue;
        }

        if (/^\d+(,\d+)+$/.test(token)) {
            token.split(",").map(v => parseInt(v, 10)).forEach(i => {
                if (sourceMembers[i - 1]) out.add(sourceMembers[i - 1]);
            });
            continue;
        }

        if (token.includes("@")) {
            const d = token.replace(/[^0-9]/g, "");
            if (d.length >= 7) out.add(digitsToJid(d));
            continue;
        }

        if (/^\d+$/.test(token)) {
            const n = parseInt(token, 10);
            if (token.length >= 10) out.add(digitsToJid(token));
            else if (sourceMembers[n - 1]) out.add(sourceMembers[n - 1]);
            continue;
        }
    }

    return Array.from(out).filter(Boolean).map(normalizeJid);
}

function mapPlanCommand(c) {
    const map = {
        autoreply: "auto_reply",
        schedule: "scheduler",
        listschedules: "scheduler",
        cancelschedule: "scheduler",
        forwardone: "forward",
        forwardmulti: "forward",
        forwardall: "forward",
        tagfew: "tag",
        dmall: "dmall",
        dmallmulti: "dmall",
        dmselected: "dmall"
    };
    return map[c] || c;
}

async function canUseCommand(sessionId, commandName) {
    const userId = extractUserId(sessionId);
    if (!userId) return true;

    try {
        const user = await User.findById(userId);
        if (!user) return false;

        if (typeof user.isExemptFromPayment === "function" && user.isExemptFromPayment()) return true;
        if (typeof user.isBotOwner === "function" && user.isBotOwner()) return true;
        if (typeof user.isSystemAdmin === "function" && user.isSystemAdmin()) return true;

        const now = new Date();
        const isActive = user.subscriptionExpiry && new Date(user.subscriptionExpiry) > now;
        const isPaid = user.paymentStatus === "paid" || user.paymentStatus === "trial";
        const c = mapPlanCommand(commandName);

        if (!isActive && !isPaid) return ["ping", "help", "status"].includes(c);

        const planName = String(user.subscription || "free").toLowerCase();
        const plan = subscriptionPlans[planName] || subscriptionPlans.free;
        if (plan.allowedCommands === "all") return true;
        if (Array.isArray(plan.allowedCommands) && plan.allowedCommands.includes(c)) return true;
        if (Array.isArray(user.customCommands) && user.customCommands.includes(c)) return true;

        const grant = await CommandGrant.findOne({
            $and: [
                { $or: [{ userId: user._id }, { planType: planName }] },
                { commandName: c },
                { isActive: true },
                { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }
            ]
        }).lean();
        return !!grant;
    } catch {
        return false;
    }
}

async function processAutoReply({ sock, from, sessionId, isGroup, body, fromMe }) {
    if (!body || fromMe) return;

    const doc = await AutoReply.findOne({ sessionId }).lean().catch(() => null);
    if (!doc || doc.globalEnabled === false) return;
    if (isGroup && doc.disabledGroups?.includes(from)) return;
    if (isGroup && doc.allowedGroups?.length && !doc.allowedGroups.includes(from)) return;

    const text = body.toLowerCase();
    const groupRule = (doc.groupRules || []).find(g => g.groupId === from && g.enabled !== false);
    const globalRules = doc.globalRules || doc.rules || [];
    let rules = globalRules;

    if (groupRule?.overrideGlobal) rules = groupRule.rules || [];
    else if (groupRule?.rules?.length) rules = [...globalRules, ...groupRule.rules];

    for (const r of rules) {
        if (r.active === false) continue;
        const k = String(r.keyword || "").toLowerCase();
        if (!k) continue;
        const mt = r.matchType || "contains";
        const ok =
            (mt === "exact" && text === k) ||
            (mt === "starts" && text.startsWith(k)) ||
            (mt === "ends" && text.endsWith(k)) ||
            (mt === "contains" && text.includes(k));
        if (!ok) continue;
        await sendText(sock, from, r.response);
        return;
    }
}

async function processRecallKeywords({ sock, sessionId, from, body, fromMe, currentMessageId }) {
    if (fromMe || !body || body.startsWith(PREFIX)) return false;

    const doc = await AutoReply.findOne({ sessionId }).lean().catch(() => null);
    const kws = doc?.recallKeywords || [];
    if (!kws.length) return false;

    const text = body.toLowerCase().trim();
    const parts = text.split(/\s+/);
    const idx = parseInt(parts[parts.length - 1], 10);
    if (Number.isNaN(idx) || idx < 1) return false;

    const picked = kws.find(k => text.includes(String(k.term || "").toLowerCase()));
    if (!picked) return false;

    const items = getRecallEntries(sock, sessionId, from);
    if (!items.length) return false;

    const wantMedia = picked.mapsToMedia;
    const filtered = items.filter(w => {
        if (currentMessageId && w.wamessage?.key?.id === currentMessageId) return false;
        if (!wantMedia) return true;
        if (wantMedia === "image") return w.mediaType === "image";
        if (wantMedia === "video") return w.mediaType === "video";
        if (wantMedia === "audio") return w.mediaType === "audio";
        if (wantMedia === "document") return w.mediaType === "document";
        if (wantMedia === "sticker") return w.mediaType === "sticker";
        return true;
    });

    if (idx > filtered.length) {
        await sendText(sock, from, `I found ${filtered.length} matching items only.`);
        return true;
    }

    const target = filtered[idx - 1];
    const forwarded = await tryForwardMessage(sock, from, target.wamessage, null);
    if (!forwarded) {
        const t = target.text;
        if (!t) {
            await sendText(sock, from, "Found a matching item but resend failed for this media.");
            return true;
        }
        await sendText(sock, from, t);
    }
    return true;
}

function nextRun(hhmm) {
    const [h, m] = String(hhmm || "").split(":").map(Number);
    if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
    const d = new Date();
    d.setHours(h, m, 0, 0);
    if (d <= new Date()) d.setDate(d.getDate() + 1);
    return d;
}

async function handleCommand(ctx) {
    const { sock, msg, sessionId, from, sender, isGroup, isAdmin, body } = ctx;
    const selfJid = getSelfJid(sock);
    const senderJid = normalizeJid(sender);
    const isSelfChat = normalizeJid(from) === selfJid && senderJid === selfJid;
    const fromMe = !!msg.key.fromMe || senderJid === selfJid;

    const full = body.slice(PREFIX.length).trim();
    const [rawCmd, ...args] = full.split(/\s+/);
    const cmd = String(rawCmd || "").toLowerCase();

    const ownerOnly = new Set([
        "list", "listall", "use", "unset", "status", "members", "admins",
        "tag", "tagexcept", "tagfew", "dmall", "dmallmulti", "dmselected",
        "forwardone", "forwardmulti", "forwardall", "autoreply",
        "keyword", "find", "schedule", "listschedules", "cancelschedule"
    ]);

    if (ownerOnly.has(cmd) && !(fromMe && isSelfChat)) return;

    if (!(await canUseCommand(sessionId, cmd))) {
        await sendText(sock, from, `Command !${cmd} is not available on your current plan.`);
        return;
    }

    if (cmd === "ping") return sendText(sock, from, "Pong!");

    if (cmd === "help" || cmd === "menu") {
        return sendText(
            sock,
            from,
            [
                "*Commands*",
                "!list !listall !use !unset",
                "!status !members !admins",
                "!tag !tagexcept !tagfew",
                "!dmall !dmallmulti !dmselected",
                "!forwardone !forwardmulti !forwardall",
                "!autoreply ...",
                "!keyword ... !find ...",
                "!schedule !listschedules !cancelschedule",
                "!antilink !antidelete !welcome"
            ].join("\n")
        );
    }

    if (cmd === "antilink" || cmd === "antidelete" || cmd === "welcome") {
        if (!isGroup || !isAdmin) return sendText(sock, from, "Group admin only.");
        const mode = String(args[0] || "").toLowerCase();
        if (!["on", "off"].includes(mode)) return sendText(sock, from, `Usage: !${cmd} on/off`);
        const g = (await GroupSettings.findOne({ groupId: from })) || (await GroupSettings.create({ groupId: from }));
        if (cmd === "antilink") g.antiLink = mode === "on";
        if (cmd === "antidelete") g.antiDelete = mode === "on";
        if (cmd === "welcome") g.welcome = mode === "on";
        await g.save();
        return sendText(sock, from, `${cmd} ${mode.toUpperCase()}`);
    }

    if (cmd === "list" || cmd === "listall") {
        const groups = await getCachedGroups(sock, sessionId, cmd === "listall", args[0] === "refresh");
        if (!groups.length) return sendText(sock, from, "No groups found.");
        return sendText(sock, from, groups.map((g, i) => `${i + 1}. ${g.name}`).join("\n"));
    }

    if (cmd === "use") {
        const idx = parseInt(args[0], 10);
        if (Number.isNaN(idx)) return sendText(sock, from, "Usage: !use <groupIndex>");
        const g = await resolveGroup(sock, sessionId, idx, false);
        if (!g) return sendText(sock, from, "Invalid group index.");
        await ActiveGroup.findOneAndUpdate(
            { sessionId },
            { sessionId, activeIndex: idx, groupId: g.groupId, groupName: g.name, updatedAt: new Date() },
            { upsert: true }
        );
        return sendText(sock, from, `Active group set: ${g.name}`);
    }

    if (cmd === "unset") {
        await ActiveGroup.deleteOne({ sessionId });
        return sendText(sock, from, "Active group cleared.");
    }

    if (cmd === "status") {
        const admin = await SavedGroupList.findOne({ sessionId }).lean().catch(() => null);
        const all = await SavedGroupList.findOne({ sessionId: `${sessionId}_all` }).lean().catch(() => null);
        const m = await GroupMembers.countDocuments({ sessionId }).catch(() => 0);
        return sendText(sock, from, `Session: ${sessionId}\nAdmin groups: ${admin?.groups?.length || 0}\nAll groups: ${all?.groups?.length || 0}\nCached member docs: ${m}`);
    }

    if (cmd === "members" || cmd === "admins") {
        const idx = args[0] ? parseInt(args[0], 10) : null;
        const g = await resolveGroup(sock, sessionId, idx, cmd === "admins");
        if (!g) return sendText(sock, from, "No target group found.");
        const md = await sock.groupMetadata(g.groupId);
        const rows = cmd === "admins"
            ? (md.participants || []).filter(p => !!p.admin).map(p => normalizeJid(p.id))
            : (md.participants || []).map(p => normalizeJid(p.id));
        if (!rows.length) return sendText(sock, from, "No entries.");
        return sendText(sock, from, rows.map((x, i) => `${i + 1}. ${x.split("@")[0]}`).join("\n"));
    }

    if (cmd === "tag" || cmd === "tagfew") {
        const idx = args[0] && /^\d+$/.test(args[0]) ? parseInt(args[0], 10) : null;
        const g = await resolveGroup(sock, sessionId, idx, false);
        if (!g) return sendText(sock, from, "No target group. Use !list and !use.");
        const list = await getGroupMembers(sock, sessionId, g.groupId, false);
        const me = getSelfJid(sock);
        const pool = list.filter(x => x !== me);
        if (!pool.length) return sendText(sock, from, "No members available.");

        let targets = [];
        if (cmd === "tagfew") {
            const raw = full.slice("tagfew".length).trim();
            const [left, right] = raw.split("|");
            const parts = String(left || "").trim().split(/\s+/);
            const tk = parts.slice(1);
            targets = parseTargets(tk, pool);
            if (!targets.length) return sendText(sock, from, "No valid selected targets.");
            const text = (right || "*Attention selected users*").trim();
            await sendText(sock, g.groupId, `${text}\n\n${targets.map(mentionToken).join(" ")}`, { mentions: targets });
            return sendText(sock, from, `Tagfew completed in ${g.name}.`);
        }

        const u = await TagUsage.findOneAndUpdate(
            { sessionId, groupId: g.groupId },
            { $setOnInsert: { lastPosition: 0, lastTaggedAt: new Date() } },
            { upsert: true, new: true }
        );
        let p = u.lastPosition || 0;
        if (p >= pool.length) p = 0;
        targets = pool.slice(p, p + TAG_ROTATE_SIZE);
        u.lastPosition = p + TAG_ROTATE_SIZE >= pool.length ? 0 : p + TAG_ROTATE_SIZE;
        u.lastTaggedAt = new Date();
        await u.save();

        const text = args.slice(idx ? 1 : 0).join(" ").trim() || "*Attention everyone*";
        await sendText(sock, g.groupId, `${text}\n\n${targets.map(mentionToken).join(" ")}`, { mentions: targets });
        return sendText(sock, from, `Tagged ${targets.length} members in ${g.name}.`);
    }

    if (cmd === "tagexcept") {
        const raw = full.slice("tagexcept".length).trim();
        const [left, right] = raw.split("|");
        const parts = String(left || "").trim().split(/\s+/);
        const idx = parseInt(parts[0], 10);
        if (Number.isNaN(idx)) return sendText(sock, from, "Usage: !tagexcept <groupIndex> <targets> | <message>");
        const g = await resolveGroup(sock, sessionId, idx, false);
        if (!g) return sendText(sock, from, "Invalid group index.");
        const list = await getGroupMembers(sock, sessionId, g.groupId, false);
        const ex = new Set(parseTargets(parts.slice(1), list));
        const me = getSelfJid(sock);
        const targets = list.map(normalizeJid).filter(x => x !== me && !ex.has(x));
        if (!targets.length) return sendText(sock, from, "No members left after exclusion.");
        const text = (right || "*Attention filtered*").trim();
        await sendText(sock, g.groupId, `${text}\n\n${targets.map(mentionToken).join(" ")}`, { mentions: targets });
        return sendText(sock, from, `Tag-except completed in ${g.name}.`);
    }

    if (cmd === "dmall" || cmd === "dmselected" || cmd === "dmallmulti") {
        const raw = full.slice(cmd.length).trim();
        const [left, right] = raw.split("|");
        const message = String(right || "").trim();
        if (!message) return sendText(sock, from, `Usage: !${cmd} ... | <message>`);

        const leftParts = String(left || "").trim().split(/\s+/).filter(Boolean);
        let recipients = [];

        if (cmd === "dmallmulti") {
            const idxs = (leftParts[0] || "").split(",").map(v => parseInt(v, 10)).filter(v => !Number.isNaN(v));
            for (const idx of idxs) {
                const g = await resolveGroup(sock, sessionId, idx, true);
                if (!g) continue;
                const list = await getGroupMembers(sock, sessionId, g.groupId, true).catch(() => []);
                recipients.push(...list);
            }
        } else {
            const maybeIdx = parseInt(leftParts[0], 10);
            if (!Number.isNaN(maybeIdx) && maybeIdx <= 999) {
                const g = await resolveGroup(sock, sessionId, maybeIdx, true);
                if (!g) return sendText(sock, from, "Invalid group index.");
                const list = await getGroupMembers(sock, sessionId, g.groupId, true);
                if (cmd === "dmall") {
                    const targets = parseTargets(leftParts.slice(1), list);
                    recipients = targets.length ? targets : list;
                } else {
                    recipients = parseTargets(leftParts.slice(1), list);
                }
            } else {
                recipients = parseTargets(leftParts, []);
            }
        }

        const me = getSelfJid(sock);
        recipients = Array.from(new Set(recipients.map(normalizeJid))).filter(j => j && j !== me && !j.endsWith("@g.us"));
        if (!recipients.length) return sendText(sock, from, "No valid DM recipients found.");

        let sent = 0;
        for (const r of recipients) {
            try {
                await sendText(sock, r, message);
                sent++;
            } catch {}
            await addDelay(350);
        }
        return sendText(sock, from, `DM completed: ${sent}/${recipients.length}`);
    }

    if (cmd === "forwardone" || cmd === "forwardmulti" || cmd === "forwardall") {
        const q = parseQuoted(msg, from);
        if (!q?.quotedWAMessage && !q?.text) return sendText(sock, from, "Reply to a message first.");

        let targetGroups = [];
        if (cmd === "forwardone") {
            const idx = parseInt(args[0], 10);
            if (Number.isNaN(idx)) return sendText(sock, from, "Usage: !forwardone <groupIndex>");
            const g = await resolveGroup(sock, sessionId, idx, true);
            if (!g) return sendText(sock, from, "Invalid group index.");
            targetGroups = [g];
        } else if (cmd === "forwardmulti") {
            const idxs = String(args[0] || "").split(",").map(v => parseInt(v, 10)).filter(v => !Number.isNaN(v));
            for (const idx of idxs) {
                const g = await resolveGroup(sock, sessionId, idx, true);
                if (g) targetGroups.push(g);
            }
        } else {
            targetGroups = await getCachedGroups(sock, sessionId, true, true);
        }

        if (!targetGroups.length) return sendText(sock, from, "No target groups found.");

        const me = getSelfJid(sock);
        const recipients = new Set();
        for (const g of targetGroups) {
            const list = await getGroupMembers(sock, sessionId, g.groupId, true).catch(() => []);
            list.forEach(j => {
                const n = normalizeJid(j);
                if (n && n !== me && !n.endsWith("@g.us")) recipients.add(n);
            });
        }

        if (!recipients.size) return sendText(sock, from, "No recipients found.");

        let sent = 0;
        for (const r of recipients) {
            try {
                const forwarded = await tryForwardMessage(sock, r, q.quotedWAMessage, msg);
                if (forwarded) {
                    sent++;
                } else if (q.text) {
                    await sendText(sock, r, q.text);
                    sent++;
                }
            } catch {}
            await addDelay(350);
        }
        return sendText(sock, from, `Forward completed: ${sent}/${recipients.size}`);
    }

    if (cmd === "keyword") {
        const sub = String(args[0] || "").toLowerCase();
        const doc = (await AutoReply.findOne({ sessionId })) || (await AutoReply.create({ sessionId }));
        doc.recallKeywords = doc.recallKeywords || [];

        if (sub === "add") {
            const fullArg = args.slice(1).join(" ");
            const i = fullArg.indexOf("|");
            if (i === -1) return sendText(sock, from, "Usage: !keyword add <term> | <mapping>");
            const term = fullArg.slice(0, i).trim().toLowerCase();
            const map = fullArg.slice(i + 1).trim().toLowerCase();
            if (!term || !map) return sendText(sock, from, "Invalid term/mapping.");

            let mapsToMedia = null;
            if (/image|picture|photo|pic/.test(map)) mapsToMedia = "image";
            else if (/video|vid|mp4/.test(map)) mapsToMedia = "video";
            else if (/audio|voice|ptt/.test(map)) mapsToMedia = "audio";
            else if (/document|doc|pdf|file/.test(map)) mapsToMedia = "document";
            else if (/sticker|gif/.test(map)) mapsToMedia = "sticker";

            const existing = doc.recallKeywords.find(k => String(k.term).toLowerCase() === term);
            if (existing) {
                existing.mapsToTime = map;
                existing.mapsToMedia = mapsToMedia;
            } else {
                doc.recallKeywords.push({ term, mapsToTime: map, mapsToMedia });
            }
            await doc.save();
            return sendText(sock, from, `Keyword saved: ${term}`);
        }

        if (sub === "remove") {
            const term = args.slice(1).join(" ").trim().toLowerCase();
            if (!term) return sendText(sock, from, "Usage: !keyword remove <term>");
            doc.recallKeywords = doc.recallKeywords.filter(k => String(k.term).toLowerCase() !== term);
            await doc.save();
            return sendText(sock, from, `Keyword removed: ${term}`);
        }

        if (sub === "list") {
            if (!doc.recallKeywords.length) return sendText(sock, from, "No recall keywords set.");
            const out = doc.recallKeywords.map((k, i) => `${i + 1}. ${k.term} -> time:${k.mapsToTime || "-"} media:${k.mapsToMedia || "-"}`).join("\n");
            return sendText(sock, from, out);
        }

        return sendText(sock, from, "Usage: !keyword add/remove/list");
    }

    if (cmd === "find") {
        const keyword = args.join(" ").trim().toLowerCase();
        if (!keyword) return sendText(sock, from, "Usage: !find <keyword>");
        const groups = await getCachedGroups(sock, sessionId, true, false);
        const nameMap = new Map(groups.map(g => [g.groupId, g.name]));
        const hits = [];

        for (const [k, entries] of recallCache.entries()) {
            if (!k.startsWith(`${sessionId}|`)) continue;
            const chatId = k.slice(sessionId.length + 1);
            for (const item of entries) {
                const hay = `${item.text || ""} ${item.mediaType || ""}`.toLowerCase();
                if (!hay.includes(keyword)) continue;
                hits.push({
                    chatId,
                    chatName: nameMap.get(chatId) || chatId,
                    mediaType: item.mediaType || "text",
                    preview: String(item.text || "[media]").slice(0, 45)
                });
                if (hits.length >= 20) break;
            }
            if (hits.length >= 20) break;
        }

        if (!hits.length) {
            for (const g of groups) {
                const entries = parseStoreMessages(sock, g.groupId);
                const hit = entries.find(item => `${item.text || ""} ${item.mediaType || ""}`.toLowerCase().includes(keyword));
                if (!hit) continue;
                hits.push({
                    chatId: g.groupId,
                    chatName: g.name || g.groupId,
                    mediaType: hit.mediaType || "text",
                    preview: String(hit.text || "[media]").slice(0, 45)
                });
                if (hits.length >= 20) break;
            }
        }

        if (!hits.length) {
            return sendText(sock, from, "No cached matches found yet. Keep history sync on and allow chats to load.");
        }
        return sendText(
            sock,
            from,
            `Cached matches:\n${hits.map((h, i) => `${i + 1}. [${h.chatName}] ${h.mediaType} - ${h.preview}`).join("\n")}`
        );
    }

    if (cmd === "allow" || cmd === "unallow" || cmd === "deny" || cmd === "unblock" || cmd === "whitelist" || cmd === "blocklist") {
        const idx = parseInt(args[0], 10);
        const g = await resolveGroup(sock, sessionId, idx, false);
        if (!g) return sendText(sock, from, "Usage: !<cmd> <groupIndex> [number]");

        if (cmd === "whitelist" || cmd === "blocklist") {
            const d = await GroupPermission.findOne({ botUserId: sessionId, groupId: g.groupId }).lean().catch(() => null);
            const list = cmd === "whitelist" ? (d?.allowed || []) : (d?.blocked || []);
            return sendText(sock, from, list.length ? list.join("\n") : "No entries.");
        }

        const j = digitsToJid(args[1]);
        if (!j) return sendText(sock, from, "Provide a valid number.");

        if (cmd === "allow") {
            await GroupPermission.updateOne({ botUserId: sessionId, groupId: g.groupId }, { $addToSet: { allowed: j }, $pull: { blocked: j } }, { upsert: true });
        } else if (cmd === "unallow") {
            await GroupPermission.updateOne({ botUserId: sessionId, groupId: g.groupId }, { $pull: { allowed: j } }, { upsert: true });
        } else if (cmd === "deny") {
            await GroupPermission.updateOne({ botUserId: sessionId, groupId: g.groupId }, { $addToSet: { blocked: j }, $pull: { allowed: j } }, { upsert: true });
        } else if (cmd === "unblock") {
            await GroupPermission.updateOne({ botUserId: sessionId, groupId: g.groupId }, { $pull: { blocked: j } }, { upsert: true });
        }

        return sendText(sock, from, "Permission list updated.");
    }

    if (cmd === "autoreply") {
        const sub = String(args[0] || "").toLowerCase();
        let doc = await AutoReply.findOne({ sessionId }).catch(() => null);
        if (!doc) doc = await AutoReply.create({ sessionId, globalRules: [], groupRules: [], allowedGroups: [], disabledGroups: [] });

        const pickGroupFromSub = async pos => {
            const idx = parseInt(args[pos], 10);
            if (Number.isNaN(idx)) return null;
            return resolveGroup(sock, sessionId, idx, true);
        };

        if (sub === "add" || sub === "remove" || sub === "list") {
            if (sub === "list") {
                const rules = doc.globalRules || [];
                if (!rules.length) return sendText(sock, from, "No global autoreply rules.");
                return sendText(sock, from, rules.map((r, i) => `${i + 1}. ${r.keyword} => ${r.response}`).join("\n"));
            }
            if (sub === "add") {
                const payload = args.slice(1).join(" ");
                const i = payload.indexOf("|");
                if (i === -1) return sendText(sock, from, "Usage: !autoreply add <keyword> | <response>");
                const keyword = payload.slice(0, i).trim().toLowerCase();
                const response = payload.slice(i + 1).trim();
                if (!keyword || !response) return sendText(sock, from, "Keyword or response missing.");
                doc.globalRules = doc.globalRules || [];
                doc.globalRules.push({ keyword, response });
                await doc.save();
                return sendText(sock, from, "Global autoreply rule added.");
            }
            const keyword = args.slice(1).join(" ").trim().toLowerCase();
            doc.globalRules = (doc.globalRules || []).filter(r => String(r.keyword).toLowerCase() !== keyword);
            await doc.save();
            return sendText(sock, from, `Removed keyword: ${keyword}`);
        }

        if (["addgroup", "removegroup", "listgroup", "enablegroup", "disablegroup", "override"].includes(sub)) {
            const g = await pickGroupFromSub(1);
            if (!g) return sendText(sock, from, "Invalid group index.");
            doc.groupRules = doc.groupRules || [];
            let gr = doc.groupRules.find(r => r.groupId === g.groupId);
            if (!gr) {
                gr = { groupId: g.groupId, groupName: g.name, enabled: true, rules: [], mediaRules: [], overrideGlobal: false };
                doc.groupRules.push(gr);
            }

            if (sub === "listgroup") {
                if (!gr.rules?.length) return sendText(sock, from, "No group-specific rules.");
                return sendText(sock, from, gr.rules.map((r, i) => `${i + 1}. ${r.keyword} => ${r.response}`).join("\n"));
            }

            if (sub === "addgroup") {
                const payload = args.slice(2).join(" ");
                const i = payload.indexOf("|");
                if (i === -1) return sendText(sock, from, "Usage: !autoreply addgroup <index> <keyword> | <response>");
                const keyword = payload.slice(0, i).trim().toLowerCase();
                const response = payload.slice(i + 1).trim();
                gr.rules.push({ keyword, response });
                await doc.save();
                return sendText(sock, from, `Group rule added for ${g.name}.`);
            }

            if (sub === "removegroup") {
                const keyword = args.slice(2).join(" ").trim().toLowerCase();
                gr.rules = (gr.rules || []).filter(r => String(r.keyword).toLowerCase() !== keyword);
                await doc.save();
                return sendText(sock, from, `Group rule removed for ${g.name}.`);
            }

            if (sub === "enablegroup" || sub === "disablegroup") {
                gr.enabled = sub === "enablegroup";
                await doc.save();
                return sendText(sock, from, `Group rules ${gr.enabled ? "enabled" : "disabled"} for ${g.name}.`);
            }

            if (sub === "override") {
                const mode = String(args[2] || "").toLowerCase();
                if (!["on", "off"].includes(mode)) return sendText(sock, from, "Usage: !autoreply override <index> <on|off>");
                gr.overrideGlobal = mode === "on";
                await doc.save();
                return sendText(sock, from, `Override ${mode.toUpperCase()} for ${g.name}.`);
            }
        }

        if (["allow", "disallow", "disable", "enable"].includes(sub)) {
            const g = await pickGroupFromSub(1);
            if (!g) return sendText(sock, from, "Invalid group index.");
            doc.allowedGroups = doc.allowedGroups || [];
            doc.disabledGroups = doc.disabledGroups || [];

            if (sub === "allow") {
                doc.disabledGroups = doc.disabledGroups.filter(x => x !== g.groupId);
                if (!doc.allowedGroups.includes(g.groupId)) doc.allowedGroups.push(g.groupId);
            }
            if (sub === "disallow") doc.allowedGroups = doc.allowedGroups.filter(x => x !== g.groupId);
            if (sub === "disable") {
                doc.allowedGroups = doc.allowedGroups.filter(x => x !== g.groupId);
                if (!doc.disabledGroups.includes(g.groupId)) doc.disabledGroups.push(g.groupId);
            }
            if (sub === "enable") doc.disabledGroups = doc.disabledGroups.filter(x => x !== g.groupId);

            await doc.save();
            return sendText(sock, from, "Autoreply group filter updated.");
        }

        if (sub === "clearwhitelist") {
            doc.allowedGroups = [];
            await doc.save();
            return sendText(sock, from, "Whitelist cleared.");
        }

        if (sub === "clearblacklist") {
            doc.disabledGroups = [];
            await doc.save();
            return sendText(sock, from, "Blacklist cleared.");
        }

        if (sub === "status" || sub === "listall") {
            const out = [
                `Global enabled: ${doc.globalEnabled !== false ? "YES" : "NO"}`,
                `Global rules: ${(doc.globalRules || []).length}`,
                `Group rulesets: ${(doc.groupRules || []).length}`,
                `Whitelisted groups: ${(doc.allowedGroups || []).length}`,
                `Disabled groups: ${(doc.disabledGroups || []).length}`
            ].join("\n");
            return sendText(sock, from, out);
        }

        return sendText(sock, from, "Usage: !autoreply add/remove/list/addgroup/removegroup/listgroup/allow/disallow/disable/enable/override/status/help");
    }

    if (cmd === "schedule") {
        const raw = full.slice("schedule".length).trim();
        const [left, right] = raw.split("|");
        const p = String(left || "").trim().split(/\s+/);
        if (p.length < 4 || !right?.trim()) return sendText(sock, from, "Usage: !schedule <index> HH:MM <group|dm> <once|daily|weekly> | <message>");
        const idx = parseInt(p[0], 10);
        const nr = nextRun(p[1]);
        if (Number.isNaN(idx) || !nr) return sendText(sock, from, "Invalid schedule arguments.");
        const mode = p[2];
        const repeat = p[3];
        if (!["group", "dm"].includes(mode) || !["once", "daily", "weekly"].includes(repeat)) return sendText(sock, from, "Invalid schedule mode/repeat.");
        const g = await resolveGroup(sock, sessionId, idx, false);
        if (!g) return sendText(sock, from, "Invalid group index.");
        await Schedule.create({
            userId: sessionId,
            chatId: g.groupId,
            mode,
            repeat,
            message: right.trim(),
            timeHHMM: p[1],
            nextRun: nr,
            active: true
        });
        return sendText(sock, from, "Schedule created.");
    }

    if (cmd === "listschedules") {
        const docs = await Schedule.find({ userId: sessionId, active: true }).sort({ nextRun: 1 }).lean();
        if (!docs.length) return sendText(sock, from, "No active schedules.");
        return sendText(sock, from, docs.map(d => `${d._id} | ${d.mode} ${d.repeat} @ ${d.timeHHMM}`).join("\n"));
    }

    if (cmd === "cancelschedule") {
        const id = args[0];
        if (!id) return sendText(sock, from, "Usage: !cancelschedule <id>");
        const r = await Schedule.updateOne({ _id: id, userId: sessionId }, { active: false });
        return sendText(sock, from, r.modifiedCount ? "Schedule canceled." : "Schedule not found.");
    }
}

async function runScheduledJobs({ sock, sessionId }) {
    if (runningSchedule.has(sessionId)) return;
    runningSchedule.add(sessionId);

    try {
        const jobs = await Schedule.find({
            userId: sessionId,
            active: true,
            nextRun: { $lte: new Date() }
        }).lean();

        for (const j of jobs) {
            try {
                if (j.mode === "group") {
                    await sendText(sock, j.chatId, j.message);
                } else {
                    const md = await sock.groupMetadata(j.chatId);
                    const me = getSelfJid(sock);
                    const targets = (md.participants || []).map(p => normalizeJid(p.id)).filter(x => x !== me);
                    for (const t of targets) {
                        await sendText(sock, t, j.message);
                        await addDelay(250);
                    }
                }

                if (j.repeat === "once") {
                    await Schedule.updateOne({ _id: j._id }, { active: false });
                } else {
                    const next = new Date(j.nextRun);
                    next.setDate(next.getDate() + (j.repeat === "weekly" ? 7 : 1));
                    await Schedule.updateOne({ _id: j._id }, { nextRun: next });
                }
            } catch {}
        }
    } finally {
        runningSchedule.delete(sessionId);
    }
}

module.exports = async function botEngine({ sock, msg, sessionId, isGroup, isAdmin, sender, from, upsertType = "notify", isHistorical }) {
    if (!from) return;
    const body = msgText(msg);
    const fromMe = !!msg.key?.fromMe;
    const isOwnerCommand = fromMe && body.startsWith(PREFIX);
    const historical = typeof isHistorical === "boolean" ? isHistorical : upsertType !== "notify";
    cacheMessageForRecall({ sessionId, chatId: from, msg });
    if (historical && !isOwnerCommand) return;

    const senderJid = normalizeJid(sender);

    const now = Date.now();
    const marks = (spam.get(senderJid) || []).filter(t => now - t < SPAM_WINDOW);
    marks.push(now);
    spam.set(senderJid, marks);
    if (!msg.key.fromMe && marks.length > SPAM_LIMIT) {
        await sendText(sock, from, "Slow down. Spam detected.");
        return;
    }

    if (isGroup && body) {
        await GroupMembers.findOneAndUpdate(
            { sessionId, groupId: from },
            { $addToSet: { members: senderJid }, $set: { updatedAt: new Date() } },
            { upsert: true }
        ).catch(() => {});
    }

    if (isGroup && body) {
        const gs = await GroupSettings.findOne({ groupId: from }).catch(() => null);
        if (gs?.antiLink && /https?:\/\/\S+/i.test(body) && !isAdmin) {
            try { await sock.groupParticipantsUpdate(from, [senderJid], "remove"); } catch {}
            await sendText(sock, from, "Links are not allowed.");
            return;
        }
    }

    await processAutoReply({ sock, from, sessionId, isGroup, body, fromMe: msg.key.fromMe });
    const consumedRecall = await processRecallKeywords({
        sock,
        sessionId,
        from,
        body,
        fromMe: msg.key.fromMe,
        currentMessageId: msg.key?.id
    });
    if (consumedRecall) return;

    if (!body.startsWith(PREFIX)) return;
    await handleCommand({ sock, msg, sessionId, from, sender: senderJid, isGroup, isAdmin, body });
};

module.exports.runScheduledJobs = runScheduledJobs;
