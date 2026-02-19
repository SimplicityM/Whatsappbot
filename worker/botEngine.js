const config = require("./config");
const GroupSettings = require("./models/GroupSettings");
const GroupMembers = require("./models/GroupMembers");
const SavedGroupList = require("./models/SavedGroupList");
const ActiveGroup = require("./models/ActiveGroup");
const AutoReply = require("./models/AutoReply");
const TagUsage = require("./models/TagUsage");
const Schedule = require("./models/Schedule");

const PREFIX = config?.client?.COMMAND_PREFIX || "!";
const SPAM_WINDOW = 10000;
const SPAM_LIMIT = 5;
const spam = new Map();
const runningSchedule = new Set();

function txt(msg) {
    const m = msg.message || {};
    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        ""
    ).trim();
}

function jid(x) {
    if (!x) return "";
    const [a, b] = x.split("@");
    return `${a.split(":")[0]}@${b}`;
}

async function send(sock, to, text, extra = {}) {
    return sock.sendMessage(to, { text, ...extra });
}

async function allGroups(sock, adminOnly) {
    const raw = await sock.groupFetchAllParticipating();
    const me = jid(sock.user?.id);
    const rows = [];
    for (const [groupId, g] of Object.entries(raw || {})) {
        const p = g.participants || [];
        if (adminOnly) {
            const mine = p.find(x => jid(x.id) === me);
            if (!mine?.admin) continue;
        }
        rows.push({ name: g.subject || "Unnamed Group", groupId });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
}

async function resolveGroup(sock, sessionId, idx, all = false) {
    const key = all ? `${sessionId}_all` : sessionId;
    let c = await SavedGroupList.findOne({ sessionId: key }).lean().catch(() => null);
    let groups = c?.groups || [];
    if (!groups.length) {
        groups = await allGroups(sock, !all);
        await SavedGroupList.findOneAndUpdate({ sessionId: key }, { groups, updatedAt: new Date() }, { upsert: true });
    }
    if (idx) return groups[idx - 1] || null;
    const a = await ActiveGroup.findOne({ sessionId }).lean().catch(() => null);
    return a?.groupId ? groups.find(g => g.groupId === a.groupId) : null;
}

async function members(sock, sessionId, groupId) {
    const c = await GroupMembers.findOne({ sessionId, groupId }).lean().catch(() => null);
    if (c?.members?.length) return c.members;
    const m = await sock.groupMetadata(groupId);
    const rows = (m.participants || []).map(p => jid(p.id));
    await GroupMembers.findOneAndUpdate({ sessionId, groupId }, { members: rows, updatedAt: new Date() }, { upsert: true });
    return rows;
}

async function autoReply(sock, from, sessionId, body, isGroup, fromMe) {
    if (!body || fromMe) return;
    const d = await AutoReply.findOne({ sessionId }).lean().catch(() => null);
    if (!d || d.globalEnabled === false) return;
    if (isGroup && d.disabledGroups?.includes(from)) return;
    if (isGroup && d.allowedGroups?.length && !d.allowedGroups.includes(from)) return;
    const rules = d.globalRules || d.rules || [];
    const t = body.toLowerCase();
    for (const r of rules) {
        const k = String(r.keyword || "").toLowerCase();
        if (!k || r.active === false) continue;
        const ok =
            (r.matchType === "exact" && t === k) ||
            (r.matchType === "starts" && t.startsWith(k)) ||
            (r.matchType === "ends" && t.endsWith(k)) ||
            ((r.matchType === "contains" || !r.matchType) && t.includes(k));
        if (ok) {
            await send(sock, from, r.response);
            return;
        }
    }
}

function nextRun(hhmm) {
    const [h, m] = String(hhmm).split(":").map(Number);
    if ([h, m].some(Number.isNaN) || h < 0 || h > 23 || m < 0 || m > 59) return null;
    const d = new Date();
    d.setHours(h, m, 0, 0);
    if (d <= new Date()) d.setDate(d.getDate() + 1);
    return d;
}

async function handleCmd({ sock, msg, sessionId, from, sender, isGroup, isAdmin, body }) {
    const [cmd, ...args] = body.slice(PREFIX.length).trim().split(/\s+/);
    const c = String(cmd || "").toLowerCase();
    const fromMe = !!msg.key.fromMe || jid(sender) === jid(sock.user?.id);
    if (!fromMe && ["list", "listall", "use", "unset", "status", "members", "admins", "tag", "tagexcept", "autoreply", "schedule", "listschedules", "cancelschedule"].includes(c)) return;

    if (c === "ping") return send(sock, from, "Pong!");
    if (c === "help" || c === "menu") return send(sock, from, "*Commands*\n!ping !list !listall !use !tag !tagexcept !autoreply !schedule");

    if (c === "antilink" || c === "antidelete" || c === "welcome") {
        if (!isGroup || !isAdmin) return send(sock, from, "Group admin only.");
        const mode = (args[0] || "").toLowerCase();
        if (!["on", "off"].includes(mode)) return send(sock, from, `Usage: !${c} on/off`);
        const g = (await GroupSettings.findOne({ groupId: from })) || (await GroupSettings.create({ groupId: from }));
        if (c === "antilink") g.antiLink = mode === "on";
        if (c === "antidelete") g.antiDelete = mode === "on";
        if (c === "welcome") g.welcome = mode === "on";
        await g.save();
        return send(sock, from, `${c} ${mode.toUpperCase()}`);
    }

    if (c === "list") {
        const g = await allGroups(sock, true);
        await SavedGroupList.findOneAndUpdate({ sessionId }, { groups: g, updatedAt: new Date() }, { upsert: true });
        if (!g.length) return send(sock, from, "No admin groups.");
        return send(sock, from, g.map((x, i) => `${i + 1}. ${x.name}`).join("\n"));
    }

    if (c === "listall") {
        const g = await allGroups(sock, false);
        await SavedGroupList.findOneAndUpdate({ sessionId: `${sessionId}_all` }, { groups: g, updatedAt: new Date() }, { upsert: true });
        if (!g.length) return send(sock, from, "No groups found.");
        return send(sock, from, g.map((x, i) => `${i + 1}. ${x.name}`).join("\n"));
    }

    if (c === "use") {
        const idx = parseInt(args[0], 10);
        if (Number.isNaN(idx)) return send(sock, from, "Usage: !use <index>");
        const g = await resolveGroup(sock, sessionId, idx, false);
        if (!g) return send(sock, from, "Invalid index.");
        await ActiveGroup.findOneAndUpdate({ sessionId }, { sessionId, activeIndex: idx, groupId: g.groupId, groupName: g.name, updatedAt: new Date() }, { upsert: true });
        return send(sock, from, `Active group: ${g.name}`);
    }

    if (c === "unset") {
        await ActiveGroup.deleteOne({ sessionId });
        return send(sock, from, "Active group cleared.");
    }

    if (c === "status") {
        const a = await SavedGroupList.findOne({ sessionId }).lean().catch(() => null);
        const b = await SavedGroupList.findOne({ sessionId: `${sessionId}_all` }).lean().catch(() => null);
        return send(sock, from, `Session: ${sessionId}\nAdmin cache: ${a?.groups?.length || 0}\nAll cache: ${b?.groups?.length || 0}`);
    }

    if (c === "members" || c === "admins") {
        const idx = args[0] ? parseInt(args[0], 10) : null;
        const g = await resolveGroup(sock, sessionId, idx, c === "admins");
        if (!g) return send(sock, from, "No target group.");
        const md = await sock.groupMetadata(g.groupId);
        const rows = c === "admins" ? (md.participants || []).filter(p => !!p.admin).map(p => jid(p.id)) : (md.participants || []).map(p => jid(p.id));
        if (!rows.length) return send(sock, from, "No entries.");
        return send(sock, from, rows.map((x, i) => `${i + 1}. ${x.split("@")[0]}`).join("\n"));
    }

    if (c === "tag") {
        const idx = args[0] && /^\d+$/.test(args[0]) ? parseInt(args[0], 10) : null;
        const g = await resolveGroup(sock, sessionId, idx, false);
        if (!g) return send(sock, from, "No target group. Use !list / !use.");
        const list = await members(sock, sessionId, g.groupId);
        const me = jid(sock.user?.id);
        const clean = list.filter(x => x !== me);
        if (!clean.length) return send(sock, from, "No members to tag.");
        const u = await TagUsage.findOneAndUpdate({ sessionId, groupId: g.groupId }, { $setOnInsert: { lastPosition: 0 } }, { upsert: true, new: true });
        let p = u.lastPosition || 0;
        if (p >= clean.length) p = 0;
        const batch = clean.slice(p, p + 100);
        u.lastPosition = p + 100 >= clean.length ? 0 : p + 100;
        u.lastTaggedAt = new Date();
        await u.save();
        const msgText = args.slice(idx ? 1 : 0).join(" ").trim() || "*Attention everyone*";
        await send(sock, g.groupId, `${msgText}\n\n${batch.map(x => `@${x.split("@")[0]}`).join(" ")}`, { mentions: batch });
        return send(sock, from, `Tagged ${batch.length} in ${g.name}`);
    }

    if (c === "tagexcept") {
        const raw = body.slice(`${PREFIX}tagexcept`.length).trim();
        const [left, right] = raw.split("|");
        const p = String(left || "").trim().split(/\s+/);
        const idx = parseInt(p[0], 10);
        if (Number.isNaN(idx)) return send(sock, from, "Usage: !tagexcept <index> <targets> | <message>");
        const g = await resolveGroup(sock, sessionId, idx, false);
        if (!g) return send(sock, from, "Invalid group index.");
        const list = await members(sock, sessionId, g.groupId);
        const ex = new Set();
        for (const t of p.slice(1)) {
            if (/^\d+(,\d+)*$/.test(t)) t.split(",").map(x => parseInt(x, 10)).forEach(i => list[i - 1] && ex.add(list[i - 1]));
            else {
                const d = t.replace(/[^0-9]/g, "");
                if (d.length >= 7) ex.add(`${d}@s.whatsapp.net`);
            }
        }
        const me = jid(sock.user?.id);
        const targets = list.map(jid).filter(x => x !== me && !ex.has(x));
        if (!targets.length) return send(sock, from, "No members left after exclusions.");
        const m = (right || "*Attention filtered*").trim();
        await send(sock, g.groupId, `${m}\n\n${targets.map(x => `@${x.split("@")[0]}`).join(" ")}`, { mentions: targets });
        return send(sock, from, "Tag-except completed.");
    }

    if (c === "autoreply") {
        const sub = (args[0] || "").toLowerCase();
        if (sub === "list") {
            const d = await AutoReply.findOne({ sessionId }).lean().catch(() => null);
            const r = d?.globalRules || d?.rules || [];
            return send(sock, from, r.length ? r.map((x, i) => `${i + 1}. ${x.keyword} => ${x.response}`).join("\n") : "No auto-reply rules.");
        }
        if (sub === "add") {
            const v = args.slice(1).join(" ");
            const i = v.indexOf("|");
            if (i === -1) return send(sock, from, "Usage: !autoreply add <keyword> | <response>");
            const k = v.slice(0, i).trim().toLowerCase();
            const r = v.slice(i + 1).trim();
            if (!k || !r) return send(sock, from, "Keyword/response missing.");
            await AutoReply.findOneAndUpdate({ sessionId }, { $setOnInsert: { sessionId, globalEnabled: true }, $push: { globalRules: { keyword: k, response: r } } }, { upsert: true });
            return send(sock, from, "Auto-reply added.");
        }
        if (sub === "remove") {
            const k = args.slice(1).join(" ").trim().toLowerCase();
            if (!k) return send(sock, from, "Usage: !autoreply remove <keyword>");
            await AutoReply.updateOne({ sessionId }, { $pull: { globalRules: { keyword: k } } });
            return send(sock, from, "Auto-reply removed.");
        }
        return send(sock, from, "Usage: !autoreply add/remove/list");
    }

    if (c === "schedule") {
        const raw = body.slice(`${PREFIX}schedule`.length).trim();
        const [left, right] = raw.split("|");
        const p = String(left || "").trim().split(/\s+/);
        if (p.length < 4 || !right?.trim()) return send(sock, from, "Usage: !schedule <index> HH:MM <group|dm> <once|daily|weekly> | <message>");
        const idx = parseInt(p[0], 10);
        const nr = nextRun(p[1]);
        if (Number.isNaN(idx) || !nr) return send(sock, from, "Invalid schedule arguments.");
        const mode = p[2];
        const repeat = p[3];
        if (!["group", "dm"].includes(mode) || !["once", "daily", "weekly"].includes(repeat)) return send(sock, from, "Invalid schedule mode/repeat.");
        const g = await resolveGroup(sock, sessionId, idx, false);
        if (!g) return send(sock, from, "Invalid group index.");
        await Schedule.create({ userId: sessionId, chatId: g.groupId, mode, repeat, message: right.trim(), timeHHMM: p[1], nextRun: nr, active: true });
        return send(sock, from, "Schedule created.");
    }

    if (c === "listschedules") {
        const docs = await Schedule.find({ userId: sessionId, active: true }).sort({ nextRun: 1 }).lean();
        return send(sock, from, docs.length ? docs.map(d => `${d._id} | ${d.mode} ${d.repeat} ${d.timeHHMM}`).join("\n") : "No active schedules.");
    }

    if (c === "cancelschedule") {
        const id = args[0];
        if (!id) return send(sock, from, "Usage: !cancelschedule <id>");
        const r = await Schedule.updateOne({ _id: id, userId: sessionId }, { active: false });
        return send(sock, from, r.modifiedCount ? "Schedule canceled." : "Schedule not found.");
    }
}

async function runScheduledJobs({ sock, sessionId }) {
    if (runningSchedule.has(sessionId)) return;
    runningSchedule.add(sessionId);
    try {
        const jobs = await Schedule.find({ userId: sessionId, active: true, nextRun: { $lte: new Date() } }).lean();
        for (const j of jobs) {
            try {
                if (j.mode === "group") await send(sock, j.chatId, j.message);
                else {
                    const md = await sock.groupMetadata(j.chatId);
                    const me = jid(sock.user?.id);
                    const to = (md.participants || []).map(p => jid(p.id)).filter(x => x !== me);
                    for (const t of to) await send(sock, t, j.message);
                }
                if (j.repeat === "once") await Schedule.updateOne({ _id: j._id }, { active: false });
                else {
                    const d = new Date(j.nextRun);
                    d.setDate(d.getDate() + (j.repeat === "weekly" ? 7 : 1));
                    await Schedule.updateOne({ _id: j._id }, { nextRun: d });
                }
            } catch {}
        }
    } finally {
        runningSchedule.delete(sessionId);
    }
}

module.exports = async function botEngine({ sock, msg, sessionId, isGroup, isAdmin, sender, from }) {
    const body = txt(msg);
    if (!from) return;
    const now = Date.now();
    const a = (spam.get(sender) || []).filter(t => now - t < SPAM_WINDOW);
    a.push(now);
    spam.set(sender, a);
    if (!msg.key.fromMe && a.length > SPAM_LIMIT) return send(sock, from, "Slow down. Spam detected.");

    if (isGroup && body) {
        const gs = await GroupSettings.findOne({ groupId: from }).catch(() => null);
        if (gs?.antiLink && /https?:\/\/\S+/i.test(body) && !isAdmin) {
            try { await sock.groupParticipantsUpdate(from, [jid(sender)], "remove"); } catch {}
            return send(sock, from, "Links are not allowed.");
        }
    }

    await autoReply(sock, from, sessionId, body, isGroup, msg.key.fromMe);
    if (!body.startsWith(PREFIX)) return;
    await handleCmd({ sock, msg, sessionId, from, sender, isGroup, isAdmin, body });
};

module.exports.runScheduledJobs = runScheduledJobs;
