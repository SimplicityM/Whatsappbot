const { createBaileysSession, resumeUserSession, sessions } = require("./bailey");
const Session = require("./models/Session");

async function createBotSession(userId, sessionId, io) {
    return createBaileysSession(sessionId, io);
}

async function restoreUserSessionAfterPayment(userId, io = null) {
    const session = await Session.findOne({ userId }).sort({ updatedAt: -1, createdAt: -1 }).lean();
    if (!session?.sessionId) return null;
    return resumeUserSession(userId, session.sessionId, io);
}

module.exports = {
    createBaileysSession,
    resumeUserSession,
    sessions,
    createBotSession,
    restoreUserSessionAfterPayment
};
