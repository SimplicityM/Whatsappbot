module.exports = async function botEngine({ sock, msg, sessionId }) {

    const remoteJid = msg.key.remoteJid;
    const fromMe = msg.key.fromMe;

    if (fromMe) return;

    const messageText =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        "";

    const prefix = "!";

    // ================= BASIC COMMAND HANDLER =================

    if (messageText.startsWith(prefix)) {

        const command = messageText.slice(prefix.length).trim().toLowerCase();

        switch (command) {

            case "ping":
                await sock.sendMessage(remoteJid, {
                    text: "🏓 Pong!"
                });
                break;

            case "menu":
                await sock.sendMessage(remoteJid, {
                    text: "📋 Available commands:\n!ping\n!menu"
                });
                break;

            default:
                await sock.sendMessage(remoteJid, {
                    text: "❌ Unknown command"
                });
        }
    }

};