const Session = require("../models/Session");
const User = require("../models/User");

module.exports.createWhatsAppSession = async function (userId, sessionId, workerSocket, options = {}) {
  let sessionCreated = false;
  let session = null;

  try {
    const user = await User.findById(userId);
    if (!user) throw new Error("User not found");

    if (!workerSocket || !workerSocket.connected) {
      throw new Error("Worker service not available");
    }

    session = new Session({
      userId,
      sessionId,
      status: "waiting_qr",
      subscriptionAtTime: user.subscription,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await session.save();
    sessionCreated = true;

    const ack = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Worker timeout")), 20000);

      workerSocket.emit("worker:create_session", {
        userId,
        sessionId,
        phoneNumber: options.phoneNumber || null,
        usePairingCode: !!options.usePairingCode
      }, (err, result) => {
        clearTimeout(timeout);
        if (err) return reject(new Error(String(err)));
        resolve(result);
      });
    });

    return sessionId;
  } catch (error) {
    if (sessionCreated) {
      await Session.findOneAndUpdate(
        { sessionId },
        { status: "failed", errorMessage: error.message, updatedAt: new Date() }
      );
    }

    throw error;
  }
};
