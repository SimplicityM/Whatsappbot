const express = require("express");
const prisma = require("../packages/database/client");
const { sendQueue } = require("../packages/queue/queues");
const checkDailyLimit = require("../packages/usage/checkLimit");

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const { sessionId, to, content } = req.body;
    const accountId = req.accountId;

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