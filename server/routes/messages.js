const express = require("express");
const prisma = require("../../packages/database/client");
const { sendQueue } = require("../../packages/queue/queues");
const checkDailyLimit = require("../../packages/queue/usage/checkLimit");

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const { sessionId, to, content } = req.body;
    const accountId = req.accountId;

    if (!accountId) {
      return res.status(401).json({ error: "Unauthorized account" });
    }

    if (!sessionId || !to) {
      return res.status(400).json({ error: "sessionId and to are required" });
    }

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { accountId: true, isActive: true }
    });

    if (!session || session.accountId !== accountId) {
      return res.status(403).json({ error: "Session access denied" });
    }

    if (!session.isActive) {
      return res.status(400).json({ error: "Session is not active" });
    }

    await checkDailyLimit(accountId);

    const message = await prisma.message.create({
      data: {
        to,
        content,
        accountId,
        sessionId
      }
    });

    await sendQueue.add("send", {
      messageId: message.id,
      sessionId,
      accountId
    });

    res.json({
      id: message.id,
      status: "QUEUED"
    });

  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;