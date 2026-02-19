const GroupSettings = require("./models/GroupSettings");

const OWNER_NUMBER = process.env.OWNER_NUMBER; // 234xxxxxxxxxx@s.whatsapp.net

const userSpamMap = new Map();
const SPAM_LIMIT = 5;
const SPAM_WINDOW = 10000; // 10 sec

module.exports = async function botEngine({
    sock,
    msg,
    sessionId,
    isGroup,
    isAdmin,
    sender,
    from
}) {
    try {

        const remoteJid = from;
        if (msg.key.fromMe) return;

        const messageText =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            "";

        /* =====================================================
           SPAM PROTECTION
        ===================================================== */

        const now = Date.now();
        if (!userSpamMap.has(sender)) {
            userSpamMap.set(sender, []);
        }

        const timestamps = userSpamMap.get(sender)
            .filter(t => now - t < SPAM_WINDOW);

        timestamps.push(now);
        userSpamMap.set(sender, timestamps);

        if (timestamps.length > SPAM_LIMIT) {
            return sock.sendMessage(remoteJid, {
                text: "⚠️ Slow down. Spam detected."
            });
        }

        /* =====================================================
           GROUP SETTINGS
        ===================================================== */

        let groupSettings = null;

        if (isGroup) {
            groupSettings =
                await GroupSettings.findOne({ groupId: remoteJid }) ||
                await GroupSettings.create({ groupId: remoteJid });
        }

        /* =====================================================
           ANTI-LINK AUTO MODERATION
        ===================================================== */

        if (
            isGroup &&
            groupSettings?.antiLink &&
            messageText.match(/https?:\/\/\S+/gi) &&
            !isAdmin
        ) {
            await sock.groupParticipantsUpdate(remoteJid, [sender], "remove");

            return sock.sendMessage(remoteJid, {
                text: "🚫 Links are not allowed."
            });
        }

        /* =====================================================
           COMMAND HANDLER
        ===================================================== */

        const prefix = "!";
        if (!messageText.startsWith(prefix)) return;

        const args = messageText
            .slice(prefix.length)
            .trim()
            .split(" ");

        const command = args.shift()?.toLowerCase();

        /* ===== OWNER COMMAND ===== */

        if (command === "sudo") {
            if (sender !== OWNER_NUMBER) {
                return sock.sendMessage(remoteJid, {
                    text: "❌ Owner only."
                });
            }

            return sock.sendMessage(remoteJid, {
                text: "👑 Owner command executed."
            });
        }

        /* ===== BASIC ===== */

        if (command === "ping") {
            return sock.sendMessage(remoteJid, { text: "🏓 Pong!" });
        }

        if (command === "menu") {
            return sock.sendMessage(remoteJid, {
                text:
`📋 *TagThemAll Commands*

!ping
!menu
!tagall (admin)
!antilink on/off (admin)
!antidelete on/off (admin)
!welcome on/off (admin)`
            });
        }

        /* ===== ADMIN CHECK ===== */

        const adminCommands = [
            "tagall",
            "antilink",
            "antidelete",
            "welcome"
        ];

        if (adminCommands.includes(command)) {
            if (!isGroup)
                return sock.sendMessage(remoteJid, {
                    text: "❌ Group only command."
                });

            if (!isAdmin)
                return sock.sendMessage(remoteJid, {
                    text: "❌ Admins only."
                });
        }

        /* ===== TAG ALL ===== */

        if (command === "tagall") {
            const metadata = await sock.groupMetadata(remoteJid);
            const mentions = metadata.participants.map(p => p.id);

            let text = "📢 *Tagging Everyone*\n\n";
            mentions.forEach(id => {
                text += `@${id.split("@")[0]}\n`;
            });

            return sock.sendMessage(remoteJid, {
                text,
                mentions
            });
        }

        /* ===== ANTI-LINK TOGGLE ===== */

        if (command === "antilink") {
            const option = args[0];

            if (!["on", "off"].includes(option)) {
                return sock.sendMessage(remoteJid, {
                    text: "Usage: !antilink on/off"
                });
            }

            groupSettings.antiLink = option === "on";
            await groupSettings.save();

            return sock.sendMessage(remoteJid, {
                text: `🔗 Anti-link ${option.toUpperCase()}`
            });
        }

        /* ===== ANTI-DELETE TOGGLE ===== */

        if (command === "antidelete") {
            const option = args[0];

            if (!["on", "off"].includes(option)) {
                return sock.sendMessage(remoteJid, {
                    text: "Usage: !antidelete on/off"
                });
            }

            groupSettings.antiDelete = option === "on";
            await groupSettings.save();

            return sock.sendMessage(remoteJid, {
                text: `🛡 Anti-delete ${option.toUpperCase()}`
            });
        }

        /* ===== WELCOME TOGGLE ===== */

        if (command === "welcome") {
            const option = args[0];

            if (!["on", "off"].includes(option)) {
                return sock.sendMessage(remoteJid, {
                    text: "Usage: !welcome on/off"
                });
            }

            groupSettings.welcome = option === "on";
            await groupSettings.save();

            return sock.sendMessage(remoteJid, {
                text: `👋 Welcome messages ${option.toUpperCase()}`
            });
        }

        /* ===== UNKNOWN ===== */

        return sock.sendMessage(remoteJid, {
            text: "❌ Unknown command"
        });

    } catch (err) {
        console.error("BotEngine error:", err);
    }
};